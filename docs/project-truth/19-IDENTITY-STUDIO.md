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

---

# Stage 1 — Ritual Layer（Euphoria 1/4）

分支：`euphoria-stage-1`（自 identity-studio HEAD `3c4be81` 起；按用户指令 C，**不从 master 分支、完成后不并入 master**）。
前置偏差已获用户授权（选 C）：master 未并入 identity-studio，故分支基点是 identity-studio；其上的预备 commit `28c7d3a`（决策项 2 落地）先于分支创建。

> **🔊 音效否决提示（显著标注）**：货架/装备的程序化音效**默认开启**（WebAudio 合成，零素材零依赖，音量贴地：equip swell ≤250ms / gain 0.12，tick ≤60ms / gain 0.06）。要关掉只需说 **"音效关掉"**——我会把 `src/renderer/studio-audio.ts` 顶部的 `STUDIO_SOUND_ENABLED` 置 false，一行提交。

## 1. 结果表

| 任务 | 状态 | commit | 证据（关键代码/行为） |
|---|---|---|---|
| 前置：force-fetch worn skin（决策项 2 落地） | 已完成（identity-studio 上） | `28c7d3a` | `getSkin(accountId, { force: true })` + 注释 *"the 'active' mark must reflect the skin the account is wearing RIGHT NOW, not a 24h-cached snapshot"* |
| 纯逻辑测试先行 | 已完成 | `fed7bfb` | tests/studio-ritual.test.ts：formatWearingSince 6 分支（today/yesterday 含本地午夜边界/星期/日期/clamp 未来）、Mirror 门（恰 6h 触发、差 1 分钟不触发、会话内不重复、首访不触发）、isFirstSkin（仅 0→≥1）、classifyStudioVisit 全分支（含空=pleasure、未知动作忽略） |
| 任务 1 "wearing since" | 已完成 | `b2a64e4` | hero 名字下 `formatWearingSince(Date.parse(wornEntry.lastEquippedAt))`；仅当未预览且库内 worn 条目存在 `lastEquippedAt` 才显示（`wornEntry = wearingHash ? skins.find(s => s.hash === wearingHash) : null`）——不猜、缺失不显示 |
| 任务 2 Mirror Moment | 已完成 | `b2a64e4` | `hasReturnedAfterAbsence(last, now, mirrorShownThisSession)` 通过 → `setMirrorEpoch(e => e+1)`（hero 以 `key={mirrorEpoch}` 重挂载 → 既有 onShown() GREETING 波浪，与 equip 同一公共入口）+ `hey, <username>.` 5s 淡出；`lastVisit` 本地持久化（localStorage），模块级 `mirrorShownThisSession` 保证每会话最多一次 |
| 任务 3 首件皮肤仪式 | 已完成 | `b2a64e4` | import / save-current 成功路径捕获 beforeCount → `isFirstSkin(before, after)` → GREETING（同上重挂载）+ `"saved. first of many."`（ember 色）+ 首卡弹性入场（先 `scale-95 opacity-0`，双 rAF 后翻至 `scale-100`，走既有 120/300ms + ease-exit）——仅 0→≥1 触发一次，此后永不 |
| 任务 4 货架手感 | 已完成 | `b2a64e4` | 卡片 hover：`hover:-translate-y-1 hover:rotate-[1.2deg]`（120ms micro）；选中环：`border-ember/60` 已带 duration-micro 过渡；active 下划线：`scale-x-0 → scale-x-100` + `origin-left` + `duration-300 ease-exit`（既有缓动的软落位）；纯 transform/CSS，零新变量，布局结构未动 |
| 任务 5 微音效 | 已完成（默认开启，待否决） | `b2a64e4` | src/renderer/studio-audio.ts：equip swell `gain.linearRampToValueAtTime(0.12)` 250ms；tick `0.06` 60ms；`ctx.resume().catch()` + `if (ctx.state !== 'running') return null`（挂起静默跳过）；全部 try/catch 包裹，绝不抛错 |
| 任务 6 愉悦传感器 | 已完成（本地私有） | `b2a4e4`→`b2a64e4` | 挂载读取 lastVisit/写 visit 戳；动作经 `recordAction()` 入 ref；unmount 时 `classifyStudioVisit(actions)` 分类并追加到 `identity-studio-visit-log`（本地 localStorage，上限 200 条，无网络、无 UI 展示） |

## 2. 传感器说明（NSM）

- 数据形态：`[{ ts, kind: 'pleasure'|'task'|'mixed' }]`，仅存于本机 localStorage（`identity-studio-visit-log`，滚动保留 200 条）。
- 语义：pleasure = 衣柜互动（equip/导入/保存/改名/换模型）或纯浏览；task = 删除/显示文件夹；mixed = 混合。未知动作不猜测。
- **永不离开本机**：无网络上传、无遥测、无 UI 展示；仅作为未来 NSM 统计的本地原料。
- 已知边界：传感器按"组件挂载周期"记一次访问——若用户在 Studio 内停留期间导航再返回，会记为两次访问（React unmount 语义），NSM 分母略偏大；保持现状，未做会话级去重（如需可后续把日志窗口改为会话键）。

## 3. 绿灯

- 每个 commit 前：`npm run typecheck` ✓ + `npm run build` ✓（✓ built）。
- 最终：`npm test` → **Test Files 7 passed (7)，Tests 99 passed (99)**（Stage 1 新增 19 用例：80 → 99）。

## 4. 遗留与备注

- **未自行合并 master**：按用户指令 C，工作停在 `euphoria-stage-1`；合并由用户在主仓库审计后统一执行。
- fx/ 改动累计（均经用户授权）：`interactive`/`onOrbitStart`（Studio 轨道旋转）——Stage 1 未再触碰 fx/（Mirror Moment 通过 key 重挂载走公共 onShown 入口）。
- `firstInId` 双 rAF 翻转依赖浏览器合成帧；reduced-motion 下入场仍可用（transition 被全局关闭，皮肤立即可见）。
- 无 NEEDS DECISION 新增项。

---

# Stage 1 补遗 — equip 全应用同步修复（用户真机报告缺陷）

现象（真机）：Studio equip 成功（"wearing it now."，Mojang 上传成功），返回 Play 视图皮肤仍是旧值。
commit：`a3296e8`（fix(skins): propagate equip across views via cache write-through and skin-changed event）

## 根因核实表

| 假设 | 成立？ | 证据（行号以 euphoria-stage-1@a3296e8 前的父提交为准） |
|---|---|---|
| A. skins-equip 成功路径未写透 24h 缓存 | **不成立** | identity-service.ts L507-510：uploadSkin 成功路径**已**调用 `this.skinService.putCache(account.uuid, skinData, skinModel)`，skinData 即所装备库文件字节（skinPath = skins-library/<id>.png）。唯一缺口：`account.uuid` 缺失时跳过 putCache（L508 三元守卫）——已由新增显式写透补上 |
| B. 无"皮肤已变更"事件广播 | **成立** | 修复前 `grep skin-changed src/main/index.ts` = 0 命中；notifyAuthChanged（L272）只广播 auth 数据 |
| C. keep-alive 导航内存停留 | **成立（主因）** | fx/PlayerIdentity.tsx L29-49：`useEffect(…, [])` 空依赖——getSkin 仅挂载时取一次并存入组件 state；Play 视图为 keep-alive（SkinViewerCanvas L196-200 注释明确 display:none 切换不卸载），故 equip 后 hero 内存中的 dataUrl 永不更新 |

## 修法（三处）

1. **写透补强**（index.ts skins-equip 成功路径）：`new SkinService().putCache(uuid, bytes, model)` 显式写透库文件字节——覆盖 uploadSkin 的 uuid 缺失缺口，字节与 uploadSkin 内部写透完全一致，零网络。判定走纯函数 `shouldWriteThroughCache(uuid)`（uuid 非空才写）。
2. **广播**：`notifySkinChanged(accountId, model)`（复用 notifyAuthChanged 事件模式）→ `skin-changed` 载荷由纯函数 `buildSkinChangedPayload` 组装；preload 暴露 `onSkinChanged` / `removeSkinChangedListeners`。
3. **消费端**：PlayView 订阅 `skin-changed` → `playerSkinEpoch++` → `<PlayerIdentity key={epoch}>` 重挂载 → getSkin 重取（命中写透缓存，瞬时零网络）。fx/ 零改动（PlayerIdentity 未动，靠父级 key）。legacy 路径（get-skin L627 → resolvePlayerIdentity → 同一 uuid 缓存）天然一致。

纯逻辑测试：tests/skin-sync.test.ts（5 用例：写透判定 uuid 三态、载荷字段/注入时钟/ISO 往返）。

---

# Stage 1 补遗 — equip 仪式按钮（用户验收："equip 按钮太怂"）

commit：`e0faaa6`（feat(identity): equip as a ceremony — solid amber button with four-state interaction）

| 规格 | 落地情况 |
|---|---|
| amber 实心按钮 | ✓ `bg-ember` + 深色文字 `text-[var(--ground)]` + `px-[28px] py-[10px]` + `rounded-full`（既有圆角）+ `text-[15px] font-semibold lowercase`（贴 hero 名字字号） |
| 全屏唯一 amber 块面 | ✓ active 下划线是 amber 线条（scaleX），equip 是 amber 块面——层级分明不冲突 |
| hover | ✓ `-translate-y-0.5`（2px 升）+ `brightness-105`（+5%）；视线偏移**零代码达成**：SkinViewerCanvas 的窗口级 gaze 本就跟随光标，光标移到按钮即注视按钮，移开即回正（公共行为，无 NEEDS DECISION） |
| 按下 | ✓ `active:scale-[0.97] active:brightness-90` + `duration-micro`（120ms） |
| in-flight | ✓ 文字 "wearing it now."、`disabled`、脉动 `@keyframes equip-pulse`（0.95↔1.0，800ms，组件内 <style>，未动设计系统文件） |
| 成功链 | ✓ 300ms 溶解（`opacity-0` + duration-scene）→ `setPreviewId(null)` + hero key 重挂载（onShown GREETING）→ 货架 amber 下划线 scaleX 落位 |
| 失败 | ✓ 按钮复原 + 下方一行 "couldn't reach mojang. nothing changed." + 200ms 红闪（`border-danger bg-danger/20`） |
| 状态感知 | ✓ 佩戴中：无按钮 + "wearing it" 小写细字；离线：disabled + "requires microsoft" 小字；缺失文件：equip 不可用 + 说明 |
| 纯逻辑 | ✓ `equipButtonKind` 六态机器（wearing/idle/busy/dissolving/disabled-offline/missing），tests/equip-button.test.ts 6 用例 |

## NEEDS DECISION

- 无新增。spec 中 "GAZE 层视线朝按钮偏移" 未改任何代码——既有窗口级 gaze 跟随光标的行为天然覆盖（hover 即注视、移开即回正）；若后续想要"hover 时锁定注视点（无视光标）"的更强效果，需要 fx/ 公共接口扩展（`setGazeTarget(rect)`），届时再标 NEEDS DECISION。

# Stage 1 补遗 — 像素显形（Pixel Materialization）

commits：`07e4f8f`（test(pixel): pin curtain timing, scatter, and ceremony machine）→ `5dd1181`（feat(pixel): pixel curtain for equip morph and import reveal）

皮肤的 64×64 贴图像素本身就是显形素材——不是通用粒子，是"从贴图到生命"的叙事。两个场景共用一套覆盖层组件（`PixelCurtain`），素材与种子全部来自库内已有数据。

## 结果表

| 场景 | 状态 | commit | 测试数 |
|---|---|---|---|
| 纯逻辑（时序/网格/散布/skip/sweep/时序机/按钮映射） | ✓ | `07e4f8f` | 58 |
| equip 变形（按钮溶解 ∥ 幕组装 → hold 换肤 → 扫溶） | ✓ | `5dd1181` | （组件+接线，状态转移由既有用例+纯函数用例钉住） |
| 导入显形（飞入 → 归位 → 收束 → 揭示，双路径统一） | ✓ | `5dd1181` | （同上） |

## 时序编排（文字图）

```
A. equip 变形（预算 700ms 硬上限，可中断）
   0ms         400ms      500ms      700ms
   │— assemble —│— hold —│— dissolve —│
   按钮"wearing it now."（busy）→ EQUIP_SUCCESS 即 materializing → 按钮溶解（opacity-0，与组装并行）
   幕：打乱态皮肤像素逐格浮现（seeded shuffle，同 seed 同结果）
   hold 起点 = 换肤窗口：previewId→null + mirrorEpoch++（hero 幕后重挂载，GREETING 波在幕溶解时迎出）
   dissolve：幕重绘整幅后自顶向下扫过 clearRect（前缀语义，掉帧收敛无缝隙）
   complete/skip 同终态：卸幕 → 清 ceremony

B. 导入显形（900ms，每个新入库皮肤一次）
   0ms         350ms      550ms      700ms      900ms
   │— fly-in —│— settle —│— converge —│— reveal —│
   四散像素飞入归位（ease-out）→ 定格贴图大图 → 收束（保持整幅）→ 揭示
   reveal 起点 = 换肤窗口：previewId→新皮肤 id（幕后加载，揭幕即现身）
   complete/skip 同终态：卸幕 → "saved."（首件则既有 "saved. first of many." 接管）
```

## 中断规则（跳过）

- 幕布可见期间拦截 hero 区域点击 → **瞬跳终态**：换肤窗口立即执行（幂等，`swappedRef` 守卫）→ 卸幕 → 清态。卸载 canvas 是瞬时的，**无二次动画**；第 20 次 equip 的用户零减速。
- 连续 equip / 导入途中再触发：新操作先经 `finalizeActiveCurtain` 把旧幕结算到终态再开新幕，**绝不叠加两层**。

## 回退规则

- `prefers-reduced-motion: reduce` → 图片加载完成即跳终态（不进 rAF 循环）。
- 帧率守卫（D8）：仅采前 200ms 帧间隔，**≥3 样本且中位数 >50ms** → 弃幕直切；样本不足（如卡在组装首帧）→ 无证据不行动。
- 图片加载失败（`onerror`）→ 立即跳终态（换肤照常发生，只是没有仪式）。

## 数据通道（零新 IPC）

- equip 素材：货架条目自带的 `dataUrl`（skins-list 已供给）；导入素材：`loadSkins`/`refreshWardrobe` 刷新后的列表（D3：两函数改为返回数组，调用方同步）——**新增 IPC 通道：无**。
- 种子（D7）：皮肤 `hash` 前 8 位十六进制 `parseInt`（`hashSeed`），同皮肤永远同一张幕。
- 纹理源兜底：条目 `dataUrl === null`（文件缺失）→ 不开幕，走既有的瞬时换肤路径。

## 状态机（D6）

`equip.phase: 'idle' | 'busy' | 'materializing' | 'done' | 'fail'`，转移一律经纯函数 `equipCeremonyNext`（`EQUIP_START` / `EQUIP_SUCCESS` / `SWAP_WINDOW` / `CURTAIN_END` / `EQUIP_FAIL`）；materializing 映射按钮 kind `'dissolving'`（按钮溶解），done 落回 null。失败路径语义零变化（busy → fail → 红闪 + "couldn't reach mojang. nothing changed."）。

## 约束遵守

fx/ 内部零改动（幕是容器级覆盖层，z-20 于 hero 容器内）；零新依赖；零新 CSS 变量（幕底读既有 `--ground`）；equip swell 是唯一音频且不重复触发；全部文案小写（"saved." 与 "wearing it now." 同语感）。
