# 19 — Identity Studio：私人皮肤衣柜（identity-studio 分支）

日期：2026-09-19　分支：`identity-studio`（自 master `c055b98` 起，git worktree `../ember-identity`）
并行说明：主仓库同时有 `oracle-fixes` 分支在工作。本次全程在 worktree 中进行，未触碰主仓库、未做任何合并。

## 1. 结果表

| 任务 | 状态 | 触及文件 | commit | 证据（关键代码行原文引用） |
|---|---|---|---|---|
| A1 皮肤库注册表 + 哈希去重 + PNG 校验 + slim 启发式 | 已完成 | src/main/skin-library.ts（新） | `3b73f22` | 原子写：`writeFileSync(tmp, …); renameSync(tmp, this.registryPath)`；去重：`const existing = registry.skins.find((s) => s.hash === hash); if (existing) return { status: 'duplicate', … message: `already in your library as '${existing.name}'` }`；尺寸：`if (width === 64 && height === 64) … if (width === 64 && height === 32)`；损坏退化：`catch { return { schemaVersion: 1, skins: [] }; } // corrupt → fresh, never fatal` |
| A3 纯逻辑测试 | 已完成 | tests/skin-library.test.ts（新，22 用例） | `14760e6` | 覆盖：sanitize（控制字符/40 截断/空默认）、sha1 金标（空 buffer = `da39a3ee…`）、PNG 尺寸（64×64 ✓ / 64×32 ✓ / 64×48 ✗ 含尺寸回显 / 非 PNG / 截断）、slim 启发式（4px 臂列透明→slim；RGB 无 alpha→classic；64×32→classic；垃圾输入→classic 不抛）、registry normalize（坏条目剔除、错版本→全新）、导入→去重→改名→换模型→装备标记→删除（注册表+文件同消失）→tmp 不残留 |
| A2 IPC 通道（全部新增） | 已完成 | src/main/index.ts, src/preload/index.ts, src/env.d.ts | `7341f6c` | 新通道 9 个：`skins-list / skins-import / skins-save-current / skins-delete / skins-rename / skins-set-model / skins-equip / skins-reveal / skins-wearing-hash`；`skins-list` 每条附 `dataUrl`（`dataUrl = data:image/png;base64,…`，文件缺失→null→卡片 "missing"）；导入走 select-skin-file 托管路径（`if (!pendingSkinPath) return … 'Choose a skin file first.'`）；`skins-equip` 离线明确拒绝：`code: 'offline', error: 'Offline accounts can’t wear custom skins — skins live on your Microsoft account.'` |
| B IdentityView 重构 | 已完成 | src/renderer/components/IdentityView.tsx（重写）, src/renderer/components/fx/SkinViewerCanvas.tsx（用户授权的最小改动，见 §3） | `99485f3` | 账户横条：`avatar + username + connected/offline/signed out + Sign out + remove(inline confirm) + ‹ n/M › 切换`；hero 文案：`same game. different you.`；拖拽旋转：`viewer.controls.enableRotate = enabled` + `interactive ? '' : 'pointer-events-none'`；货架 2D 头像：`ctx.drawImage(img, 8, 8, 8, 8, 0, 0, canvas.width, canvas.height)`（无 three.js 实例）；active 诚实标记：`const isActive = skin.hash === wearingHash && !!wearingHash`；内联确认删除：`delete? yes / no`；就地重命名（点名字变输入框）；`[ + add ]` 虚线卡 `"add a skin"` |
| C 边缘态 | 已完成（随 B 落地） | 同上 | 同上 | equip 三态：busy `contacting mojang…` / ok `wearing it now.` / fail `couldn’t reach mojang. nothing changed.` 且失败零状态变化（`return; // zero state changes on failure`）；文件缺失卡：`missing` 占位 + hero 提示 `this skin’s file is missing — delete it and re-add.`；重复导入提示：`already in your library as 'X'`；删除 equipped 项：hero 回落账户皮肤（`if (previewId === skin.id) setPreviewId(null)`）+ active 标记随之消失；持久化：skins.json tmp+rename + skins-library/<id>.png，重启即如初 |

## 2. 复用清单（未重写的既有系统）

- **equip 全链路 = 既有 `identity-service.uploadSkin`**（Minecraft services API + FormData/Blob、401→`refreshMicrosoftSession`→重试、成功后 `skinService.putCache` 即时上屏）。skin-library 只提供文件路径，零上传逻辑重写。
- **worn-skin 解析 = 既有 `skinService.getSkin`**（Mojang session server → Crafatar 回退 → 24h 磁盘缓存）。`skins-wearing-hash` 只是对其结果做 sha1。
- **文件选择 = 既有 `select-skin-file` 主进程托管**（pendingSkinPath 不出主进程）；`skins-import` 消费该托管路径。
- **角色渲染 = 既有 `SkinViewerCanvas` + `PlayerDirector`**（一次创建、永不重建 animation 实例；onShown() 首帧 GREETING；窗口级 gaze 监听）。视线跟随为既有能力，本次零改动。
- **账户系统 = 既有 IdentityService/AuthService 双系统 + auth-changed 事件**，边界未动；账户登出/移除/切换/新增全部复用原 handler。
- 动效全部走既有 token（`duration-micro`=120ms、`ease-exit`、`.rise`）；无新增 CSS 类、无新依赖。

## 3. 边缘态清单

| 边缘态 | 行为 |
|---|---|
| equip 网络失败 | `[equip.fail]` 人话句子 "couldn’t reach mojang. nothing changed."，hero 与货架零变化，可重试 |
| equip 会话过期 | uploadSkin 内部 401→refresh→retry；不可恢复时原样返回错误文案 |
| 离线账户 | 装备按钮不可用（返回 `code:'offline'`），hero 明示原因；货架浏览/导入/删除不受限 |
| 重复导入 | sha1 命中 → 返回既有条目 + "already in your library as 'X'"，不产生第二个文件 |
| 库文件丢失/损坏 | 卡片头像位显示 "missing"，equip 返回 `code:'missing'`，可删除清理 |
| 删除 equipped 皮肤 | 账户真实皮肤不受影响；hero 回落账户皮肤态，active 标记消失 |
| 多皮肤 | 横向滚动货架；名称可重复（id 为键） |
| 重启 | skins.json（schemaVersion:1，tmp+rename 原子写）+ skins-library/ 全量恢复；registry 损坏时降级为空库并自愈（不抛异常） |
| slim 判定不确定 | RGB 无 alpha / 64×32 / 解码失败 → 默认 classic，卡片/hero 提供 `switch to …` 一键改 |
| 账户切换 | equipped 语义按账户重新推导（hash 对比），预览重置为账户皮肤 |

## 4. 用户补充设计（Phase B 执行时并入，均落实）

1. hero 文案 "same game. different you."（小写，兼空状态语感）✓
2. 拖拽旋转：skinview3d 原生 OrbitControls，`interactive` prop 最小启用；首次显示 "drag to rotate"，首次拖拽后永久淡出（localStorage）；视线跟随不变 ✓
3. 货架卡片内显示小写皮肤名 ✓
4. 无方向按钮行 ✓
5. Phase A 数据层未因补充而改动 ✓

## 5. 冲突与授权记录

- **fx/ 禁改区 vs 拖拽旋转**：任务单规定 fx/ 只读；用户后补设计明确要求"为现有 SkinViewerCanvas 启用 orbit 旋转（改动应极小）"。按用户最新指令执行，改动限于：`interactive`/`onOrbitStart` 两个带默认值的可选 prop、`enableRotate` 翻转、wrapper 的 pointer-events 条件化、OrbitControls `start` 监听。Play 路径默认值不变（行为零变化）。
- **SavedSkin 增加 `hash` 字段**：任务单的字段清单没有它，但 sha1 去重与 "active 诚实化" 都依赖按内容寻址；schemaVersion 仍为 1（新增字段为必须项）。
- **新增 IPC 通道 `skins-save-current`**：任务单通道清单外，但空状态 "save this skin to your library" 主操作需要它（把账户当前皮肤入库）。全部通道均为新增，未动既有通道。

## 6. 未确认 / 受阻 / 需决策

1. **equip 成功路径未做运行时验证**：需要真实 Microsoft 账号会话（uploadSkin 走 Minecraft services API）。离线账号路径与所有失败分支已由代码审查覆盖；真机 401→refresh→retry 只能由持有有效会话的用户验证。
2. **"active" 判定依赖 24h 皮肤缓存**：`skinsWearingHash` 走 `skinService.getSkin`（缓存优先）。若用户在 launcher 外改皮肤且缓存未过期，hash 可能滞后至多 24h。如需强一致可改为 `getSkin(accountId, { force: true })`（代价：每次进入 Studio 一次 Mojang 往返）——留用户决策。
3. **`import { randomUUID } from 'node:crypto'`** 用于皮肤 id —— 未沿用任何既有 id 生成器（identity-service 的 UUID 是离线账户语义）；如仓库希望统一 id 生成入口，需一处小改。
4. **`nul` 文件**（仓库根，Windows 保留名）仍在，无法 git 追踪；见 18 号文档遗留备注。
