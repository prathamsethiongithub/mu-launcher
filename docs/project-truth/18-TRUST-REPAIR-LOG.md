# 18 — 信任修复 + 测试保险日志

分支：`trust-repair-phase-1-2`（自 master `65b54ad wip: checkpoint` 起）
日期：2026-09-19
执行：每项指控先在源码中验证（铁律 1），绿灯（typecheck + build，Phase 2 另加 npm test）后才提交（铁律 5）。

## 1. 结果表

| 任务 | 状态 | 触及文件 | commit | 证据（关键代码行原文引用） |
|---|---|---|---|---|
| 1. SetupView 假按钮 | 已修复 | src/renderer/components/SetupView.tsx, src/main/index.ts, src/main/launch-service.ts, src/shared/types.ts, src/main/world-manager.ts, src/preload/index.ts, src/env.d.ts | `f86a258` | 修复前：`onClick={() => console.log('open dir')}`、`console.log('cache cleared')`、硬编码 `2.3 GB on disk`。修复后：`grep -c "console.log" SetupView.tsx` = **0**；新增主进程 handler `open-app-data-dir`（`shell.openPath(app.getPath('userData'))`）、`clear-cache`（仅删 `{userData}/skins` 与 `{userData}/minecraft/cache`，绝不触碰 worlds/、identity、token）、`get-app-metrics`（真实异步遍历，模式取自既有 get-world-metrics）；分辨率经既有 `update-world-settings` 通道持久化（World 类型新增可选 `resolution` 字段），launch 时传给 MCLC `window: { width, height }` |
| 2. .mrpack files[] 下载缺失 | 已修复 | src/main/modpack-installer.ts, src/main/index.ts, src/renderer/components/WorldsView.tsx, src/preload/index.ts, src/env.d.ts | `371e2ba` | 修复前仅有 overrides 提取。修复后新增 `installModpackFiles`（L334），E-code 全套：`[E701]` index 缺失/损坏、`[E702]` 路径不安全（拒绝 `..`/绝对路径/盘符）、`[E703]` 下载失败（含该文件 path）、`[E704]` 哈希不匹配（`await rm(tmp); throw` — 不静默保留）。复用 `net.ts` `downloadGuard`/`readWithStallGuard` + createHash（sha1/sha512）；`env.client == "unsupported"` 跳过；URL 候选数组按序尝试 |
| 3. WorldManager 伪写锁 | 已修复 | src/main/world-manager.ts | `ab37f4e` | 修复前（git show f86a258）：`while (this.writeLock) { /* Spin-wait is safe here… */ }`。修复后 L725-730：`private save(): void {` + 注释 *"No lock is needed: JS runs this single-threaded and the write below is synchronous, so two saves can never interleave."*。调用点（renameWorld/updateWorldSettings/deleteWorld/setActiveWorld/createWorld）均为同步方法，无异步并发证明 → 按任务单默认答案直接删除，未引入 promise 链。`grep -c "writeLock"` = 1（仅剩说明性注释，无代码） |
| 4. SMP 地址四处硬编码 | 已修复 | src/shared/constants.ts（新增）, src/main/server-injector.ts, src/main/tray-manager.ts, src/main/world-manager.ts, src/renderer/components/PlayView.tsx | `df07d42` | 四处字面量**完全一致**（无需 NEEDS DECISION）：`'prathamsethi.minekeep.gg'` + `25565`。现唯一定义于 `src/shared/constants.ts`：`export const SMP_SERVER_HOST = 'prathamsethi.minekeep.gg'; export const SMP_SERVER_PORT = 25565;`。`grep -rn "prathamsethi.minekeep.gg" src/` 仅命中 constants.ts。**注意**：src/main/server-pinger.ts 中另有一处 `25565`，语义是 Minecraft ping 协议的通用默认端口（防御性 fallback），不属于指控的四处，未改动 |
| 5. IPC 地图文档漂移 | 已修复（仅文档） | docs/project-truth/03-IPC-MAP.md | `fb6f793` | 重写对齐 preload 实际面：`grep -c "ipcRenderer.invoke(" src/preload/index.ts` = **59** 个 invoke 通道（原文档记 42），另列 ipcRenderer.on 事件通道（updater 的 `update-*`）。逐一核对主进程 `ipcMain.handle(` 注册（`perform-mod-update` 为多行注册，实为匹配）；`get-installed-versions`/`mod-download` 标注为主进程独有、renderer 不可达 |
| 6. 死代码清理（可选） | 已修复 | src/main/java-provisioner.ts | `e74c350` | `grep -rn "extractZip" src/` 零引用（AuthView.tsx 已不存在于磁盘，仅文档提及）；删除带 eslint-disable 的 private 方法 |

## 2. Phase 2 — 纯逻辑测试（保险层）

### 2.1 基建（`2552c1d`）

- 安装 **vitest 5.0.1**（devDependency，本次唯一新增依赖），`package.json` 新增 `"test": "vitest run"`。
- `vitest.config.ts`：node 环境，`include: ['tests/**/*.test.ts']`，无 jsdom、无 Electron mock。
- 无损提取（行为零变化，签名不变的导出化）：
  - `update-checker.ts`：`isNewerVersion` 由模块私有改为 `export`。
  - `crash-diagnostic.ts`：`detectReason` / `detectModName` / `prettifyModId` 由模块私有改为 `export`。
  - `identity-service.ts`：提取模块级纯函数 `isSessionExpired` / `sessionDecision` / `removalCleanupScope` / `generateOfflineUUID`，类方法改为委托，单一生产调用点不变。

### 2.2 测试提交

| 测试 | 文件 | commit | 用例数 | 覆盖要点 |
|---|---|---|---|---|
| 1 版本比较 | tests/version.test.ts | `4c46f8c` | 9 | 相等、0.6.13>0.6.9、跨大版本、1.2 vs 1.2.0 零填充、非数字段字符串 fallback、不可解析对的不等式 fallback |
| 2 Oracle 归因 | tests/crash-diagnostic.test.ts | `d9995b7` | 20 | Caused by（verbatim/截断/OOM）、Mixin→modid 映射、Mod file jar 版本尾剥离、白名单帧不误报、mixin 信号优先、空/极短/二进制垃圾不抛异常 |
| 3 会话状态机 | tests/session-state.test.ts | `7b7cd72` | 13 | 恰好相等=过期、±1ms 边界、远期、缺 expiresAt、offline 恒有效、microsoft 无 refreshToken=重新登录、remove 守卫三开关 |
| 4 离线 UUID | tests/offline-uuid.test.ts | `3224806` | 9 | node:crypto 独立重算金标（3 名字）、同名稳定、版本位 nibble=3、变体位 ∈{8,9,a,b}、不同名不同、≠裸 MD5 |
| 5 net.ts 守卫 | tests/net.test.ts | `14eb3b2` | 7 | E220/E221/E222 超时与消息、headersReceived() 取消连接计时、stall 竞态确定性（E222 先于 AbortError settle）、fake timers、无真实 socket |

（vitest.config.ts 随测试 1 的 commit `4c46f8c` 一并入库。）

### 2.3 现状如此，疑似 bug（未顺手改生产代码，按任务单要求只记录）

1. **`isNewerVersion` 把 prerelease 判为比 release 新**。`isNewerVersion('1.2.3-beta', '1.2.3') === true`：非数字段 fallback 中 `'beta' > ''`（缺失段零填充为空串），带 `-beta` 后缀即"更新"。后果：稳定版安装可能被 Modrinth 列表上的 prerelease 触发升级。建议方向：比较前剥离/单独处理 prerelease 段，或依 Modrinth `version_type` 判定。tests/version.test.ts 中以 `现状如此，疑似 bug` 标注。
2. **`detectModName` 对 JDK 帧误报模组名**。深度循环 `for (let depth = 2; …)` 从 2 段开始，`NON_MOD_PACKAGES` 中的单段根（`java`、`sun`、`jdk`）永远不被检查：`\tat java.lang.Thread.run(…)` → 归因 `Lang`。任何只含 JDK 栈帧的日志都会得到错误归因。建议方向：循环从 `depth = 1` 起。tests/crash-diagnostic.test.ts 中以 `现状如此，疑似 bug` 标注。
3. **`isSessionExpired` 对不可解析的 expiresAt 静默判"未过期"**。`now >= NaN === false`。实际写入恒为 toISOString，风险低，但已用测试钉住（tests/session-state.test.ts）。

### 2.4 未覆盖之处（如实记录）

- `diagnoseLastCrash`（fs 绑定：readdir/stat/readSync over crash-reports/）不在任务单指定函数清单内，未测。
- net.ts 真实 socket 路径（真实 fetch/流式读取成功路径）未测——按任务单不为测试搭建网络 mock 脚手架。
- IdentityService 类内 fs/safeStorage 路径（loadState/saveTokens/refreshMicrosoftSession）非纯逻辑，未测。

## 3. 绿灯记录

- 每个 commit 前：`npm run typecheck`（tsc --noEmit，0 错误）+ `npm run build`（electron-vite，✓ built）。
- Phase 2 最终：`npm test` → **Test Files 5 passed (5)，Tests 58 passed (58)，Duration 1.00s**。

## 4. 遗留与备注

- `nul` 文件（仓库根，Windows 保留名）无法被 git 追踪（`git add` exit 128），留在未跟踪状态；对构建无影响，建议人工删除（文件系统 API 才能删）。
- 无 未确认 / 受阻 / 需决策 项：六项指控全部在源码中验证属实并修复。
