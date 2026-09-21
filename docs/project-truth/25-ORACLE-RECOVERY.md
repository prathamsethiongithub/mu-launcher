# 25 · Oracle Recovery：免疫系统的第三器官（归因 → 一键修复闭环）

> 前作：[24-QA-ASSAULT](./24-QA-ASSAULT.md)（Oracle 归因 + 语料体系）。
> 本篇记录修复动作闭环：归因结果 → 既有管线 → 修复后重启动线。

## 1. 三原则（设计已定，实现遵守）

1. **诚实优先** — 归因为 `undefined` 时**永不**显示修复按钮，只显示
   `couldn't name this one. details in the console.` + 控制台入口。
   "无法归因"的用户得到的是诚实与证据入口，不是虚假的希望。
2. **零新管线** — 三条修复路径全部消费既有 IPC handler，本任务只做
   归因→动作的**映射层**与 UI。未新写任何文件/内存直接改写逻辑。
3. **修复即仪式（轻量）** — 与 equip 仪式同语言：执行中禁用 + 轻脉动
   （`.oracle-fix-busy`，与 equip in-flight 同款 animation），成功后按钮
   消失 + 一行小写确认 + `relaunch?`。不搞全屏庆祝。

## 2. 决策表（src/shared/oracle-recovery.ts，全部 vitest 覆盖）

| 归因 | 已装匹配 | 有更新 | 可用动作 |
|---|---|---|---|
| modName=X（mixin/解析类） | 是 | 是 | `update-mod` + `remove-mod` + `open-console` |
| modName=X | 是 | 否 | `remove-mod` + `open-console` |
| modName=X | 否（外部来源） | — | `open-console` only，文案 "named a mod you don't have installed. details in the console." |
| OOM 类 reason | — | — | `adjust-memory` + `open-console` |
| undefined | — | — | `open-console` only，"couldn't name this one. details in the console." |

置信度级联：具体模组名 > OOM > unknown。低置信加 `might be` 前缀（诚实降级）。
文件名匹配走 `cleanModName` 归一化（去扩展名、分隔符折叠、大小写折叠）——
Oracle 返回的 "Corrupted Mod" 类人话名能映射回真实 jar 文件名。

## 3. 接线清单（动作 → 既有 handler）

| 动作 | 既有 handler（零改动） | 挂点证据 |
|---|---|---|
| `update-mod` | `perform-mod-update`（ModManagerModal 既有更新流） | src/main/index.ts |
| `remove-mod` | `mod-delete`（mod-manager 删除 handler） | src/main/index.ts |
| `adjust-memory` | `update-world-settings`（ramAllocation 既有路径） | src/main/index.ts |
| `open-console` | App `openConsole(sessionId)` — 打开控制台并**预载崩溃会话**（"show evidence" 载荷） | src/renderer/App.tsx |
| `relaunch?` | 既有 launch-game 流程（PlayView 本来就有） | src/renderer/components/PlayView.tsx |

context 组装：`mods` 来自 PlayView 既有 world mod 列表；`modVersions` 来自
`check-mod-updates` 产物（update-checker），无网络时为空 → 自然退化为 remove+console。

## 4. UI（Phase C）

落点：PlayView 既有 `crashWarning` 横幅（hero 词与 sub-line 之间），未新建视图。
动作按钮横排：amber 实心主动作 + 文字次级动作，与 equip 仪式按钮同语言但克制。
执行中 `.oracle-fix-busy`（脉动），成功后动作区被确认行替换：
`updated Sodium. relaunch?` / `removed it. relaunch?` / `memory raised. relaunch?`。
失败人话：`couldn't reach modrinth. nothing changed.`（状态零变化）。

## 5. 语料补强（Phase D）

侦察结果：Modrinth 上**Fabric API 自身不可作依赖主角**（依赖场景需要
"被依赖者"，Fabric API 正是被依赖者本身）。选择 **lithium**（mc1.21.1，
fabric，当前维护、明确 requires fabric-api）作为依赖场景新主角，替换失效的
sodium 0.9.2 场景。生成器场景配置已更新，语料已重生成（其他场景未动）。
Oracle 冒烟：依赖场景 modName 正确归因 lithium。

## 6. 验证矩阵

| 门禁 | 基线 | 现状 |
|---|---|---|
| typecheck | ✓ | ✓ |
| build | ✓ | ✓ |
| 单测 | 243/243 | **267/267**（+24：决策表全行 + 边界 + 大小写归一 + undefined 红线） |
| E2E | 12/12 | **15/15**（+3：remove 真删 jar、memory 真改 RAM、undefined 永无修复按钮） |

E2E 三契约（tests/e2e/oracle-recovery.spec.ts，真应用 + throwaway 世界）：
1. matched-mod：修复按钮渲染，`remove it` 经真实 `mod-delete` 删除真实 jar；
2. OOM：`give it more memory` 经真实 `update-world-settings` 改 RAM 落盘；
3. undefined：无任何修复按钮，只有诚实行 + show evidence。

## 7. 铁律遵守记录

- fx/、设计系统、既有 IPC 通道名与载荷：零改动（diff 仅映射层 + PlayView 挂点 + 样式一条）。
- undefined 永不修复：决策表 + E2E 双重守卫。
- 修复动作不绕过管线：mapDiagnosisToActions 只产出动作描述，执行全走既有 IPC。
- 文案全部小写，与 "couldn't reach mojang. nothing changed." 同语感。
