# 20 — 全仓库状态快照（perf-strike 侦察会话）

快照日期：2026-09-19　产生分支：`perf-strike`（本会话在此分支执行，仅新增本文档）
性质：只读审计 + 状态快照。未修改任何源码、未合并、未推送。供未来任何新会话恢复全局认知。

## 1. master HEAD 与门禁结果

- master HEAD：`3fe1ab0`（= oracle-fixes HEAD = perf-strike HEAD，三支同点）
- npm test：**5 文件 / 60 用例全绿**（version 10、crash-diagnostic 21、net 7、session-state 13、offline-uuid 9）
- npm run typecheck：**0 错误**（tsc --noEmit）
- npm run build：**成功**（main 187.33 kB / preload 12.54 kB / renderer 2,324.75 kB，警告仅 chunk 体积）
- 仓库健康：工作区干净（唯一未跟踪项为根 `nul` 空文件，见 §6），无 stash，无合并冲突。

## 2. 分支地图

| 分支 | 位置 | 归属/性质 | 是否并入 master |
|---|---|---|---|
| master | 3fe1ab0 | 主干 | — |
| oracle-fixes | 3fe1ab0 | 信任修复后的 oracle/update 修复（3 提交，+2 险胜） | **已并入**（fast-forward，reflog HEAD@{7}） |
| perf-strike | 3fe1ab0 | 性能打击任务分支 | **尚未开始**：无任何 perf 提交、无 pMap/parallelDownload 代码、无 20-PERFORMANCE-STRIKE.md（编号现被本文档占用） |
| identity-studio | 3c4be81（+5，领先 master） | 皮肤衣柜：3b73f22 / 14760e6 / 7341f6c / 99485f3 / 3c4be81 | **未并入**（merge-base = c055b98） |
| trust-repair-phase-1-2 | c055b98 | 信任修复 13 提交 | 已并入（master 直接祖先） |
| euphoria-stage-1 | **不存在** | 未开始（未见任何 Stage 1 提交，19 号文档 §6 亦无 Stage 记录） | — |

## 3. worktree 状态

- 主仓库 `mu-launcher`：3fe1ab0 [perf-strike]
- `../ember-identity`：3c4be81 [identity-studio]，status --short 干净，无未提交改动。视为活跃工作区，本会话未触碰。

## 4. 记忆断言核对表 A–L

| 断言 | 结论 | 证据 |
|---|---|---|
| A. master 含信任修复约 13 提交（f86a258..c055b98）；tests/ 五文件 | **确认** | f86a258 起 12 个主题提交 + c055b98 文档收尾 = 13；tests/{version,crash-diagnostic,net,session-state,offline-uuid}.test.ts 齐全 |
| B. master 含 fix(oracle)（白名单 java/sun/jdk/javax、depth 从 1 起）与 fix(update) prerelease 防护 | **确认** | 4cadf4a / b4743ad 在 master；crash-diagnostic.ts:35 白名单含 `'java','javax','jdk','sun'`，:146 `depth = 1` 起；update-checker.ts:62 isNewerVersion 带 prerelease 注释与逻辑 |
| C. master 实际测试总数 | **确认 = 60** | npm test 实跑（见 §1） |
| D. identity-studio 5 提交已并入 master | **不符——未并入** | `git branch --contains 3c4be81` 仅 identity-studio；merge-base = c055b98 |
| E. "force-fetch worn skin on studio entry" 提交 | **不存在** | `git log --all --grep=force-fetch -i` 空；19 号文档的替代方案（getSkin force:true）仍为"留用户决策"未实施 |
| F. perf-strike 分支 / perf 提交 / 20-PERFORMANCE-STRIKE.md | **分支存在但空** | perf-strike=3fe1ab0 与 master 同点，零工作内容；文档不存在 |
| G. ../ember-identity 与 euphoria-stage-1 状态 | **部分确认** | worktree 存在且干净（identity-studio 3c4be81）；euphoria-stage-1 分支不存在、Stage 1 零提交 |
| H. 根 nul 文件 | **确认存在** | 0 字节，Windows 保留名，2026-09-18 10:33 产生，未跟踪，无法 git 追踪 |
| I. master 从未推送 | **确认** | `origin/master..master` = 24 领先 / 反向 0；origin/master 停在 b450754 "Pre-canary stable build" |
| J. SetupView console.log = 0；preload IPC 计数 | **确认** | console.log 0；preload 59 个 invoke 通道 + 7 个 on 事件；含 open-app-data-dir / clear-cache / get-app-metrics / 9 条 skins-*（skins-list/-import/-save-current/-delete/-rename/-set-model/-equip/-reveal/-wearing-hash，随 identity-studio 提交存在于分支） |
| K. prathamsethi.minekeep.gg 仅命中 constants.ts | **确认** | grep 仅 src/shared/constants.ts:7 |
| L. package.json test 脚本 + vitest devDependency | **确认** | "test": "vitest run"（:13）；"vitest": "^5.0.1"（:53） |

注（断言 J 口径）：主仓库当前不含 19 号文档所述的 identity-studio 侧改动；skins-* 通道属于未合并分支。

## 5. 文档清单与遗留决策摘录

docs/project-truth/（18 号有双文件）：01-ARCHITECTURE（架构）、02-FILE-MAP（文件地图）、03-IPC-MAP（IPC 面）、04-STATE-OWNERSHIP（状态所有权）、05-CONTRACTS（契约）、06-AUTH-IDENTITY（账户双系统）、07-LAUNCH-PIPELINE（启动管线）、08-IGNITION（点火）、09-SKIN-ANIMATION（皮肤动效）、10-VISUAL-ARCHITECTURE、11-UI-ARCHITECTURE、12-PERSISTENCE（持久化）、13-EXTERNAL-DEPENDENCIES（外部依赖）、14-LIFECYCLE（生命周期）、15-VERIFICATION（验证）、16-HISTORY-RECONCILIATION（历史对账）、17-KNOWN-RISKS（已知风险）、18-PRODUCT-INVARIANTS / 18-TRUST-REPAIR-LOG（信任修复轮日志）、README、model/（9 个 json）。AGENT-HANDBOOK.md 与 DESIGN.md 均在根目录。

- **18-TRUST-REPAIR-LOG**：无未确认/需决策项（六项指控全部修复并验证）。
- **19-IDENTITY-STUDIO（identity-studio 分支）§6 未确认/需决策**（4 条，均未解决）：
  1. equip 成功路径未做运行时验证——需真实 Microsoft 会话（真机 401→refresh→retry 只有用户能验）。
  2. "active" 判定依赖 24h 皮肤缓存，launcher 外改皮肤可能滞后至多 24h；可改 `getSkin(accountId,{force:true})`（代价：进 Studio 每次 Mojang 往返）——留用户决策。
  3. 皮肤 id 用 `node:crypto` randomUUID，未沿用既有 id 生成入口，如需统一要一处小改。
  4. 根 `nul` 文件（Windows 保留名）无法 git 追踪，遗留待清理。

## 6. 遗留与风险（严重度降序）

1. **identity-studio 5 提交未并入 master**——功能完整（皮肤库+IPC+IdentityView 重构+22 测试+文档），但 master 的 60 测试不含其 22 用例。合并时需先 rebase 跨过 oracle-fixes 的 3 提交，tests/ 无重叠文件，预期无冲突。
2. **master 领先 origin 24 提交从未推送**——单点风险，历史只存在于本机。
3. **Hermes 协作期望落空**——任务单预判的 ../ember-identity "euphoria-stage-1 仪式层" 并不存在；worktree 只有已完成的 identity-studio。euphoria-stage-1 分支未创建，Stage 1 零提交。协作状态需向 Hermes/用户澄清。
4. **根 `nul` 空文件**——Windows 保留名，无法 git 追踪，会永久挂在 untracked 列表；需用 `rm //./nul` 类手段删除（本会话只读，未动）。
5. **identity-studio §6 的 4 条未决项**（见 §5）——equip 真机验证与缓存强一致决策在合并前最值得处理。
6. **文档漂移**——19 号文档及 skins-* IPC 只存在于分支；master 侧无任何 identity-studio 记录；20 号编号此前无人认领（perf-strike 从未开始），本快照占用。
7. **死亡会话残留**——无：无 stash、无合并中断、无半成品文件；reflog 显示最后操作为本会话 checkout perf-strike。

## 7. 路线图盘点

| 项 | 状态 | 依据 |
|---|---|---|
| 性能打击（pMap 并行 + 流式写入 + .mrpack 并行导入） | **未开始** | perf-strike 分支空，无 pMap/parallelDownload 代码 |
| Presence 阶段（服务器状态/人数通知/新闻） | **未开始** | 无 presence 主进程模块；WorldBeacon 仅 UI 存在性暗示 |
| 模组依赖解析（fabric.mod.json depends） | **未开始** | mod-downloader 无 depends 逻辑 |
| Afterglow（截图/会话记忆） | **未开始** | 全仓 grep 零命中 |
| Setup 去 slop | **未开始** | 文档/代码无该轮记录；SetupView 本身已在信任修复轮接线 |
| Euphoria Stage 1 | **未开始** | euphoria-stage-1 分支不存在，零提交 |
| Euphoria Stage 2–4 | **未开始** | 依赖 Stage 1 |
| equip 真机验证 | **未开始**（19 号 §6.1，需用户登录） | 需真实 Microsoft 会话 |
| 服务器 query protocol 询问（外部） | **未知**（无内部记录可考） | 未见于任何 truth 文档 |
| 推送 GitHub | **未开始** | master 领先 origin 24 提交 |
| 用户 eyeball 测试 | **未知** | 无验收记录 |

## 8. 指向既有日志

- 信任修复轮全记录：`docs/project-truth/18-TRUST-REPAIR-LOG.md`
- 皮肤衣柜全记录（未并入 master）：identity-studio 分支 `docs/project-truth/19-IDENTITY-STUDIO.md`
- oracle 修复附录：`3fe1ab0` 提交信息及其文档 diff（oracle-fixes addendum）
