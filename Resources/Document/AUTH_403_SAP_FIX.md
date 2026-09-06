# SAP 签名修复：AssppWeb 可部署版本

> 配套阅读：[AUTH_403_EMPTY_BODY.md](./AUTH_403_EMPTY_BODY.md)（诊断报告）。
> 一句话：`认证失败：服务器返回 HTTP 403 且响应体为空` 是 Apple 要求登录请求带
> SAP 签名导致的，跟抱抱脸无关。这里给出的是**能用的修复**。

## 这是什么

| 路径 | 内容 |
| --- | --- |
| `web/` | 打了 SAP 签名补丁的 **AssppWeb 完整源码**（上游 `3bc9515` + 6 个 commit，169 个文件，1.9 MB） |
| `Resources/Document/patches/` | 同样 6 个 commit 的 `git am` 补丁系列，给已经有 AssppWeb 检出的人 |

六个 commit：

```
0001 Fetch and serve the Apple binaries the SAP signer needs   ← 上游 PR #88
0002 Add a browser-side SAP signer                             ← 上游 PR #88
0003 Sign the authenticate request, off the main thread        ← 上游 PR #88（含冲突解决）
0004 Make SAP assets suppliable without Apple's CDN; test the SAP routes  ← 本次新增
0005 Add a diagnostics report that needs no console            ← 本次新增
0006 Report SAP asset progress honestly                        ← 本次新增
```

前三个来自 `Lakr233/AssppWeb` 的 draft PR **#88**（作者 Tardisyuan）。
那个 PR 的分支基于旧 main，`mergeable: false`，直接合不上；
这里是把它的三个 commit **cherry-pick 到当前 main（`3bc9515`）**，
`0003` 在 `frontend/src/components/Search/ProductDetail.tsx` 有一处 import 冲突，已解决。

第四个是本次新增的，三件事：

1. **`SAP_ASSETS_DIR`** —— 签名器需要的 4 个 Apple 二进制（共 38 MB）原本只能从
   `swcdn.apple.com` 下载。**你的部署如果连不上 Apple CDN，签名器永远起不来，
   登录照样失败**，而原来的报错只有 `fetch failed` 两个词。现在可以指定一个自带文件的目录。
2. **`sap-assets.json`** —— 放在那 4 个文件旁边，描述期望的 name/path/size/SHA-256，
   覆盖内置清单。既是运维换版本的入口，也是让校验逻辑可测的注入点。
3. **可读的失败信息** —— Node 把所有 fetch 失败都压成 `fetch failed`，真正原因在 `.cause` 上。
   现在会展开，并直接告诉你 `SAP_ASSETS_DIR` 这条出路。

顺带修了 PR 自带的一个布局回归：`SapStatus` 被包在一个常驻 `<div>` 里塞进
ProductDetail 的 `grid-flow-col auto-cols-fr` 按钮行，即使它渲染 `null`
也会占掉一个格子、把三个按钮挤窄。改成让 `SapStatus` 自己带 `col-span-full`。

## 怎么部署

### A. 用 `web/` 直接部署（推荐，最省事）

```bash
cd web
docker build -t assppweb:sap .
docker run -d -p 8080:8080 -v asspp-data:/data \
  -e DATA_DIR=/data -e PUBLIC_BASE_URL=https://你的域名 \
  assppweb:sap
```

抱抱脸（Docker SDK）就把 `web/` 的内容推到 Space 仓库根目录。注意
**HF 在 2026-07 取消了 Docker SDK 的免费档**，需要 PRO。

首次登录时前端会 `POST /api/sap/assets/fetch`，服务端去 Apple 下载 38 MB。
下载成功后写进 `DATA_DIR/sap`，之后一直复用。

### B. 部署环境连不上 Apple CDN 时

这正是抱抱脸很可能遇到的情况。分两步：

```bash
# 1) 在一台能访问 Apple 的机器上（比如你自己的 Mac）
cd web
node tools/fetch-sap-assets.mjs        # 产出 4 个二进制 + sap-assets.json

# 2) 把那个目录整个传到部署上，然后
docker run ... -v /宿主/sap:/sap -e SAP_ASSETS_DIR=/sap ...
```

在抱抱脸上就挂持久化存储（Persistent storage），把目录放进去，
环境变量设 `SAP_ASSETS_DIR=/data/sap`。
**一定要放在持久卷里**，否则每次重启文件就没了，登录又坏。

### C. 打到已有的 AssppWeb 检出上

```bash
cd 你的 AssppWeb
git am /path/to/Asspp/Resources/Document/patches/*.patch
```

我验证过：在一个全新的 `Lakr233/AssppWeb` 克隆（`3bc9515`）上 `git am` 四个补丁
全部干净应用，**无冲突无 fuzz**，得到的树与 `web/` 逐字节一致。

## 部署后怎么确认它真的在工作

```bash
# 1) 资产状态。ready:true 才可能登录成功
curl -s https://你的域名/api/sap/assets | jq

# 2) 报错可读性。连不上 Apple 时应该看到原因 + SAP_ASSETS_DIR 提示，
#    而不是干巴巴的 "fetch failed"
curl -s -X POST https://你的域名/api/sap/assets/fetch && sleep 10 \
  && curl -s https://你的域名/api/sap/assets | jq .error

# 3) WebSocket 中继（登录请求要走它）—— 必须带 --max-time，
#    否则升级成功后 curl 会挂在那里等数据
curl -s -o /dev/null --max-time 3 -w '%{http_code}\n' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://你的域名/wisp/          # 期望 101；curl 退出码 28 是正常的（被 max-time 掐断）
```

诊断脚本 `Resources/Scripts/diagnose.auth403.sh` 的第 1 步做的就是这三件事。

## 出问题时怎么把信息给我（不用开控制台）

**设置页最下面 → 「生成诊断信息」→ 复制 / 下载 .txt**，然后把那段文本贴过来就行。

它会一次性收集：服务端 build 与配置、SAP 资产是否就位（以及服务端给的错误原文）、
签名器走到哪一步、浏览器环境、账号列表（**只有数量和 `r***@example.com` 这样的脱敏形式**）。

几个刻意的设计：

- **按构造不含凭据。** 生成报告的函数只接受账号对象、只输出数量和脱敏地址，
  没有任何代码路径能把 `password` / `passwordToken` / `cookie` / DSID 带进输出。
  这一点是测试断言的（给每个凭据字段都填了独一无二的值，再断言它们不出现）。
  所以你可以直接公开粘贴，不用先逐行检查。
- **每一段各自获取。** 某个接口连不上时，那一段就地写 `unreachable: ...`，
  其余照出 —— 「服务端没响应」本身就是结论，不该把整份报告带走。
- **手机上长按文本框也能复制**，即使 `navigator.clipboard` 不可用。

真实输出长这样（本沙箱正好连不上 Apple CDN，所以是最有代表性的那种失败）：

```
AssppWeb diagnostics
generated: 2026-09-06T09:05:38.126Z
note: contains no password, passwordToken, cookie or DSID by construction.

[browser]
  userAgent: Mozilla/5.0 ...
  language: zh-CN
  page: https://demo.hf.space
  secureContext: true
  worker: available

[server]
  buildCommit: 3bc9515
  uptimeSeconds: 3721
  dataDir: /data
  publicBaseUrl: https://demo.hf.space

[sap assets]
  ready: false
  missing: CommerceKit, CommerceCore, CoreFP, CoreFP.icxs
  stage: locating
  error:
    cannot reach swcdn.apple.com to download the SAP assets: Client network
    socket disconnected before secure TLS connection was established.
    If this host's egress is restricted, run tools/fetch-sap-assets.mjs ...

[signer]
  stage: error
  hardwareID: a1b2…
  error:
    timed out preparing the SAP signer

[accounts]
  count: 2
  - r***@example.com  store=143441  hasPassword=yes  guid=a1b2…
  - s***@other.org  store=143462  hasPassword=no  guid=ffee…
```

## `stage: assets, percent: 100` 是显示错误，不是卡死

第一份真实部署的诊断报告里出现了这个组合，看着像「卡在 100%」，其实不是。

四个二进制是 `Promise.all` **并发**下载的，体积差两个数量级
（CommerceCore 207 KB / CommerceKit 3.3 MB / CoreFP.icxs 5.3 MB / CoreFP 29 MB），
而进度上报的是**最后到达的那条消息所属单个文件**的 `loaded/total`。
所以 207 KB 那个一落地就报 100%，而 29 MB 的 CoreFP 才刚开始 —— 真正的等待还在后面。
`0006` 改成先 HEAD 量出总大小，再上报「已到手字节 / 应到手字节」这一个数字。

另外服务端从 Apple 拉取那一段，原本也往同一个通道里塞 `loaded=已找到文件数/total=4`，
被当成字节百分比读 —— 于是**一个字节都还没下载就显示 100%**。现在它有独立的
`installing` 阶段，不给百分比，因为那时候没有诚实的百分比可给。

## 我验证到了什么（全部本次实跑）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `backend` `npx tsc --noEmit` | **0 错误** |
| 前端类型检查 | `frontend` `npx tsc --noEmit` | **1 错误**，在 `src/utils/crypto.ts:30`，**与 main 基线完全一致**（main 也是这 1 个），不是本次引入 |
| 后端测试 | `backend` `npm test` | **68 passed / 8 files**（基线 49，新增 19 个 SAP 测试） |
| 前端测试 | `frontend` `npm test` | **121 passed / 15 files**（基线 96；新增 3 个签名测试、13 个诊断构建测试、4 个诊断弹窗渲染测试、5 个进度语义测试） |
| 后端构建 | `backend` `npm run build` | 通过 |
| 前端构建 | `frontend` `npm run build` | 通过；产物含 `worker-*.js` 37 KB 与 `unicorn_x86-*.js` 1.03 MB，即签名器确实进了 bundle |
| 服务真跑起来 | `node dist/index.js` | `/api/settings` 200、`/api/sap/assets` 200、`/api/sap/assets/CoreFP` 503 带提示、`/` 200、`POST /api/sap/assets/fetch` 202 |
| 连不上 Apple 时的报错 | 同上（本沙箱正好连不上 `swcdn.apple.com`） | 实测返回：`cannot reach swcdn.apple.com ...: Client network socket disconnected before secure TLS connection was established.` + `SAP_ASSETS_DIR` 提示 |
| 自带资产路径 | 手写 4 个 stand-in + `sap-assets.json`，`SAP_ASSETS_DIR` 指向它 | `ready: true`，`GET /api/sap/assets/CommerceKit` 200 带 `Cache-Control: immutable` |
| WebSocket 中继 | 对跑起来的服务发升级请求 | **101 Switching Protocols**（`/wisp/` 可用，登录请求要走它） |
| 补丁可复现 | 全新克隆 + `git am` **六个**补丁 | 干净应用，`diff -r` 树与 `web/` 一致 |
| 进度修复真抓得住 bug | 把累加逻辑还原成旧写法再跑测试 | 3 个失败，其中 `expected 100 to be less than 50` —— 正是日志里那个 100% |
| 诊断按钮真渲染 | 组件测试 + 打印真实输出 | 弹窗渲染、两个接口都被调用、剪贴板收到内容、且内容不含凭据 |

新增测试覆盖的具体行为（都是断言真实代码路径，不是 stand-in）：
资产缺失/尺寸对但摘要错/被截断 → 分别报 missing/corrupt；文件替换后重新校验；
manifest 被就地修改后能察觉；`SAP_ASSETS_DIR` 下拒绝下载；manifest 非法 JSON /
空数组 / 缺字段各自报错；四个端点的状态码与响应体；
`authenticate()` 会在联系 Apple **之前**准备签名器、把签名 base64 放进
`X-Apple-ActionSignature`、签名器失败时**绝不发出未签名请求**。

## 我没能验证的（重要，别当成已验证）

1. **没有对 Apple 真实登录过一次。** 本沙箱连 `buy.itunes.apple.com`、
   `swcdn.apple.com`、`s.mzstatic.com`、`fpinit.itunes.apple.com` 全部不通
   （实测 `curl: (35) SSL_ERROR_SYSCALL` / TLS 断开）。所以
   **「带上签名后 Apple 会返回 200」这一点是引用上游 PR #88 的实测，不是我验的。**
   我验证的是这套代码能编译、能跑、逻辑正确、失败时报错可读。
2. **38 MB 的真实 Apple 二进制没下载过**，因此 Mach-O 加载器、x86-64 指令长度解码、
   unicorn 仿真、SAP 握手这些**只在类型和构建层面被检查过，没有真正执行过一次签名**。
   第一次真实运行请预留时间：上游量测是 WebKit ~35 s、Chrome ~115 s 的准备时间，
   每次签名再 4–12 s。
3. **没在真机上装过 IPA。** 上游作者也标注了这一点（guest 映射 144 MB + 38 MB 资产，
   手机能否承受未知）。
4. **你的那个 Space 我没有 URL，一步都没测。**

第一次真实登录如果失败，请把 `GET /api/sap/assets` 的完整输出和浏览器控制台报错贴出来 —— 
这能立刻区分「资产没到位」「仿真起不来」和「Apple 仍然拒绝」三种完全不同的情况。

## 其他注意事项

- 这套实现会**执行 Apple 的私有二进制**（CommerceKit / CommerceCore / CoreFP / CoreFP.icxs），
  从 Apple 的软件更新 CDN 取，在浏览器里用 unicorn.js 仿真运行。ipatool 做了同样的取舍，
  但你要清楚这一点再部署。
- 别用主力 Apple ID。
- 上游 `Lakr233/AssppWeb#88` 仍是 draft；如果它被合并了，以官方实现为准，
  把这里的 `0004`/`0005` 单独摘过去即可。`0004` 动 9 个文件：`backend/src/config.ts`、
  `backend/src/routes/sap.ts`、`backend/src/services/sapAssets.ts`、
  新增 `backend/tests/sapRoute.test.ts`、`frontend/src/components/Search/ProductDetail.tsx`、
  `frontend/src/components/common/SapStatus.tsx`、`frontend/tests/apple/authenticate.test.ts`、
  `README.md`、`.gitignore`。`0005` 动 11 个文件，全部在 `frontend/`：新增
  `src/utils/diagnostics.ts`、`src/components/Settings/DiagnosticsModal.tsx` 与两个测试文件，
  改 `SettingsPage.tsx` 和 6 个语言包。两个 commit 都不碰 Apple 协议代码，
  上游合并后冲突面很小。
