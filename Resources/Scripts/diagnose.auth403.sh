#!/usr/bin/env bash
#
# diagnose.auth403.sh
#
# 诊断 "认证失败：服务器返回 HTTP 403 且响应体为空"
# (AssppWeb: errors.auth.emptyBody / native Asspp: "response body is empty (code: 403)")
#
# 这个脚本不会使用你的 Apple ID。所有请求都使用明显无效的假凭据，
# 目的只是观察「请求能走到哪一步」，而不是真的登录。
#
# 用法:
#   ./diagnose.auth403.sh                      # 只测 Apple 端点
#   ./diagnose.auth403.sh https://<user>.hf.space   # 同时体检你的部署
#
set -uo pipefail

UA='Configurator/2.17 (Macintosh; OS X 15.2; 24C5089c) AppleWebKit/0620.1.16.11.6'
GUID='000000000000'
AUTH_URL="https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?guid=${GUID}"
DEPLOY="${1:-}"

hr() { printf '\n──── %s ────\n' "$1"; }
ok()   { printf '  [ OK ]  %s\n' "$1"; }
bad()  { printf '  [FAIL]  %s\n' "$1"; }
info() { printf '  [ .. ]  %s\n' "$1"; }

hr "1/4  你的部署（AssppWeb 服务端）"
if [[ -z "$DEPLOY" ]]; then
  info "未提供部署地址，跳过。用法: $0 https://<user>.hf.space"
else
  DEPLOY="${DEPLOY%/}"

  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$DEPLOY/api/settings" 2>/dev/null)
  [[ -n "$code" ]] || code=000
  if [[ "$code" == "200" ]]; then
    ok "GET /api/settings -> 200，服务端活着"
    curl -sS --max-time 20 "$DEPLOY/api/settings" 2>/dev/null \
      | sed 's/,/,\n          /g' | sed 's/^/          /' | head -14
    echo
  else
    bad "GET /api/settings -> $code，服务端没起来或路径不对（先解决这个，后面不用看）"
  fi

  code=$(curl -sS -o /tmp/.bag.$$ -w '%{http_code}' --max-time 25 "$DEPLOY/api/bag?guid=$GUID" 2>/dev/null)
  [[ -n "$code" ]] || code=000
  if [[ "$code" == "200" ]] && grep -q '<plist' "/tmp/.bag.$$" 2>/dev/null; then
    ok "GET /api/bag -> 200 且返回 plist：服务器能出网访问 Apple"
    if grep -q 'sign-sap' "/tmp/.bag.$$"; then
      ok "bag 里出现 sign-sap* 键 —— Apple 已在配置里声明这些接口必须带 SAP 签名"
      grep -o 'sign-sap[a-z-]*' "/tmp/.bag.$$" | sort -u | sed 's/^/          /'
    fi
  else
    bad "GET /api/bag -> $code：服务器出网被限制（Hugging Face / 公司网络常见）"
  fi
  rm -f "/tmp/.bag.$$"

  # curl 对 101 会返回非 0 退出码，所以不能把 || 和 -w 混用（会得到 "101000"）
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    "$DEPLOY/wisp/" 2>/dev/null)
  [[ -n "$code" ]] || code=000
  if [[ "$code" == "101" ]]; then
    ok "GET /wisp/ -> 101 Switching Protocols，WebSocket 中继可用"
  else
    bad "GET /wisp/ -> $code（期望 101）。WebSocket 被挡会导致连不上 Apple，报的错却不是 403"
  fi
fi

hr "2/4  实时 bag：Apple 现在指向哪个登录端点"
if curl -sS --max-time 25 -A "$UA" "https://init.itunes.apple.com/bag.xml?guid=$GUID" -o /tmp/.bag2.$$ 2>/dev/null; then
  grep -o 'authenticateAccount[^<]*' /tmp/.bag2.$$ | head -2 | sed 's/^/          /'
  grep -o 'sign-sap[a-z-]*' /tmp/.bag2.$$ | sort -u | sed 's/^/          /' || true
  ok "bag 可取（说明 Apple 服务本身在线，不是全局宕机）"
else
  bad "取不到 bag（本机出网问题，不是 Apple 的问题）"
fi
rm -f /tmp/.bag2.$$

hr "3/4  用假凭据直连 Apple 登录端点（关键一步）"
cat > /tmp/.body.$$ <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>appleId</key><string>diagnostic.probe@invalid.example</string>
  <key>attempt</key><string>4</string>
  <key>guid</key><string>000000000000</string>
  <key>password</key><string>not-a-real-password</string>
  <key>rmp</key><string>0</string>
  <key>why</key><string>signIn</string>
</dict>
</plist>
PLIST

echo "  POST $AUTH_URL"
: > /tmp/.resp.$$
: > /tmp/.hdr.$$
curl -sS -o /tmp/.resp.$$ -D /tmp/.hdr.$$ --max-time 30 \
  -X POST --http1.1 -A "$UA" \
  -H 'Content-Type: application/x-apple-plist' \
  --data-binary @/tmp/.body.$$ "$AUTH_URL" 2>/tmp/.err.$$
curl_rc=$?

status=$(head -1 /tmp/.hdr.$$ 2>/dev/null | tr -d '\r')
len=$(wc -c < /tmp/.resp.$$ 2>/dev/null | tr -d ' ')

if [[ $curl_rc -ne 0 || -z "$status" ]]; then
  printf '  curl 退出码: %s\n' "$curl_rc"
  sed 's/^/  curl 报错: /' /tmp/.err.$$ 2>/dev/null | head -3
  echo
  echo "  >>> 这台机器根本没连上 Apple（本机出网/DNS/代理问题），"
  echo "      所以这一步在你这里得不出结论。换一台能访问 Apple 的机器再跑，"
  echo "      或者直接在部署所在的机器上跑。"
  rm -f /tmp/.body.$$ /tmp/.resp.$$ /tmp/.hdr.$$ /tmp/.err.$$
else
  printf '  响应首行: %s\n' "$status"
  printf '  响应体字节数: %s\n' "${len:-0}"
  grep -i -E '^(server|apple-timing-app|content-length):' /tmp/.hdr.$$ 2>/dev/null | sed 's/^/  响应头: /' | tr -d '\r'

  if [[ "$status" == *"403"* && "${len:-0}" -le 1 ]]; then
    echo
    echo "  >>> 复现成功：HTTP 403 + 空响应体。"
    echo "  >>> 这条请求是从「你这台机器」直接发给 Apple 的，没有经过抱抱脸、"
    echo "      没有经过你的部署、也没有用你的 Apple ID。"
    echo "  >>> 结论：问题不在你的部署，也不在 Asspp/AssppWeb 的配置，"
    echo "      而是 Apple 要求登录请求带 SAP 签名（X-Apple-ActionSignature），"
    echo "      当前所有版本的 AssppWeb / Asspp 都没实现，所以在边缘就被拒。"
  elif [[ "$status" == *"200"* ]]; then
    echo
    echo "  >>> 返回 200 且响应体 ${len} 字节 —— 说明 Apple 现在接受了无签名请求，"
    echo "      那你的 403 就要往别处查（部署、网络、账号风控）。把上面几行贴出来继续看。"
  else
    echo
    echo "  >>> 既不是 403+空体也不是 200。把上面的响应首行/响应头贴出来，这是另一种情况。"
  fi
  rm -f /tmp/.body.$$ /tmp/.resp.$$ /tmp/.hdr.$$ /tmp/.err.$$
fi

hr "4/4  结论"
cat <<'EOF'
  - 如果第 3 步复现出 403 + 空体：换部署平台（Vercel/Cloudflare/自己的 VPS）
    都不会好，因为请求最终都是从某个数据中心 IP 发给 Apple 的同一条无签名请求。
  - 修复只有一条路：给登录请求加上 SAP 签名。上游进度：
      * ipatool v2.4.0 已实现并合入 (majd/ipatool PR #525)
      * AssppWeb 侧的浏览器端实现是 draft PR，尚未合并 (Lakr233/AssppWeb PR #88)
      * 原生 Asspp / ApplePackage 尚无实现
  - 在修好之前不要反复重试登录：这不是密码错误，反复试有触发账号风控的风险。
EOF
echo
