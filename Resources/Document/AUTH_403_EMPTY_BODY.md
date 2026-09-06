# 「认证失败：服务器返回 HTTP 403 且响应体为空」诊断报告

> 结论先说：**不是抱抱脸（Hugging Face）部署的问题，也不是你配置错了。**
> 是 Apple 在 2026-08 改了登录协议：`authenticate` 这类接口现在必须带 SAP 签名
> （`X-Apple-ActionSignature` 请求头）。AssppWeb / 原生 Asspp 目前都还没实现这个签名，
> 所以请求在 Apple 边缘就被拒，返回 `403` + 空响应体（`Content-Length: 0`）。
> **换任何部署平台都不会好。**

---

## 1. 这条报错是谁抛出来的（已核对源码）

报错文案逐字来自 **AssppWeb**（网页版，也是唯一能部署到抱抱脸上的版本）：

| 位置 | 内容 |
| --- | --- |
| `frontend/src/locales/zh-CN.json` → `errors.auth.emptyBody` | `"认证失败：服务器返回 HTTP {{status}} 且响应体为空"` |
| `frontend/src/apple/authenticate.ts` | `if (!response.body.trim()) throw new Error(i18n.t("errors.auth.emptyBody", { status: response.status }))` |

> 注：你现在看的这个仓库 `renzhidao/Asspp` 是**原生 iOS/macOS App**（Swift/Xcode），
> 它没法部署到抱抱脸。你部署的是 `Lakr233/AssppWeb`。两者共用同一套 App Store 私有协议，
> 所以**原生 App 现在登录也是坏的**，只是报错文案不同（见 §3）。

## 2. 这个 403 是 Apple 返回的，不是你服务器返回的（已核对源码）

`frontend/src/apple/request.ts` 里的 `appleRequest()` 走的是
`libcurl.js (WASM) + Mbed TLS 1.3`，通过 Wisp 隧道**直连 Apple**，
请求根本不经过 AssppWeb 后端的 Express 路由。它组装的请求头只有：

```
User-Agent: Configurator/2.17 (Macintosh; OS X 15.2; 24C5089c) AppleWebKit/0620.1.16.11.6
Content-Type: application/x-apple-plist
Cookie: <若有>
```

**没有任何 SAP 签名头。** 所以：

- 这个 403 不可能由你的 Space 产生（Space 只在做 TCP 盲中继）；
- 能拿到「HTTP 状态码 + 空响应体」这个组合，恰恰说明
  **WebSocket 通了、Wisp 隧道通了、TLS 握手成功了、请求到达了 Apple**，
  是 Apple 应用层把它拒了。换句话说：你的部署链路是好的。

## 3. 原生 Asspp 同样受影响（已核对）

- 本仓库 `Asspp.xcworkspace/xcshareddata/swiftpm/Package.resolved` 锁定
  `ApplePackage 1.2.7`（revision `28710fe`）。
- `ApplePackage/Sources/ApplePackage/Commands/Authenticate.swift` 的 `makeRequest()`
  只发 `User-Agent` + `Content-Type` + `Cookie`，同样没有 SAP 签名。
- 它对空响应体的处理是：`return .failure("response body is empty (code: \(response.status.code))")`，
  最终由本仓库 `Asspp/Interface/Account/AddAccountView.swift` 原样显示在表单底部。
  所以原生 App 上你看到的会是 **`response body is empty (code: 403)`** —— 同一个病根。

## 4. 时间线（均为上游仓库可查记录）

| 时间 | 事件 |
| --- | --- |
| 2026-08-20 | `majd/ipatool#522`「HTTP 403 on both native and legacy CommerceKit authentication endpoints」 |
| 2026-08-21 | `majd/ipatool#523`「request failed: unexpected response from Apple (HTTP 403): empty or non-plist body」 |
| 2026-08-28 | ipatool **v2.4.0** 发布，`PR #525`「Replace App Store authentication with SAP-signed requests」已合并（+6896 行 / 74 文件） |
| 2026-09-01 | `Lakr233/AssppWeb#88`（draft）「Sign-in is returning 403: Apple now requires a SAP signature on authenticate」 |
| 2026-09-03 | AssppWeb `main` 最新提交 `3bc9515`；仓库文件树里**没有** `frontend/src/apple/sap/`，即签名实现尚未进主干 |
| 2026-07-15 | 原生 Asspp `main` 最新提交 `caed708`（= 本仓库的基线），此后无认证相关改动 |

`AssppWeb#88` 里的实测（作者从**住宅 IP**、完全绕开 App、用 curl 直接打）：

```
HTTP/1.1 403 Apple WebObjects 5.9.7-2
Content-Length: 0
apple-timing-app: 6 ms
```

同一份**故意写错的凭据**：不带签名 → `403` 空体；带签名 → `200`、326 字节、可解析的 plist
（内容是 `MZFinance.BadLogin.Configurator_message`，即普通的「密码错误」应答）。
这就把「请求根本没走到校验凭据那一步」和「凭据错」彻底区分开了。

该 PR 还引用了线上 bag 的配置：`urlBag.sign-sap-request` 把
`MZFinance:['authenticate']`、`auth/v1:['native']`、`auth/v1/native:['fast']`
全部列入必须 SAP 签名，因此**在几个登录端点之间来回切换没有用**。

> 我在本次排查中独立确认的一点：`https://init.itunes.apple.com/bag.xml?guid=…` 当前仍可取到，
> 且 `authenticateAccount` 仍指向 legacy 的
> `https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate`
> （即 AssppWeb 的 `normalizeAuthURL()` 目前是空转的）。
> `sign-sap-*` 那几行我**没有**亲手抓到原文，是引用 `AssppWeb#88` 的记录 —— 见 §6。

## 5. 自己动手确认（推荐，2 分钟）

```bash
./Resources/Scripts/diagnose.auth403.sh https://<你的用户名>.hf.space
```

脚本做四件事，**全程不使用你的 Apple ID**（只用明显无效的假凭据，看请求能走到哪一步）：

1. 体检你的部署：`/api/settings` 是否 200、`/api/bag` 是否能出网、`/wisp/` 是否能升级成 WebSocket（101）；
2. 拉一次实时 bag，看 Apple 现在指向哪个登录端点、有没有 `sign-sap*` 键；
3. **关键一步**：从你这台机器直连 Apple 登录端点。如果这里也是 `403 + 空体`，
   就证明与抱抱脸无关 —— 这条请求没经过你的 Space；
4. 打印结论。

## 6. 哪些是实测，哪些是引用（别把两者混着信）

**本次实测/实读到的：**

- AssppWeb `zh-CN.json` 的 `errors.auth.emptyBody` 文案（逐字一致）；
- `authenticate.ts` 抛该错误的条件、`request.ts` 的请求头构造（无签名头）；
- `backend/src/routes/bag.ts`、`settings.ts` 的路由形状（脚本据此写）；
- 线上 bag 可取、`authenticateAccount` 仍是 legacy 端点；
- 本仓库 `Package.resolved` = ApplePackage 1.2.7；`ApplePackage` 最新 release 仍是 1.2.7（2026-06-11）；
- `ipatool#522/#523` 已关闭、`v2.4.0` 已发布、`PR #525` merged=true；
- `AssppWeb#88` 状态：open + **draft** + `mergeable: false`，3 commits / +4286 行；主干无 `sap/` 目录；
- 原生 `Asspp#52`（GSA SRP 回退方案）**closed 且未合并**，作者留言「还有验证问题，暂时关闭」。

**没有实测到的：**

- 我**没能**从当前沙箱直连 `buy.itunes.apple.com` 复现那个 403
  （沙箱出网被拦：`curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL`）。
  所以 §4 里的 `403 / Content-Length: 0 / apple-timing-app: 6ms` 是引用 `AssppWeb#88`，不是我打的。
- bag 里 `sign-sap-request` 的原文我没有亲手抓到（只确认了 bag 可取与 legacy 端点仍在）。
- **你的那个 Space 我没有 URL，因此一步都没测。** §2 关于「你的部署链路是好的」
  是从代码路径推出来的（`emptyBody` 只能在 `appleRequest()` 成功返回后才可能抛），
  不是对你实例的实测。请用 §5 的脚本自己跑一遍坐实。

## 7. 怎么修

| 方案 | 可行性 | 说明 |
| --- | --- | --- |
| 换部署平台（Vercel / Cloudflare / 自建 VPS） | ❌ | 换不了病根。请求还是同一条无签名请求 |
| 换 Apple ID、换地区、清缓存、重装 | ❌ | 403 发生在检查凭据之前 |
| 反复重试登录 | ⚠️ 别做 | 不是密码错；反复试有触发账号风控的风险 |
| 等上游 | ✅ 最省事 | 盯 `Lakr233/AssppWeb#88`（网页版）与 `Lakr233/ApplePackage`（原生） |
| 自己上 SAP 签名 | ✅ 唯一真修 | 参考 ipatool `PR #525` 或 AssppWeb `PR #88`。代价：要跑 Apple 的私有二进制（CommerceKit / CommerceCore / CoreFP），约 38 MB 资产 + ~2 MB unicorn.js，首次握手 WebKit ~35s / Chrome ~115s，每次签名 4–12s |
| 临时验证账号可用性 | ✅ | 用 ipatool **v2.4.0+** 登录一次，能登就说明账号没问题，坏的只是 Asspp/AssppWeb |

**抱抱脸相关的坑（与本次 403 无关，但你早晚会撞上）：**

- AssppWeb 是 Docker 应用，而 HF 在 2026-07 取消了 Docker SDK 的免费档，需要 PRO；
- `/wisp/` 必须能升级 WebSocket（脚本第 1 步会验）；
- Space 空闲会休眠，休眠时 `itms-services://` 安装链接会失效；
- IPA 缓存在容器文件系统里，重启即清空 —— 要么开持久化存储，要么设 `DATA_DIR` 指到持久卷；
- 官方只给了 Cloudflare Workers+Containers、Railway、Docker Compose 三种部署方式，
  抱抱脸不在其中，属于「能跑但没人保证」。

## 8. 上游链接

- AssppWeb 403 分析与实现草案：`https://github.com/Lakr233/AssppWeb/pull/88`
- AssppWeb 另一份 SAP 签名 PR：`https://github.com/Lakr233/AssppWeb/pull/89`
- ipatool 的同类 issue：`https://github.com/majd/ipatool/issues/522`、`/issues/523`
- ipatool 的修复：`https://github.com/majd/ipatool/pull/525`（v2.4.0）
- 原生 Asspp 曾经的 GSA 回退尝试（已关闭未合并）：`https://github.com/Lakr233/Asspp/pull/52`
