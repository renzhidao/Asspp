# SAP 签名修复：AssppWeb 可部署版本

> 配套阅读：[AUTH_403_EMPTY_BODY.md](./AUTH_403_EMPTY_BODY.md)（诊断报告）。
> 一句话：`认证失败：服务器返回 HTTP 403 且响应体为空` 是 Apple 要求登录请求带
> SAP 签名导致的，跟抱抱脸无关。这里给出的是**能用的修复**。

## 这是什么

| 路径 | 内容 |
| --- | --- |
| `web/` | 打了 SAP 签名补丁的 **AssppWeb 完整源码**（上游 `3bc9515` + 6 个 commit，169 个文件，1.9 MB） |
| `Resources/Document/patches/` | 同样 14 个 commit 的 `git am` 补丁系列，给已经有 AssppWeb 检出的人 |

二十五个 commit：

```
0001 Fetch and serve the Apple binaries the SAP signer needs   ← 上游 PR #88
0002 Add a browser-side SAP signer                             ← 上游 PR #88
0003 Sign the authenticate request, off the main thread        ← 上游 PR #88（含冲突解决）
0004 Make SAP assets suppliable without Apple's CDN; test the SAP routes  ← 本次新增
0005 Add a diagnostics report that needs no console            ← 本次新增
0006 Report SAP asset progress honestly                        ← 本次新增
0007 Show elapsed time while the signer is being set up        ← 本次新增
0008 Fail an abandoned SAP setup instead of orphaning it       ← 本次新增
0009 Report which setup step is running, and on what hardware  ← 本次新增
0010 Record one setup step per line                            ← 本次新增
0011 Bound the unassisted guest run so it fails, not hangs     ← 本次新增
0012 Give one guest call a wall-clock deadline and report it   ← 本次新增
0013 Stop re-measuring the same basic block                    ← 本次新增
0014 Start a retry from an empty timeline                      ← 本次新增
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

## 卡住的其实是 `setup`，而那一段的屏幕原本是静止的

第二份报告（`buildCommit: 6e5eb7a5`）显示 `stage: setup`、`percent: -`。
这说明**资产阶段已经过去了** —— 38 MB 已下载并成功在浏览器里装载，现在卡在
SAP 握手本身。界面上那句「正在初始化签名器，约需一分钟…」是整段等待里**唯一**
的字，而且一动不动。

这不是猜的，是读代码确认的：`worker.ts` 在 `Signer.create()` **之前**发出
`{phase:"setup"}`，之后就是一整块同步调用
（`Machine.open` → `initialize` → 两次 `exchange`），期间 worker 发不出任何消息。
`client.ts` 侧的超时是 **15 分钟**（`SETUP_TIMEOUT_MS`），所以 15 分钟内它既不会报错也不会变字。

上游 `frontend/src/apple/sap/README.md` 里自己的量测：

| 环境 | setup | 每次签名 |
|---|---|---|
| WebKit（Playwright / iPhone 15 profile） | **35 s** | 3.5 s |
| Node | 63 s | — |
| Chrome（桌面） | **115 s** | 12 s |

`initialize` 跑约 5.3M 条被仿真的指令，两次 `exchange` 再约 5M。

**这三行里没有一个是真手机。** 那份报告来自 Android 10 上的 Chrome 142 —— 真实的
ARM 设备跑 unicorn.js 的 WebAssembly，上面三个数字都不适用，而且很可能慢好几倍。
所以「约需一分钟」对它来说是明显失真的。**这个环境下到底多久，我没有量测，不敢报数。**

`0007` 不去编一个百分比（那时候没有诚实的百分比可给），改成**数秒**：
屏幕上的数字每秒动一次，是「还在跑」唯一诚实的证据；文案也改成
「首次约 1 分钟，手机上会明显更久」。离开 `setup` 阶段时计时器清掉。

## 登录会永久卡住：被丢弃的 setup 从来没有被失败掉

第三份报告（`buildCommit: 22227b2e`）：`stage: setup`、已经 500 多秒、没有报错，
并且**切换到别的页面再回来，秒数从头开始计**。这两件事都指向同一个真 bug。

`AddAccountForm.tsx` 的设备号是 `useState(() => generateDeviceId())` —— **每次组件挂载
都重新随机生成**，所以「切走再切回」会拿到一个不同的设备号。签名器是绑死设备号的，
于是 `prepareSigner()` 走进重建分支：

```ts
if (ready) reset(new Error("SAP signer rebuilt for a different device"));
```

`reset()` 里 reject 了 `pending`（那是**签名**请求），但 setup 的等待者是放在
`settleSetup` 里的，`reset()` 压根没碰它 —— 它只把 `ready = null`。
调用方 `authenticate()` 手上那个 Promise **永远不会结算**。

于是：登录请求挂在那儿，界面停在「正在初始化签名器」，`onerror` 不触发
（worker 是被 `terminate()` 正常终止的，不算错误），只有 15 分钟的
`SETUP_TIMEOUT_MS` 会最终把它叫醒。**这就是 500 多秒什么都不发生的机制。**

`0008` 修三处：

1. `reset()` 现在显式失败 `settleSetup`，被丢弃的 setup 会立刻报错而不是永远悬着。
2. 计时起点从组件内 `Date.now()` 移到 store 的 `setupStartedAt`，切页面不再归零 ——
   一个已经跑了 9 分钟的等待，不该在回来时显示成 0 秒。
3. 诊断报告新增 `setupSeconds` 一行。setup 是唯一没有百分比的阶段，而现有量测都在
   桌面和 Node 上，光看 `stage: setup` 无法回答「是不是卡了」——这正是前两份报告
   来问的问题。

顺带说明一个**没有**修的东西：设备号每次挂载重新生成，本身是有意设计（每个账号一个
设备标识，表单上还有手动「换一个」按钮）。它意味着切页面必然重建签名器、重跑一次
完整 setup。修掉第 1 点之后这不再是永久卡死，但仍是一次白等。要不要把设备号持久化
是个产品决定，我没有擅自改。

## 报告原本回答不了「初始化到底有没有错」

前三份报告的 `[signer]` 只有 `stage / percent / hardwareID`。`stage: setup` 只说明
「有件事在发生」，说不出是六步里的哪一步、卡了多久、跑在什么硬件上。要一次看明白，
就得把 setup 拆开记。

`0009` 做了三件事：

**1. setup 的六步各自打点。** `Signer.create()` 现在接受 `onStep`，在
`machine.open` → `machine.initialize` → `certificate.fetch` → `exchange.1` →
`setup.post` → `exchange.2` 每一步的开始和结束各记一次，经 worker 落到 store。
每步取**一个**时间戳给开始和结束共用，这样 `endedAt - at` 就是这一步的真实耗时。

**2. 报告新增 `stuckInStep` 和 `setupTimeline`。** 时间线以第一条事件为零点，
未结束的那条标 `STILL RUNNING`。`stuckInStep` 直接给结论。真实渲染出来的样子：

```
[signer]
  stage: setup
  setupSeconds: 512
  hardwareID: 0891…
  stuckInStep: machine.initialize for 512s
  setupTimeline:
  machine.open  +0.0s  took 41.2s
  machine.initialize  +41.2s  STILL RUNNING
```

这一下就把「慢」和「卡」分开了：卡在 `certificate.fetch` / `setup.post` 是网络问题
（服务端到 Apple），卡在 `machine.open` / `machine.initialize` / `exchange.*`
是仿真问题（这台设备跑不动）。

**3. 报告新增 `[device]` 段。** `cpuCores`、`deviceMemoryGB`、`platform`、
`visibilityState`。setup 跑的是被仿真的 x86-64，成本主要由硬件决定，而现有量测
全在桌面上 —— 少了这几行，手机的报告没法跟任何基准比。`visibilityState` 还有
另一个用处：标签页被切到后台时 worker 可能被挂起，那看起来跟卡死一模一样。

事件里只放**步骤名**，不放 URL、不放 setup buffer（那是不透明的握手数据），
硬件号仍然只留前缀。报告开头那句「不含凭据」的承诺不变。

## 第一份带时间线的报告：慢，但在推进

第四份报告（`buildCommit: 66252e79`，8 核 / 8 GB Android 10 / Chrome 142）第一次
给出了每步耗时：

| 步骤 | 耗时 | 说明 |
|---|---|---|
| `machine.open` | **1.3 s** | 38 MB 装载正常 |
| `machine.initialize` | **72.9 s** | 慢，但完成（桌面 Chrome 约 60 s） |
| `certificate.fetch` | **0.5 s** | **服务端到 Apple 的网络正常** |
| `exchange.1` | 报告时已跑 **65 s**，仍在进行 | 仿真 |

结论：不是卡死、不是网络、不是内存不足，就是这台设备的仿真比桌面慢。按桌面比例
推算整个 setup 约 160–200 s。

## 时间线一步打了两行（`0010`）

同一份报告里，每一步都出现两次：

```
machine.open  +0.0s  STILL RUNNING
machine.open  +0.0s  took 1.3s      ← 同一步，自相矛盾
```

原因是 store 对每步存了**两条**记录（开始一条、结束一条），时间线逐条打印。
`0010` 让结束事件**折进**已存在的那条，同时时间线也能正确消化成对条目。
只有「末尾那条同名开放记录」会被折叠，所以签名器中途重建时新的一次
`machine.open` 会另起一行，不会覆盖上一次记下的耗时。

**需要更正我上一轮的一句话。** 我当时说 `runningStep`「永远认为有步骤在跑」，
并把「`stuckInStep` 报了早就结束的 `machine.open`」当成症状。这是错的：我把你
数据里的 `exchange.1` 误读成了 `machine.open`。实测把这份数据喂给 `66252e79`
的真实代码，`runningStep` 返回的就是 `exchange.1` —— 正确。最后一步的 begin 和
end 同名同时间戳，倒着扫到哪条都给出同一个答案。**`stuckInStep` 没有骗人，
只有时间线在重复打印。** 那个多余的改动已撤销，为它写的测试也一并修正。

## `exchange.1` 654 秒：不是慢，是撞上了没有上界的一次 `emu_start`

第五份报告（同一台 8 核 / 8 GB Android 10，`buildCommit: 66252e79`）：

```
setupSeconds: 728
stuckInStep: exchange.1 for 654s
```

同一台设备上 `machine.initialize` 是 72.9s，桌面约 60s，即 **1.2 倍**。
桌面整个 setup 才 115s，`exchange.1` 按 1.2 倍应是 30–40s。**654s 是它的约 20 倍。**

`machine.ts` 的 `run()` 里有这条分支：

```ts
if (!block) {
  // Undecodable: let the emulator run unassisted…
  this.segment(address, budget, null);   // budget 仍是 100_000_000
  budget = 0;
}
```

`measure()` 解不出这个指令块时（内存读不到，或解码器不认这条指令），
**剩余全部预算被交给一次同步 `emu_start`**。按这台设备实测的
`72.9s / 5.3M ≈ 2 万条/秒`，1 亿条 ≈ **83 分钟**；客户端超时是 15 分钟。
所以在超时前它出不来，而且**全程无法上报**——从正在运行的仿真器内部发不出任何消息。

`0011` 给这条路径封上 2,000,000 条的上界，超了就抛出点名原因的错误
（`SAP guest needed more than 2000000 unassisted instructions at 0x…`），
在这台设备上约 100 秒就会出结果，而不是静默 83 分钟。

**这个上界不会让今天能跑通的路径失效**：需要超过 200 万条无辅助指令的 guest，
本来也无法在 15 分钟超时内跑完。

**未验证的部分（说清楚）**：这台设备到底是不是走了这条分支，我无法从外部证实——
正因为从仿真器内部发不出消息。这个上界的作用是把它变成一个**会报错的诊断**：
下一份报告若出现上面那句错误，就证实了；若 setup 正常跑完，说明嫌疑点判断错了，
但也没有任何损失。`unassistedAllowance` 的算术有 4 个单元测试；
`run()` 驱动真实仿真器的那一段**没有**测试，此环境没有 38 MB 真实二进制。

## `0011` 的判断被否掉了

同一台设备部署 `cb9c1745`（带上界）后：`exchange.1` 跑了 **332 秒**，
上界**没有触发**。

这台设备的实测吞吐是 `machine.initialize` 的 530 万条 / 72.4 秒 ≈ **7.3 万条/秒**，
200 万条只需约 **27 秒**。332 秒 ≫ 27 秒而错误未出现，说明**无辅助指令跑了不到
200 万条** —— 时间花在别处。**「解码器认不出的指令块」这个判断是错的。**

排除了这一条之后，剩下的可能是每块开销（每轮 `measure()` 要读
`32 × 15 = 480` 字节再解码）或仿真本身，**但这两者从外部无法区分** ——
仿真器是同步的，运行期间发不出任何消息。

`0012` 不再猜：给**单次 guest 调用**加 180 秒墙上时钟上限，超了就抛出带统计的错误：

```
SAP guest call exceeded 180s (elapsed 181.4s, 4200000 blocks,
3 undecodable, 60000 unassisted instructions, budget left 99940000)
```

这四个数能分开两种失败模式：
- **blocks 极多而 budget 几乎没动** → guest 在打转，或每块开销占主导，不是指令数不够
- **undecodable 很多** → 回到解码器覆盖不足（但那已被 332 秒的观测排除）
- **unassisted 接近 200 万** → `0011` 的上界正在生效，只是还没到

180 秒的依据：桌面整个 setup 115 秒，单次调用远低于此；这台设备是 1.2 倍。
单次调用超过三分钟不是设备慢，是 guest 没有推进。

## 定位到了：每块开销，不是指令数

`0012` 的时限如期触发，报出：

```
SAP guest call exceeded 180s (elapsed 180.0s, 1003147 blocks,
0 undecodable, 0 unassisted instructions, budget left 84901039)
```

四个数把范围收窄到一处：

| 观测 | 含义 |
|---|---|
| `0 undecodable` | 解码器**从未**失败 —— 「解码器认不出指令」的判断被否掉 |
| `0 unassisted instructions` | 无辅助路径**一次都没走** —— `0011` 针对的那条分支与此无关 |
| `budget left 84,901,039` | 一亿预算只用了 **1510 万条** |
| `1003147 blocks` | 180 秒里循环了 **100 万次** |

合起来：**平均每块只有约 15 条指令，而每块都要重新 `measure()` 一次**——
读 `32 × 15 = 480` 字节再逐条解码。时间花在「决定怎么切」上，不是「执行」上。

`0013` 给块布局加了缓存。guest 代码有循环，同一批基本块反复出现，而此前每次遇到
都重新解码一遍。缓存**只在单次 `run()` 内有效**，这是安全的：`segment()` 在同一次
调用里植入 HLT 又在 `finally` 里恢复，所以 `measure()` 看到的永远是未被修改的内存；
跨调用则可能 guest 自己改过代码，所以每次 `run()` 从空缓存开始。

统计里新增 `cached blocks` 一项，下一次报告能直接看出命中率。

**这个改动没有验证过是否真的变快** —— 此环境没有 38 MB 真实二进制，跑不了真实仿真。
`BlockCache` 本身有 6 个单元测试；它在 `run()` 里的接入没有测试。
最坏情况是缓存不命中、速度与之前相同，那时 180 秒时限仍会报出同样的统计。

## 一份自相矛盾的报告：事件跨次累积

桌面 Chrome 的报告写着 `setupSeconds: 13`，时间线第一条却在 `+118.8s`。

`begin()` 重置了 `setupStartedAt` 却没有清空 `events`，于是重试时新事件叠在旧事件
之上，而时间线的零点取的是 `events[0]` —— **上一次尝试**的第一条。这份报告混了两次
尝试，里面每一个偏移量都是错的。

`0014` 让 `begin()` 从空时间线开始，同时把失败原因存进 `lastError` 跨次保留：
此前重试会把 `error` 清掉，也就是**用「再试一次」这个动作擦掉了上一次的唯一证据**，
于是「状态栏自己消失了」之后什么都留不下。报告新增 `previousAttemptFailed` 一行。

## 桌面能登录了，但每个按钮都要重跑一次 setup

`useDownloadAction.ts` 的 `acquireLicense()` 每次都先重新登录：

```ts
const renewed = await authenticate(
  account.email, account.password, undefined,
  account.cookies, account.deviceIdentifier,
);
```

而 `authenticate()` 的第一步就是 `prepareSigner()`。签名器活在 worker 内存里，
刷新页面就没了，于是「获取许可证」这一下要重跑整个 setup。

`useSapWarmup` 就是为这件事写的 —— 有账号时在后台自动重建签名器。
**但没有任何地方 import 它**，`grep -rn useSapWarmup src/` 只命中它自己的定义。
`0016` 把它挂到 `App` 上，一行。

签名器**无法**跨刷新保存：它是 unicorn.js 里一台跑着的仿真机，状态就是那块仿真内存。
能做的是让它自动重建，而不是等需要它的那次点击。

## 获取许可证和下载都不该要签名

`acquireLicense()` 每次都先无条件重新登录，注释写的是「防止 token 过期（2034/2042）」。
但 `authenticate()` 的第一步就是 `prepareSigner()`，于是这个防御性刷新让每次点击都付
一整轮 SAP setup —— 已测设备上要好几分钟。

`purchaseApp()` 实际只读 `passwordToken`、`directoryServicesIdentifier`、`store`、
`cookies`、`deviceIdentifier`，**登录后全都有**。所以改成先用现有 token 买，
只有 Apple 真的回 `2034`/`2042` 才重新登录。

下载同理：`getDownloadInfo()` 收到 `failureType 9610` 就是「还没有许可证」
（`download.ts:106`）。获取许可证不需要签名，所以直接自动获取再重试，
不必让用户先点另一个按钮。

`0017`。

## 报告里没有下载记录，因为诊断从来没记过

`diagnostics.ts` 只覆盖 SAP：setup 步骤、资源、账号。搜索、获取许可证、下载一条都不记。
一份「下载失败」的报告发过来，里面关于那次下载什么都没有。

`0018` 加了一条有上限的活动日志（40 条，超出丢最旧的——出问题的是最近的），
报告新增 `[activity]` 段，每行是时间、动作、对象、成败、耗时、原因。
不含密码、token、cookie。

同时把 `noItems` 这条死路补上了证据。`download.ts` 收到没有 `failureType`、
`songList` 又是空的响应时，原来只抛「响应中没有项目」，把 Apple 的整段回答丢掉。
现在带上 `customerMessage`、`store`（storefront）和响应里有哪些键——
storefront 不对是最常见的原因，而这在原文案里完全看不出来。

## 有些应用一直下载不了，和番茄小说一样

用户说得很清楚：番茄小说在这个项目里**从来就下载不了**，SAP 之前也一样，
而别的应用可以。所以这不是回归，是一直存在、只影响一部分应用的问题。

三处把原因丢掉了：

1. `purchase.ts` 的 `2059`（此项目不可用）把 Apple 的 `customerMessage` 扔掉，
   只抛一句通用文案。storefront 不对、pricing parameters 不对、应用下架，
   长得完全一样。`0019` 把它带上。
2. 自动获取许可证失败时，那个失败被**吞掉**，用户只拿到下载那一步的
   「响应中没有项目」。而许可证失败才是真正的原因。现在两条一起报。
3. 上面那条 `noItems` 本身也没有证据（`0018` 已补）。

`purchaseApp` 先试 `pricingParameters = "STDQ"`，遇 `2059` 再试 `"GAME"`
（`purchase.ts:27`）。两次都不行才抛错，所以现在抛出来的那条带着 Apple 的原话。

**番茄小说到底为什么不行，仍然未知** —— 要看 Apple 实际回什么，而旧版把它丢了。
部署 `0019` 之后，那条错误会自己说出来。

## 桌面上的完整 setup 时间线，以及 exchange.1 的实测

部署 `83253701` 之后，第一份带完整时间线的报告：

```
machine.open       +0.0s    took  7.3s
machine.initialize +7.3s    took 14.0s
certificate.fetch  +21.3s   took  0.9s
exchange.1         +22.2s   took 107.6s
setup.post         +129.8s  took  0.7s
exchange.2         +130.5s  took  4.4s
```

`exchange.1` 在桌面 Chrome 上 **107.6 秒跑完了**。上游量测桌面整套 setup 是 115 秒，
而这里 exchange.1 单步就是 107.6 秒 —— 和上游一致。手机上同一步撞 180 秒时限失败。

`0013` 的块缓存是否让它变快了，**仍然无法直接证明** —— 没有缓存前的桌面数字可以对比。
能确定的是：桌面上这一步现在能完成。

## 番茄小说：Apple 说 "App Not Available"，但应用是存在的

```
响应中没有项目 (App Not Available store=143465
  keys=pings,metrics,failureType,customerMessage,m-allowed,cancel-purchase-batch)
```

`cancel-purchase-batch` 是购买接口的响应形状，所以这是 `buyProduct` 回的。

而这个应用**在中国区是存在的**：id `1468454200`，免费，13+，支持 iPhone/iPad/iPod，
图书榜第一（apps.apple.com/cn/app/id1468454200）。所以「App Not Available」不是
「查不到这个应用」。

响应里有 `failureType`，但 `purchase.ts` 在有 `customerMessage` 时只抛那句话，
把数字码丢了 —— 而那句话说明不了是哪条规则拒绝的。`0020` 让两处都把数字码带上。

`0020` 部署之后（`b773b6e`）重试，**错误里仍然没有数字码**。所以那句话根本不是
`purchase.ts` 抛的，也不是 `noItems` 抛的。

真正抛它的是 `download.ts` 的 default 分支：volumeStore 端点自己回了
`failureType` + `customerMessage="App Not Available"`，default 分支在有
`customerMessage` 时只抛那句话，**并且在 `songList` 检查之前就 return 了** ——
`0018`/`0020` 加证据的那个分支根本走不到。

`0021` 把数字码加在真正抛错的那一行。

**具体是哪条规则，仍然未知**，要等带数字码的那一次。

## 历史版本加载失败，同样没被记录

`versionFinder.ts` 和 `download.ts` 是同一个毛病：`9610` 抛
`"License required - purchase the app first"`，default 抛 `customerMessage`，
都不带 `failureType`。而且 `VersionHistory.tsx` 只弹 toast，**不写活动日志**，
所以报告里关于版本历史一个字都没有。

`0022` 两处都补：错误带上数字码，加载动作（成败、耗时、原因）进 `[activity]`，
类型新增 `versions`。

## failureType 是空字符串 —— 前面所有基于它的推断都错了

`3085056` 部署后重试，两条错误都**没有数字码**，但都带 `customerMessage`：

```
download  番茄小说  FAILED — 响应中没有项目 (App Not Available store=143465
          keys=pings,metrics,failureType,customerMessage,m-allowed,cancel-purchase-batch)
versions  番茄小说  FAILED — No items in response
```

只有一种情况能同时满足「`keys` 里有 `failureType`」和「`code=` 没打印」：
**`failureType` 是空字符串**。空串是 falsy，于是

- `download.ts` 的 `if (dict.failureType)` 整块被跳过，落到 `noItems`
- `versionFinder.ts` 同理，落到没有括号的那条 `throw new Error("No items in response")`
- 所有 `dict.failureType ? ... : ""` 都打印了空

`versions` 那条是决定性证据：`0022` 之后带码的三条都带括号，只有**走不到的**
那条不带 —— 说明 `if (dict.failureType)` 根本没进。

**所以 Apple 对这批应用回的是 `customerMessage="App Not Available"` 加一个空的
`failureType`。** 没有数字码可给。此前 `0019`/`0020`/`0021` 三个补丁都假设有一个
数字码被丢掉 —— 前提错了，那三个改动对这个问题没有作用（虽然本身无害）。

`0023` 把三态显式打出来：`code=9008` / `code=empty` / `code=absent`。

## 根因：volumeStore 请求缺 `serialNumber`

Apple 在 `volumeStoreDownloadProduct` 上加了一道校验，**只对部分应用生效** ——
大厂的应用要，普通应用不要。ipatool 撞上同一堵墙：

> Apple has recently implemented an additional verification check on the
> volumeStoreDownloadProduct endpoint for certain popular applications (such as
> Google and Microsoft apps, and others). If the required key is missing from
> the payload, the API returns 5002. Other standard applications currently
> bypass this check and work without issues.
> — majd/ipatool#500

修法是在 payload 里加 `serialNumber: "0"`。**该 PR 于 2026-08-28 合并** —— 和 SAP
变更同一天。合并后 ipatool 在**三个** volumeStore 请求里都带这个键：
`appstore_download.go`、`appstore_list_versions.go`、`appstore_get_version_metadata.go`。

Web 版**一个都没有**。`grep -rn serialNumber src/` 在 `0023` 之前是 0 命中。

这解释了全部现象：

- 字节跳动那批应用全部失败，七猫小说成功 —— 正是「大厂要、普通不要」
- 回的是 `App Not Available` 加空 `failureType`，响应里没有任何字段说明缺了什么
- 下载、历史版本、版本元数据三处一起坏 —— 三个调用点都缺同一个键
- 「这个项目从来就下载不了这些应用」—— 校验是 Apple 后加的，不是回归

`0024` 给三处 payload 都加上 `serialNumber: "0"`。

**这一条是上游已合并的修法，不是我猜的。**

**但它被证伪了。** 部署 `b324d1a` 后重试，仍然是
`App Not Available (code=empty)`。PR #500 修的是 `5002`，不是这个 —— 我拿一个
治另一种病的修法当成了这个病的。

### 被证伪的假设清单

| 假设 | 证伪依据 |
|---|---|
| 解码器读不出块（`0011`） | 报告 `0 undecodable` |
| 无界 `emu_start`（`0011`） | 报告 `0 unassisted instructions` |
| 有数字码被丢在 `purchase.ts`（`0019`） | 那句话不是从那里抛的 |
| 有数字码被丢在 `download.ts` default 分支（`0021`） | 那个分支也没进 |
| **数字码存在** | `code=empty` —— 键在，值是空串 |
| 端点与 ipatool 不同（`MZBuy.woa`） | 官方 ipatool 是 `MZFinance.woa`，与 Web 版相同；`MZBuy` 来自第三方 fork |
| 缺 `serialNumber`（`0024`） | 加了之后错误一字不变 |

### 还没有被解释的事实

响应键是 `pings, metrics, failureType, customerMessage, m-allowed,
cancel-purchase-batch`。`cancel-purchase-batch` 和 `m-allowed` 是**购买**响应的形状，
不是 `volumeStoreDownloadProduct` 的。但抛错的是 `getDownloadInfo`，
而 `handleDownload` 只调 `startDownload`，不调 `acquireLicense`
（`ProductDetail.tsx:119-137`）。这两件事目前对不上。

`0025` 不再猜：失败时把**整个交换**打印出来 —— 端点、HTTP 状态、实际发出的
payload 键、以及响应原文（截断 600 字符）。失败响应里没有 `songList`，
所以其中不含下载链接。

## 我验证到了什么（全部本次实跑）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `backend` `npx tsc --noEmit` | **0 错误** |
| 前端类型检查 | `frontend` `npx tsc --noEmit` | **1 错误**，在 `src/utils/crypto.ts:30`，**与 main 基线完全一致**（main 也是这 1 个），不是本次引入 |
| 后端测试 | `backend` `npm test` | **68 passed / 8 files**（基线 49，新增 19 个 SAP 测试） |
| 前端测试 | `frontend` `npm test` | **156 passed / 22 files**（基线 96；新增 3 个签名测试、14 个诊断构建测试、8 个 setup 时间线测试、6 个块缓存测试、4 个 guest 预算测试、4 个 guest 时限测试、3 个 store 记录测试、6 个诊断弹窗测试、2 个 SAP 状态计时测试、5 个进度语义测试、2 个签名器重建测试、6 个 store 记录与重试测试） |
| 后端构建 | `backend` `npm run build` | 通过 |
| 前端构建 | `frontend` `npm run build` | 通过；产物含 `worker-*.js` 37 KB 与 `unicorn_x86-*.js` 1.03 MB，即签名器确实进了 bundle |
| 服务真跑起来 | `node dist/index.js` | `/api/settings` 200、`/api/sap/assets` 200、`/api/sap/assets/CoreFP` 503 带提示、`/` 200、`POST /api/sap/assets/fetch` 202 |
| 连不上 Apple 时的报错 | 同上（本沙箱正好连不上 `swcdn.apple.com`） | 实测返回：`cannot reach swcdn.apple.com ...: Client network socket disconnected before secure TLS connection was established.` + `SAP_ASSETS_DIR` 提示 |
| 自带资产路径 | 手写 4 个 stand-in + `sap-assets.json`，`SAP_ASSETS_DIR` 指向它 | `ready: true`，`GET /api/sap/assets/CommerceKit` 200 带 `Cache-Control: immutable` |
| WebSocket 中继 | 对跑起来的服务发升级请求 | **101 Switching Protocols**（`/wisp/` 可用，登录请求要走它） |
| 补丁可复现 | 全新克隆 + `git am` **十四个**补丁 | 干净应用，`diff -r` 树与 `web/` 一致 |
| 单行记录真抓得住错 | 把时间线改回逐条打印 | 1 个失败：`expected [ …(7) ] to have a length of 4 but got 7` |
| store 折叠真抓得住错 | 把 `recordEvent` 改回无条件追加 | 3 个失败，其中 `expected [ …(3) ] to have a length of 2 but got 3` |
| 时间线真抓得住错 | 把配对逻辑写成「找另一条同名结束条目」 | 2 个失败：`machine.open` 明明结束了却报 `STILL RUNNING` |
| 计时器真抓得住「静止的屏幕」 | 把计时逻辑拆掉再跑测试 | 2 个失败：`to contain 'setupElapsed'`、`to contain '"seconds":5'` |
| 孤儿 Promise 真抓得住 | 把 `reset()` 里那句 reject 删掉再跑 | 测试**超时 15 秒** —— Promise 永不结算，正是界面上那个永久转圈 |
| 计时起点真抓得住 | 把起点改回组件内 `Date.now()` 再跑 | 1 个失败：`expected +0 to be 120` |
| 进度修复真抓得住 bug | 把累加逻辑还原成旧写法再跑测试 | 3 个失败，其中 `expected 100 to be less than 50` —— 正是日志里那个 100% |
| 既有缺陷 | `DiagnosticsModal` 的 toast mock | 原本每轮都留一个 `addToast is not a function` 未处理拒绝，已修 |
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
