# 空闲关机 · dsh-idle-shutdown

DeepSeek Harness 插件：**当所有对话都空闲下来、并且当前落在你设定的时间段内**时，让系统关机（挂机场景）。它只做这一件事——不做重启、不休眠、不睡眠、不跑自定义命令；DSH 也不由插件去退出，那部分交给系统：关机本身会关掉 DSH。频繁误触发会毁掉工作，所以它把"什么算活跃""什么时候才算到点""最后几秒交给谁"都当成硬问题来处理。

- 作者：laose66 ｜ 许可：MIT ｜ 适用：DeepSeek Harness（Desktop 与 `dsh web` 均可运行）
- 标签：`dsh-plugin`（GitHub topic，供 DSH 插件索引自动收录）

## 它解决什么

| 能力 | 说明 |
| --- | --- |
| 只在时间段内动手 | 每天 / 仅今天 / 限次数 × **持久 / 临时**；跨零点（`20:00 → 07:00`）直接写；没有时间段＝全天 |
| 什么算"有活" | 会话事件流、未结束的回合/步骤、运行中的后台任务、终端活动、**排队中的输入**；鼠标键盘活动**不算** |
| 空闲多久才动手 | 可配置（默认 30 分钟，最小 0.05 分钟仅用于测试，最大 3 小时） |
| 倒计时可撤销 | 标题栏按钮变「撤销」，可**撤销本次**或**撤销并跳过本时间段**；倒计时期间任何对话活动都会取消它 |
| 最后几秒不可撤销 | 只有倒计时最后 3 秒（可配 3–60 秒）交给系统关机命令，这之前一直可撤销 |
| DSH 由系统关闭 | 插件不自己去退出 DSH：`shutdown` 会发 `WM_QUERYENDSESSION`/`WM_ENDSESSION`，Electron 收到后正常退出（实测约 1 秒），而 `/t` 隐含 `/f`，应用也拦不住它 |
| 睡觉不会变成"醒来就关机" | 提交前检测挂起/改钟；最后一次交接前用唤醒守卫**锁住系统不休眠**（不点亮屏幕） |
| 时间段过期还能救 | 失效的持久时间段，用它自己的「重复」下拉框重新选择即可重新激活 |
| 干净收尾 | 状态文件 + 滚动日志，有保留上限；不轮询、空闲时零唤醒 |

## 安装 / 更新 / 卸载

### 从插件索引安装（推荐）

1. DSH → **插件 → 发现 → 添加索引源**，粘贴：

   ```text
   https://whoishuhu.github.io/dsh-plugin-index/index.json
   ```

   （看不到「发现」标签页时，先在 **插件 → 实验性插件** 打开 **自定义插件索引**。）

2. 搜索「空闲关机」或 `dsh-idle-shutdown` → 安装。

本仓库根目录 `package.json` 声明了 `dsh.bundle.patch`，并带有 GitHub topic `dsh-plugin`，因此**不需要提交申请**：索引每天北京时间 02:00 重建一次，会把它收录进去。

### 从本地目录安装

DSH → **插件 → 添加插件** → 选择本目录；或让 agent 用 `plugin_manager` 的 `install_bundle` 安装目录路径。

### 直接从这个仓库安装

DSH → **插件 → 添加插件**，粘贴：

```text
github:laose66/dsh-idle-shutdown
```

（需要能访问 github.com；已验证该方式安装出的是 2.0.1 的完整副本。）

### 安装排错

- **`dsh: connection to github.com timed out after 5000ms`**：安装器在真正下载前会先探测 GitHub，国内网络/代理不稳时就会这样。换成本地目录安装，或等网络恢复。
- **`ERR_PNPM_EPERM ... rename '...node_modules\dsh-idle-shutdown_tmp_…' -> '...node_modules\dsh-idle-shutdown'`**：这条路径上还留着**上一次"本地目录安装"的 junction（目录联接）**。Windows 不允许把目录 rename 到已有的 reparse point 上，pnpm 就会 EPERM。先卸载插件，然后把那个 junction 删掉（`cmd /c rmdir "…\node_modules\dsh-idle-shutdown"`，**不要**用递归删除，那会连你源码目录一起删），再重新安装即可。
- 从"本地目录安装（link）"与"从 GitHub/npm 安装（复制）"之间切换时，都按上一条处理：先卸载 → 清掉残留 junction/软链接 → 再安装。装成副本后，你在源码目录里的改动**不会**自动生效，需要重新用本地目录安装。

### 更新

- 索引安装：在 **插件** 页对该条目点更新（取最新版本）；
- 本地目录安装：替换目录内容后重启 DSH（插件 JS 模块需要新的 generation 才生效）。

### 卸载

- DSH → **插件** → 该条目 → 卸载（删除 `dsh-idle-shutdown` 这一 bundle）；
- 或让 agent 执行 `plugin_manager` 的 `remove_bundle`。

**卸载后不留东西**，靠的是"文件本来就在包里"，不靠插件运行时去清理：

| 位置 | 内容 | 卸载时 |
| --- | --- | --- |
| profile 的 `package.json` / `pnpm-lock.yaml` / `dsh.profile.bundles` | 安装记录 | 由插件管理器移除 |
| `<profile>/node_modules/dsh-idle-shutdown` | 插件本体（复制安装是目录，目录安装是链接） | 复制安装由 pnpm 删除 |
| **插件目录内的 `.dsh-idle-shutdown/`** | 状态文件、持久日志（含滚动代）、守卫脚本/包装/marker、崩溃残留 `*.tmp` | 随插件目录一起消失 |

- **重载 / 禁用 / 重启 DSH 不删**这些文件（它们只是诊断输出，不会影响正确性；真正的状态写在 profile 的配置里）。
- 唯一例外：**插件目录不可写**（例如 DSH 装在 Program Files）时，文件退到系统临时目录，此时会在插件卸载出进程时被删掉。
- 用**本地目录安装**（link 到你的源码检出）时，卸载由 pnpm 处理，它可能因为 Host 正占用而删不掉那条联接；如果之后要用 GitHub/npm 方式重装并遇到 `ERR_PNPM_EPERM rename …dsh-idle-shutdown`，按「安装排错」清掉那条联接即可。
- 不要在 profile 补丁里手写同名行：用户补丁层任何卸载都不会改动它（本插件安装不需要这种行）。

## 使用方法

### 标题栏按钮

- 平时是**电源开关**：点亮＝启用，熄灭＝即使满足条件也不执行（关闭时插件不挂任何监听、不设定时器）。
- **倒计时开始后变成撤销按钮**（警示色）：点击弹出菜单
  1. **撤销此次关机**：只取消这一次；
  2. **撤销并跳过本时间段**：取消，并让当前时间段到本轮结束前不再触发。
- **进入不可撤销阶段（最后 `closeLeadSeconds` 秒）后，按钮变回开关的样子**（电源图标、开关配色），按钮下沿仍有一条**进度条**显示该阶段剩余比例；悬浮提示写明「最后 N 秒由系统关机命令执行，已无法撤销」。此时点它＝普通开关（关掉只是停止本插件后续监控，已经在系统手里的关机不会被它取消）。
- 倒计时开始时同时弹系统通知。

### 设置页

**设置 → 空闲关机**：开关、空闲等待、倒计时、不可撤销秒数、时间段列表。底部固定一条操作栏（还原默认 / 取消 / 保存），滚动不会带走它。

### 时间段模型

| 属性 | 取值 | 说明 |
| --- | --- | --- |
| `start` / `end` | `HH:MM` | 每日范围；`end` 早于 `start` 表示跨零点；`start === end` 表示全天 |
| `repeat` | `daily` / `today` / `count` | 每天 / 仅今天 / 最多 `remaining` 次 |
| `remaining` | 数字 | 仅 `count` 使用，每触发一次减一 |
| `persistent` | `true` / `false` | 触发后保留（只是变成不可再触发）；临时＝触发一次后自动从列表删除。**「每天」强制持久** |

- `skipUntil`：跳过截止时刻，只作用于被跳过的那一条。
- **临时**时间段有生命周期：由「第一次还能用的那一段 + 还能执行的次数」算出终点，到期自动删除。
- **重新激活（不另设按钮）**：失效的持久行，其「重复」下拉框会显示成 `已失效，重新选择即激活`；重新选「仅今天」＝重盖今天日期并清掉已执行/跳过，选「限次数」＝重给配额（旁边次数框改数字同样算），选「每天」＝转成每天+持久。命令行也有：`/idle-shutdown reactivate [today|count|daily]`。
- 没有时间段＝全天生效。

### 什么算「活跃对话」

满足任意一条即视为活跃（空闲计时清零）：

- 任意 Agent 回合未结束，且最近（`waitingGraceMinutes` 内）有会话事件写入；
- 任意 Agent 步骤未结束且驱动仍在运行（模型请求/工具调用进行中，此时可能长时间不写日志）；
- 任意 Agent 名下仍有运行中的后台任务；
- 任意 Agent 的终端仍有活动；
- 任意 Agent 的**排队输入**（还没轮到，事件流看不见，按 DSH 自己的退出规则算作有活）。

「活动」指一切写入会话日志的对话事件。**鼠标键盘活动、只打开页面不对话都不算活跃**。卡在等你批准的回合超过 `waitingGraceMinutes` 后不再阻止关机。

### 命令

| 命令 | 作用 |
| --- | --- |
| `/idle-shutdown status` | 开关、时间段（含重复/持久/剩余）、是否在窗口内、空闲时长、倒计时、状态文件 |
| `/idle-shutdown on` / `off` | 开关 |
| `/idle-shutdown cancel` | 撤销本次倒计时 |
| `/idle-shutdown skip` | 撤销并跳过当前时间段 |
| `/idle-shutdown now` | 立即开始一次倒计时（仍受开关、时间段、`dryRun` 约束） |
| `/idle-shutdown reactivate [today\|count\|daily]` | 重新激活列表里第一条失效的持久时间段 |

命令自身的日志记录不计入活动，看状态不会打断倒计时。

## 实现原理

### 调度：事件驱动，没有轮询

- 空闲计时是**一次性定时器**，设在「最后活动时间 + 空闲时长」那一刻；每个对话事件只是把它往后挪。
- 窗口开/关各有一个边界定时器；倒计时由提交定时器驱动。
- 另有每 `max(60s, 20×tickSeconds)` 秒一次的安全网评估，**只用于纠正漏掉的事件**（例如在监听器之外启动的后台作业）。
- 开关关闭时**完全停止**：不挂会话监听、不扫描、不设定时器。

### 活跃判定：状态优先，时间兜底

回合/步骤状态 + Agent 运行状态 + jobs + 终端是"状态即忙"；其余靠事件时间在 grace 窗口内判定。深扫（`jobs.list()`、终端）只在"倒计时进行中"或"空闲已达阈值"时执行，并且有三条短路：**事件即证据**（无近期事件/开放步/运行中作业时权威扫描得不到新信息 → 跳过）、**父先子后命中即停**、**日志偏移未变不再探测**。

### 唤醒识别：只信单调时钟

Windows 会合并后台计时器，定时器迟到几秒是正常的。插件同时记录墙钟与 `hrtime` 单调时钟：只有**墙钟前进明显多于单调时钟**（漂移 > 60s）或**迟到 > 120s**，才判定为挂起/唤醒并重置空闲时钟。早期用「迟到 > 5s」判断，实测在虚拟机上把当晚的关机推迟了 3 小时。

### 提交链：先让系统接住，再让 DSH 退场

1. 倒计时结束前 `closeLeadSeconds`（默认 3 秒）进入提交阶段，从此**不可撤销**：
   - 记录时间段消耗（次数减一 / 今天已用 / 临时删除）；
   - **唤醒守卫**：提前约 3 秒启动，拿到 `SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED)` 并写出 marker 后才继续；
   - **Windows**：`shutdown /s /t ceil(剩余秒数)`（上限 = `closeLeadSeconds`）——系统持有截止时间，本进程或 DSH 退出都不影响它；
   - **DSH 不由插件退出**：这条命令本身就是那个"正常退出"——系统在整个会话结束时发 `WM_QUERYENDSESSION` + `WM_ENDSESSION`，Electron 收到后约 1 秒退出（实测），并且 `/t > 0` 隐含 `/f`，应用无法拖住关机。插件因此不持有任何"关掉 DSH"的代码，也就不会在关掉应用之后失去执行能力。
   - **macOS / Linux**：这两个系统没有"保留截止时间的关机命令"，所以等到真正到点再执行（`osascript … to shut down` / `systemctl poweroff`），同样由关机的系统收掉 DSH（`osCounted=false`，状态文件里能看到）。
2. **倒计时跨过休眠/改钟就作废**：提交前检查"提交定时器迟到多久"与"墙钟比单调钟多走多少"。正常提交比截止时间**早**几秒（迟到为负）；一旦迟到 > 5 秒、或漂移 > 10 分钟，说明机器睡过/时钟被拨/进程被冻结 → **取消倒计时并重置空闲时钟**，而不是在用户刚唤醒电脑时关机。
3. 如果命令下达后机器**没有**关掉（有人执行了 `shutdown /a`），12 秒后插件把卡在 `committing` 的倒计时清掉并记录 `lastAbort`。

为什么只把最后 3 秒交给系统：`shutdown /t` 的倒计时按**系统运行时间**计（含睡眠），睡一觉醒来它会立刻执行；把 3 小时倒计时交给它＝"掀开盖子的瞬间关机"。而这 3 秒是"命令已下达"之后，必须短、必须由系统兜住，也就必须锁住休眠。

### 唤醒守卫（防"命令已下达、机器同时睡着"）

- 请求的是 `ES_SYSTEM_REQUIRED`，**不请求 `ES_DISPLAY_REQUIRED`** → 熄屏状态不会被点亮。
- Windows 上它是控制台程序，但用 `Win32_ProcessStartup.ShowWindow = 0`（SW_HIDE）+ `-WindowStyle Hidden` 起，**不闪窗口**；通过 WMI `Win32_Process.Create` 创建，父进程是 `WmiPrvSE.exe`，**不会被 Electron 的 Job 对象连带杀掉**（普通 detached 子进程会），实测创建到 marker 就绪约 1.7 秒。
- **一次性**：请求按线程持有，进程结束即失效，重启后不可能残留；插件启动时还会删掉上次的 `.ps1` / `.cmd` / marker。
- **会被取消**：守卫每 0.5 秒查系统日志里的 **1075（用户中止了关机）**，只认"布防之后"的事件。有人在命令下达后用 `shutdown /a` 取消，守卫**约 1.2 秒内**释放请求，不会白占着让机器醒着。
- macOS 用 `caffeinate -i -t N`，Linux 用 `systemd-inhibit --what=sleep --mode=block sleep N`，都只阻止空闲睡眠。

### 跨平台

`powerActionPlan()` 与 `keepAwakePlan()` 是纯函数（有单测），把"电源指令"和"防休眠指令"按平台分开：

| | 关机 | 防休眠 |
| --- | --- | --- |
| Windows | `shutdown.exe /s /t N`（系统持有截止时间） | PowerShell + `SetThreadExecutionState`（WMI 外部隐藏进程） |
| macOS | `osascript … to shut down`（到点执行） | `caffeinate -i -t N` |
| Linux | `systemctl poweroff` | `systemd-inhibit --what=sleep` |

> Windows 是完整支持并实测过的平台；macOS / Linux 完成了适配但**未在真机验证**。

## 项目结构

```
dsh-idle-shutdown/
├── package.json        # bundle 清单：dsh.bundle.patch、exports、files、locale/icon
├── cordis.patch.yml    # 插入 Host 行 `idle-shutdown`（含默认 config）
├── index.js            # Host 半边：调度、活跃判定、提交链、路由、命令、纯函数
├── client.js           # 浏览器半边：标题栏开关/撤销/进度、长轮询流、locale、slot 注册
├── settings.js         # 设置页（按需加载的分块，由 Host 路由实时提供）
├── locale/en.json      # 插件管理页显示用的标题与描述（英文）
├── locale/zh.json      # 同上（简体中文）
├── icon.svg            # 插件图标
├── verify-clock.ps1    # 校准探针：`shutdown /t` 按墙钟还是单调钟（需管理员）
├── self-test.mjs       # 假 Host 自测（不触碰电源状态）
└── .dsh-idle-shutdown/ # 运行期状态与日志（自带 .gitignore；卸载时整个删除）
```

数据流：

```
Session 事件 ─┐
Agent 状态  ─┼─▶ index.js（Host）─▶ 决策：空闲? 在窗口? ─▶ 倒计时 ─▶ 提交
jobs/终端   ─┘        │                                        │
                      ├─▶ 状态文件 + 持久日志（包内 .dsh-idle-shutdown/） ├─▶ 唤醒守卫（外部隐藏进程）
                      └─▶ /idle-shutdown/state（长轮询）           └─▶ 系统关机命令（DSH 由该关机关闭）
                                  │
                     client.js ───┴─▶ 标题栏按钮/进度、设置页（settings.js 分块）
```

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 条目总开关；`false` 时插件与界面都不加载 |
| `armed` | `true` | 标题栏开关（可热改） |
| `windows` | `[{23:00–07:00, daily, persistent}]` | 时间段白名单（可热改） |
| `idleMinutes` | `30` | 空闲等待；允许小数，最小 `0.05`（3 秒，仅测试），最大 `180`（3 小时）；设置页可改 |
| `warningSeconds` | `60` | 倒计时秒数；`0` 表示立即提交，最大 `1800`（30 分钟）；设置页可改 |
| `closeLeadSeconds` | `3` | 最后几秒交给系统关机命令，也是这几秒的时长（不可撤销窗口）。范围 **3–60 秒**；设置页可改 |
| `tickSeconds` | `15` | 安全网评估间隔下限（实际 = `max(60s, 20×tickSeconds)`） |
| `waitingGraceMinutes` | `10` | 等待用户/审批的回合在无新日志后还能阻止关机多久 |
| `dryRun` | `false` | 只记录、不执行关机（仍会武装唤醒守卫并打印将要执行的命令，适合演练） |
| `logMaxKB` / `logMaxFiles` | `256` / `3` | 持久日志的单代大小与代数上限 |
| `tempMaxAgeMinutes` | `60` | 原子写临时文件的清理阈值 |
| `stateFile` | `''` | 状态文件路径；留空用**插件目录内**的 `.dsh-idle-shutdown/dsh-idle-shutdown-state.json`（目录不可写时退到系统临时目录） |

`action` 仅为兼容旧配置而保留，取值只能是 `shutdown`：这个插件不做重启 / 休眠 / 睡眠 / 自定义命令（`customCommand`、`closeDshFirst`、`forceCloseAfterCommit` 已移除，旧配置里留着也无害，会被忽略）。

示例（`cordis.patch.yml`）：

```yaml
- id: idle-shutdown
  name: dsh-idle-shutdown
  config:
    armed: true
    idleMinutes: 10
    windows:
      - { start: '12:30', end: '13:30', repeat: 'today', persistent: false }
      - { start: '23:00', end: '07:00', repeat: 'count', remaining: 3, persistent: true }
```

## 状态文件与持久日志

`<插件目录>/.dsh-idle-shutdown/dsh-idle-shutdown-state.json`（或 `stateFile`）记录：`version`、`armed`、`monitoring`、`windows`（完整模型）、`inWindow`、`opensInMinutes`、`idleSeconds`、`active`/`activeReasons`、`agents`、`pending`（`phase`、`window`、`remainingSeconds`、`graceSeconds`、`cancelSeconds`、`canCancel`）、`triggerCount`、`lastTrigger`、`lastCancel`、`lastSkip`、`lastConsume`、`lastExpire`、`lastReactivate`、`lastAbort`、`lastAction`、`lastSave`、`lastError`、`stats`、`files`。

持久日志 `<插件目录>/.dsh-idle-shutdown/dsh-idle-shutdown.log` 逐行追加关键时间线（触发 / 取消 / 守卫 / 关机命令 / 冻结判定…），便于事后核对。

卸载时这些文件会被一并删除（见「卸载」）；重载、禁用、重启 DSH 则保留。保留策略：状态文件就地原子覆盖；日志按 `logMaxFiles` 代 × `logMaxKB` 滚动，超限先删最老的一代；崩溃残留的 `*.tmp` 超过 `tempMaxAgeMinutes` 在启动时清理；只匹配本插件自己的文件名，**绝不动同目录的其他文件**。

## 性能设计

- **事件驱动，不轮询**：空闲计时、窗口边界、倒计时各一个一次性定时器；安静时零周期唤醒。
- **事件只做两件事**：更新"最后活动时间"、500ms 防抖后按内容变化落盘；不扫描。忙碌在事件到达时立即生效，离开 grace 后自动过期。
- **两段式扫描**：每 tick 只做便宜判定；jobs 与终端只在必要时机查。
- **状态文件脏写节流**：只有内容真正变化或距上次写入满 60 秒才落盘。
- **精简快照**：只保留活跃 Agent 行（另有计数），并用 `stats` 观察 ticks/writes/serviceCalls。
- **设置页按需加载**：`settings.js` 由 Host 路由按需提供，第一次打开设置页才 `import()`。
- **长轮询按读/写分离版本号**：配置变化与运行态变化互不干扰，设置页不会因空闲抖动重建表单；页面隐藏时等待放长到 60 秒，倒计时期间缩短到 1.5 秒。
- **客户端本地秒针**：不可撤销阶段的进度与剩余秒数由 500ms 本地计时器驱动，不等 Host 推送。

## 平台支持（Windows / macOS / Linux）

**插件本身是纯 Node 代码**：Host 半边只用 `node:fs` / `node:child_process` / 标准定时器，客户端半边是普通 Web 代码，所以在任何 DSH 客户端上都能加载。真正跟系统绑定的是两件事——**关机命令**和**防休眠**——它们由两张按平台分派的表决定（见上文「跨平台」）：

| 平台 | 关机 | 防休眠 | 实测状态 |
| --- | --- | --- | --- |
| Windows | `shutdown.exe /s /t N`（系统持有截止时间） | PowerShell + `SetThreadExecutionState`，WMI 起隐藏进程 | **完整实测**：真机跑过完整关机链、守卫创建/释放、`shutdown /a` 联动 |
| macOS | `osascript -e 'tell application "System Events" to shut down'` | `caffeinate -i -t N`（只挡空闲睡眠，屏幕该灭就灭） | **已适配、未真机验证** |
| Linux | `systemctl poweroff` | `systemd-inhibit --what=sleep --mode=block sleep N` | **已适配、未真机验证** |

macOS 上预期的行为与需要注意的点（未实测，所以按风险顺序列出）：

1. **没有"系统持有截止时间"**：macOS 没有 `shutdown /t` 这类命令，所以命令是在**倒计时真正到点的那一刻**才执行，不存在"最后 3 秒不可撤销"的窗口——倒计时全程可撤销。
2. **可能弹权限框**：`osascript … to shut down` 走 Apple Event，第一次会被「自动化/辅助功能」权限拦一下；用户在首轮需要手动允许。若被拒绝或超时，命令失败 → 插件记 `lastError` 并**保持 DSH 运行**，不会出现"以为关了其实没关"。
3. **`shutdown` 立刻生效**：Apple Event 一旦被接受，系统随即开始关机，DSH 由该关机关闭（`caffeinate` 守卫在到点前已释放，不会拖住）。
4. **状态/日志路径**：默认落在插件目录内的 `.dsh-idle-shutdown/`（macOS 与 Windows 同一逻辑），该目录自带 `.gitignore`，所以在源码检出里运行也不会弄脏 git。
5. Windows 专属代码（`shutdown.exe`、`WM_*`、WMI、`SetThreadExecutionState`）全部由平台判断隔离，在 mac 上不会被调用。

## 限制与已知行为

- **Windows 完整支持并实测**；macOS / Linux 已适配但**未在真机验证**（见上一节的风险点）。
- **DSH 不由插件退出**：关机命令本身就是那个"正常退出"（`WM_QUERYENDSESSION` → `WM_ENDSESSION`，`/t>0` 隐含 `/f`），插件里没有任何关闭应用的代码，因此插件先死也不影响动作，`dsh web` 也不会被误杀终端。
- 提交阶段（最后 `closeLeadSeconds` 秒）不可撤销；用户自己 `shutdown /a` 不算"被撤销"（插件会据此收尾：守卫立即释放、倒计时 12 秒后清掉并记 `lastAbort`）。
- 防休眠只是"不进入睡眠"，不是"锁屏/保持点亮"。
- 只感知 DSH 内部的对话活动，不识别系统级键鼠活动；想临时不关机就点标题栏开关或撤销。
- 插件被卸载时只取消尚未提交的倒计时。
- **虚拟机时钟**：某些虚拟机里 vCPU 被暂停时单调时钟不走、RTC 照走，会被判定为"挂起"（日志会写 `the machine was suspended for 120s (wall clock only)`）。这只会推迟/取消动作，不会误关机；提交侧的阈值（迟到 5 秒 / 漂移 10 分钟）专门为此放宽。

## 开发

```bash
node self-test.mjs     # 假 Host 自测：时间段模型、跳过、消耗、重新激活、平台计划、守卫脚本、冻结判定、状态文件；不触碰电源
```

提交场景会真的启动一次唤醒守卫（Windows 上约 1.7 秒），并断言"先武装守卫、再把最后几秒交给 `shutdown.exe /s /t N`"。

`verify-clock.ps1`（**需管理员**，因为要改系统时钟）用来一次性回答"`shutdown /t` 的倒计时按墙钟还是单调钟"：下达 `shutdown /s /t 120`，**然后**把时钟往回拨 1 小时（不重新下达），等过名义截止时间——机器还活着＝按墙钟（顺延 1 小时），机器自己关了＝按单调时钟。结论写进 verdict 文件，所以即使机器关掉也能事后查看；凡是能存活都会 `shutdown /a` 并恢复时钟。运行探针前请关掉标题栏开关。

## 许可

MIT，见 [LICENSE](LICENSE)。