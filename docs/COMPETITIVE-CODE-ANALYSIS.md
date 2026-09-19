# Ember 代码库逐行级分析报告
**日期：** 2026-09-19 · **目的：** 建立竞争护城河战略的技术底座
**方法：** 全量读取 `src/main/`、`src/preload/`、`src/renderer/` 核心源码 + 交叉核对 `docs/project-truth/` 审计基线。所有结论均有文件/行号/符号引用。

> 重要路径勘误：仓库**没有** `src/main/services/` 子目录。所有主进程服务直接位于 `src/main/`。本报告按真实路径分析。

---

# 1. 完整架构图

## 1.1 进程拓扑

```
┌──────────────────────────────────────────────────────────────────────┐
│ MAIN PROCESS (src/main/index.ts, 1487 行)                            │
│                                                                      │
│  启动顺序 (app.whenReady):                                           │
│   1. registerIpcHandlers()      ← 全部 42+ IPC handler               │
│   2. createWindow()             ← splash + 主窗口, JavaProvisioner    │
│   3. initTray(mainWindow)       ← Temporal Ping (60s SMP 轮询)       │
│   4. worldManager = new WorldManager()   ← worlds.json 迁移/校验      │
│   5. identityService = new IdentityService() ← identity.json+tokens   │
│   6. Startup reconciliation:  AuthService → importSession() 桥接      │
│   7. notifyAuthChanged()        ← 渲染器竞态守卫                      │
└──────────────┬───────────────────────────────────────────────────────┘
               │ contextBridge (sandbox:true, contextIsolation:true,
               │ nodeIntegration:false)
┌──────────────▼───────────────────────────────────────────────────────┐
│ PRELOAD (src/preload/index.ts) — electronAPI 单一暴露面               │
└──────────────┬───────────────────────────────────────────────────────┘
               │ ipcRenderer.invoke / on
┌──────────────▼───────────────────────────────────────────────────────┐
│ RENDERER (React 19, 无状态库 — useState + props 下沉)                 │
│  App.tsx (视图编排) → PlayView / WorldsView / IdentityView /          │
│  SetupView / ModrinthBrowser / NewWorldDialog + fx/* (three.js)       │
└──────────────────────────────────────────────────────────────────────┘
```

## 1.2 IPC 桥接完整清单（42 invoke + 5 事件通道）

以下清单与 `docs/project-truth/03-IPC-MAP.md` 的 42 对配对交叉验证一致，并按当前源码归组：

**Meta/环境（6）**：`get-app-version` · `get-platform` · `open-external-link`（走 `validateExternalUrl` 白名单）· `get-installed-versions` · `run-preflight-check`（孤儿通道，无渲染器调用方）· `is-game-running`

**Auth/身份（12）**：`auth-login` · `auth-logout` · `auth-status` · `get-skin` · `get-accounts` · `get-active-account` · `set-active-account` · `add-microsoft-account` · `add-offline-account` · `remove-account`（含复活守卫）· `validate-session` · `identity-sign-out` · `get-identity-skin`

**皮肤（2）**：`select-skin-file`（主进程持有路径，渲染器只见 dataURL）· `upload-skin`（无路径参数设计）

**Java/启动（6）**：`get-java-path` · `detect-java` · `launch-game` · `launch-poc`（遗留 POC）· `cancel-launch` · `inject-server` · `fetch-version-list`（minecraft/fabric/quilt 三 kind 白名单）

**世界（15）**：`create-world` · `get-worlds` · `get-active-world` · `set-active-world` · `rename-world` · `update-world-settings` · `delete-world` · `duplicate-world` · `get-world-metrics` · `check-world-health` · `repair-world` · `backup-world` · `get-backups` · `restore-world` · `verify-backup` · `delete-backup`

**诊断/模组（9）**：`diagnose-world`（Oracle）· `check-mod-updates` · `perform-mod-update` · `mod-list` · `mod-toggle` · `mod-delete` · `mod-add` · `select-mod-file` · `mod-download` · `parse-modpack` · `modrinth-search` · `modrinth-download`

**杂项（2）**：`ping-server`（自研 SLP 协议）· `select-directory`

**主→渲染事件（5 组）**：`launch-step`（含 java 子事件重映射）· `java-progress` · `auth-changed`（无 token 载荷，纯"视图可能过期"信号）· `update-available/-not-available/-download-progress/-downloaded`（electron-updater 四联）

## 1.3 服务依赖与启动顺序

```
AuthService ──(startup importSession 桥)──▶ IdentityService
     │                                          │
     └──── resolvePlayerIdentity() ─────────────┘   ← index.ts L313-339
              │            「谁在玩」的唯一裁决规则
              ▼
     resolveLaunchAuthorization()   ← launch-game / launch-poc / auth-status / get-skin 全部收敛于此

JavaProvisioner ──▶ LaunchManager ──▶ FabricInstaller ──▶ ServerInjector ──▶ ModInstaller ──▶ MCLC spawn
  (get-java-path      (launchWithFabric       (profile JSON       (NBT servers.dat)   (mod-data.ts 静态清单)
   IPC 先行调用)        七步管线)               缓存→Meta API)
```

**关键顺序事实**：
- 渲染器在 `launchGame` **之前**调用 `getJavaPath`（App.tsx `startLaunch`）——Java 下载发生在 MCLC 120s 超时窗口之外，这是刻意设计。
- `LaunchManager` 每次启动**新建实例**（index.ts `launch-game` 内 `new LaunchManager()`），状态天然隔离。
- 双会话系统的唯一桥接点是启动时 `importSession()` + 登录后 `syncMicrosoftSignIn()` / `adoptExternalSession()` 双向收敛。

## 1.4 启动状态机（launchWithFabric 七步）

```
authenticating → preparing-java → ensuring-version → installing-fabric
→ injecting-server → installing-mods → launching → running
                                                    └─(exit)→ stopped
错误路径: 任意步 → error ([E301]/[E303])
取消路径: cancel-launch → watchdog reject [E307] → taskkill /T /F
停滞路径: watchdog 180s 无 MCLC 事件 → [E306] → cancel
```

进度事件流：MCLC 原始事件 → `App.tsx` MCLC_BUCKETS 加权复合（assets 0.55 / classes+libraries 0.35 / natives 0.10，单调不减）→ `ensuring-version` 步骤；`version-jar` 字节计数以 0.55×0.1 权重折叠进 assets 槽位。

---

# 2. 核心服务模块深度分析

> 注：用户列出的 `src/main/services/*` 路径不存在；以下按真实路径 `src/main/<file>` 分析。

## 2.1 `src/main/index.ts`（主进程入口，1487 行）

**导出**：无（纯编排层）。内部关键函数：

| 函数 | 职责 |
|---|---|
| `createWindow()` | splash（360×360 无边框，`autoplayPolicy: no-user-gesture-required`）+ 主窗口（1200×800，sandbox/contextIsolation 双开）。**视频门控交接**：`splashCheck` 100ms 轮询 `window.__splashDone`，`mainReady && videoDone` 才 `handoff()`；8s 硬上限 + `splash.once('closed')` 双兜底，任何一态组合都无法困住用户 |
| `syncMicrosoftSignIn(profile)` | Play 端登录 → IdentityService 注册表收敛。UUID 去横线匹配、幂等、失败仅告警 |
| `notifyAuthChanged()` | 单一含义事件："你的视图可能过期，重新拉取"。载荷**零 token** |
| `resolvePlayerIdentity()` | **全系统唯一身份裁决**：identity 活跃账户（offline 或有 session）优先，否则 legacy profile |
| `resolveLaunchAuthorization()` | 身份裁决 → token。identity 走 `ensureValidSession`（会刷新），legacy 走 `getAuthorizationForMCLC`。失败抛 `[E609]`，**绝不静默回退到别人** |

**错误处理**：进程级 `uncaughtException` 捕获 EPIPE 静默吞掉（MCLC socket/管道断裂是可恢复 I/O 错误），其余打日志不崩。`launch-game` 有 `validatePath(javaPath)` 反注入 + `launchInProgress`/`isRunning()` 双重防重入（`[E604]`/`[E605]`）。

**USER DATA 锚点**（L60-63）：包改名 ember-launcher 后 `app.setPath('userData', .../mu-master-launcher)` 钉死历史目录——**零迁移风险的用户数据保全**，这是一个产品级决策嵌入代码的范例。

**性能**：`parse-modpack`/`mod-downloader`/`update-checker` 中 adm-zip 全部动态 `import()`——重依赖不出现在启动路径。

## 2.2 `src/main/java-provisioner.ts`（Java 运行时管理，~460 行）

**导出**：`class JavaProvisioner extends EventEmitter`，接口 `JavaProgressEvent { phase, percent, message? }`。

**算法（ensureJava 12 步）**：
1. `timedFetch` Mojang version_manifest_v2（30s 总窗超时）
2. 定位目标版本条目（mcVersion 钉死 `26.1.2`，可构造覆盖）
3. 拉版本 JSON 取 `javaVersion.component/majorVersion`
4. **版本感知缓存检查**：`{userData}/runtime/current-java-path.txt` → `smokeTest(path, expectedMajorVersion)`——**精确 major 匹配**，错版本缓存被拒绝并重新供给
5-8. JRE 产品清单 → 平台键 `windows-x64` 硬编码 → 组件版本 → 文件清单（全部 timedFetch 30s）
9. 逐文件流式下载：`downloadGuard()`（连接期 20s 中止）+ `readWithStallGuard`（单 chunk 60s 停滞中止）+ 流式 SHA-1（`createHash('sha1')` 边写边算，零额外 I/O）→ 失败删半成品
10. 定位 `bin/java.exe`（兼容 `jre/bin` 前缀结构）
11. **冒烟测试**：spawn `java -version`（15s 超时，windowsHide），stderr 正则 `/(?:openjdk|java|jre)\s+version\s+"(\d+)/`，基线 ≥17 + 期望精确匹配
12. 写缓存文件

**复杂度**：O(n) 文件数，每文件独立 SHA-1。**安全**：下载即校验，哈希不符即删（`[E218]`），不存在"先启动后修"路径。

**错误码**：`[E201]-[E218]` 完整链，全部人类可读中文级文案。

## 2.3 `src/main/fabric-installer.ts`（~150 行）

**导出**：`class FabricInstaller`。钉死 `mcVersion='26.1.2'`，`loaderVersion='0.19.3'`。

**ensureFabric 逻辑**：
1. 缓存路径 = `versions/fabric-loader-{loader}-{mc}/fabric-loader-{loader}-{mc}.json`（MCLC 兼容目录结构，MCLC 直接读取）
2. **缓存先验证后信任**：`JSON.parse` + `cached.id` 存在性检查；损坏 → 删除 + 重取（解决"崩溃半写文件永久阻断启动"）
3. Fabric Meta API `profile/json`（timedFetch）
4. 响应结构校验（`profile.id` 必须存在）
5. **原子写**：`.tmp` + rename——崩溃永不留半写 profile

设计决策注释明确说明每一步为什么存在（"corrupt => delete + refetch"）。错误码 `[E401]-[E406]`。

## 2.4 `src/main/net.ts`（有界网络层，~130 行）

**导出**：`timedFetch(url, timeoutMs=30s)` · `downloadGuard(connectTimeoutMs=20s)` · `readWithStallGuard(read, controller, stallTimeoutMs=60s)` · `DownloadGuard` 接口。

**核心洞察**：三层超时模型，每层针对不同失效模式：
- **timedFetch** = 总窗超时（headers+body），适合 KB 级 JSON
- **downloadGuard** = 仅连接期超时，`headersReceived()` 手动解除——慢而活的传输不被误杀
- **readWithStallGuard** = 单 chunk 停滞守卫。**竞态处理精妙**：`reject` 先于 `abort()`（保证 race 确定性地 settle 出 `[E222]` 而非裸 AbortError），然后 `void readPromise.catch(()=>{})` 吞掉读侧迟到拒绝——否则会变成 unhandled rejection。注释注明这是 Sprint-3 harness 实证结论

这是整个仓库**复用度最高的基础设施**，5 个模块依赖它。

## 2.5 `src/main/launch-service.ts`（LaunchManager，~400 行）

**导出**：`class LaunchManager`，类型 `StepChangeCallback`。常量 `STALL_TIMEOUT_MS = 180_000`。

**关键算法**：
- **活动看门狗**：每个 MCLC 事件（progress/data/error/debug/download-status/download）重置 `_lastActivity`；10s 间隔 tick，180s 无活动 → `Promise.race([launchPromise, stallPromise])` 中的 stall 侧 reject `[E306]` + `cancelLaunch()`。**解决 MCLC 挂起永不出错的致命问题**
- **MCLC 进度修正**：`e.task` 是数值计数器而非任务名，`e.current` 恒缺——只读 current 曾导致 0% 冻结。读序 `current ?? task`
- **大文件字节进度**：仅 `version-jar` 类型走字节真分数，assets/libraries 的字节噪声被过滤（各自的 task/total 已覆盖）
- **cancelLaunch**：win32 `taskkill /pid /T /F`（杀进程树），POSIX SIGKILL；stall race reject `[E307]`；最终步发 **error 而非 done**（注释：取消/停滞标 done 会让 UI 在失败时显示"dim-complete"，撒谎）
- `isRunning()` 四条件判活：非空 + pid 存在 + exitCode===null + !killed

**每次启动新建实例** + `launchInProgress` IPC 层互斥 = 双保险防重入。

## 2.6 `src/main/server-injector.ts`（NBT 服务器注入，~230 行）

**导出**：`class ServerInjector`。钉死 `Masters' Union SMP` @ `prathamsethi.minekeep.gg:25565`。

**injectServer**：
1. 解析现有 servers.dat（prismarine-nbt）；**损坏 → 备份为 `.corrupt-<ts>`（rename 失败则删）→ 重建全新清单**——永不永久阻断启动
2. 幂等检查：`entry.ip?.value === serverIp` 已存在则跳过
3. 追加 `{name, ip, port, hidden}` 四字段 compound
4. **原子写**：`nbt.writeUncompressed` → `.tmp` → rename。**未压缩 NBT 是刻意选择**（注释：MC 26.1.2 期望 raw NBT）——这也是 R-06 已知风险：版本行为变化会静默破坏注入

`removeServer()` 提供逆操作（测试/清理用）。

## 2.7 `src/main/mod-installer.ts`（静态清单安装，~180 行）

**导出**：`class ModInstaller`。数据源 `mod-data.ts` 的 `MODS`/`RESOURCE_PACKS` 静态数组（URL+hash 钉死）。

**installMods/ResourcePacks**：逐条目：存在 → `verifyHash`（sha1/sha512 全量读入内存计算）→ 匹配跳过 / 不匹配删除重下。下载走 `downloadWithHash`：downloadGuard + readWithStallGuard + 流式哈希 + `.tmp` + rename（`[mods]` 风格错误）。**失败非致命**：单条目失败 continue，其余照装（launch 管线也 catch 为非致命）。

**已知弱点**（R-04）：静态 URL 上游删除 → 每次启动逐条失败（降级但不阻断）。`verifyHash` 全量读内存对大 mod（>50MB）有峰值内存代价。

## 2.8 `src/main/mod-downloader.ts`（Modrinth 拉取，~230 行）

**导出**：`searchModrinthMods(query, gameVersion?, loader?)` · `downloadModFromModrinth(worldRootPath, projectId, versionId?, filter?)` · `ModrinthSearchResult`。

**契约**：**永不抛出**。任何失败 resolve `{success:false, error}`（搜索则 `[]`）。零 electron 导入（纯 Node fetch）→ 可在应用外测试。

**算法**：
- 搜索：facets `project_type:mod` 恒加（插件/数据包不污染），`versions:`/`categories:` 可选；`AbortSignal.timeout(5000)`
- 下载：版本列表（新→旧）→ versionId 或 **世界兼容过滤**（gameVersion AND loader 双匹配；注释点名 Sodium 最新是 NeoForge-only 的真实案例）→ primary 文件（无标记则第一个）→ `assertSafeFilename`（无 `/`、`\`、`..`、必须 `.jar`）→ `arrayBuffer()` 全量 → 写 `mods/`

**弱点**：全量内存读（arrayBuffer），无 hash 校验下载文件（信任 Modrinth TLS），5s 搜索超时在慢网偏紧。

## 2.9 `src/main/modpack-installer.ts`（.mrpack 覆盖提取，~130 行）

**导出**：`installModpackOverrides(zipPath, worldRootPath)`。

**关键实现细节（注释中的实战教训）**：
- adm-zip **字符串路径构造器抛 INVALID_FILENAME**（内部 existsSync 分歧），必须先 `readFile` 成 Buffer 再构造——且本地类型 shim 只声明 string 形态，故走 `as unknown as new (data: Buffer)` 双重断言
- Zip-slip 守卫：entry 名先归一 `\` → `/`，逐段拒绝 `..`/`.`；`overrides/` 根 entry 跳过；目录 entry 保留（空文件夹如 shaderpacks/ 存活）
- 失败显式抛出（带 entry 名+目标路径）——契约是"绝不半静默安装"

**注意**：`parse-modpack`（index.ts）读 `modrinth.index.json` 仅识别包身份；**本模块只搬 overrides/**，不解析 modrinth.index.json 的 downloads 清单——`.mrpack` 的声明式模组下载未实现（当前是"配置搬運"而非"全量安装"）。

## 2.10 `src/main/skin-service.ts`（~170 行）

**导出**：`class SkinService`。接口 `SkinResult { dataUrl, model }`。

**解析链**：24h 磁盘缓存（`{userData}/skins/<uuid净化>.png/.json`）→ Mojang session server profile → base64 解码 `textures` property → SKIN URL + model 元数据 → PNG 下载。**Mojang 失败 → Crafatar 兜底**（无 model 元数据，假设 default）。双败 → null（皮肤是装饰性的，绝不阻断）。

**write-through 缓存**（`putCache`）：上传成功后**本地上传文件即新皮肤**直接入缓存——不等 Mojang CDN 传播，全表面即时生效。

**缓存净化**：`uuid.replace(/[^a-fA-F0-9]/g,'')` 防路径注入。`clearAll()` 注释点明静态 import 强制性（主进程单文件 bundle 内 require() 兄弟模块会 MODULE_NOT_FOUND——这正是当年皮肤全 null 的根因）。

## 2.11 `src/main/crash-diagnostic.ts`（The Oracle，~180 行）

**导出**：`diagnoseLastCrash(worldRootPath)` → `CrashDiagnosis`。

**契约**：**永不抛出**。"会崩溃的诊断师比没有诊断师更糟"。

**算法**：
1. `crash-reports/*.txt` 按 **mtime**（非文件名——时钟漂移/手动改名更稳）取最新
2. 只读**头部 5000 字符**（`HEAD_LIMIT`）——多 MB 病态报告不阻塞主进程同步读
3. **原因检测**优先级：`Caused by:`（JVM 因果链）> `Mixin apply failed`（Fabric 不兼容签名）> `OutOfMemoryError`；OOM 专门归类为"非模组问题"
4. **罪魁模组检测**三信号：`<modid>.mixins.json`（mixin 配置以模组命名）> `Mod file:/File:` 行的 jar 名（剥版本尾）> **栈帧包前缀遍历**：逐帧两段式展开包路径，命中 `NON_MOD_PACKAGES`（net.minecraft/com.mojang/net.fabricmc/…17 项白名单）即排除，走到底则第二段是模组包名（"net"是 tld，"sodium"是模组）
5. `prettifyModId`：`sodium-extra` → "Sodium Extra"

这是**真正的差异化资产**：竞品无一内置"下一个 Play 前，UI 直接点名肇事模组"的体验。

## 2.12 `src/main/update-checker.ts`（Modrinth 模组更新，~230 行）

**导出**：`checkForUpdates(worldRootPath, gameVersion, loader)` · `performUpdate(...)` · `ModUpdateInfo`。

**算法**：
- 逐 jar：adm-zip 读 `fabric.mod.json`（非 Fabric 静默跳过）→ Modrinth `/project/{id}/version?loaders=&game_versions=` → `isNewerVersion`
- **数值感知版本比较**：`split(/[.+-]/)` 逐段 parseInt；非数值段回退字符串比较；全不可解析回退不等式（异端版本方案仍能浮现为更新）；数值相等但文本不同 → 依据 API 新→旧排序判定
- `Promise.all` 并发逐 jar 检查，**每 jar 独立 try/catch**——一个坏 jar/死网络不阻塞其他
- **performUpdate 顺序不变式**：新文件**先**完整落盘，旧 jar **后**删；同名更新不自删；旧文件删除失败不使更新失败（更新已成立）

## 2.13 `src/main/world-manager.ts`（世界注册表，~700 行）

**导出**：`class WorldManager`。注册表 `{userData}/worlds.json`，schema v1，`MANAGED_WORLD_ID='managed-mu-smp'`。

**核心机制**：
- **路径模板**：`rootPath = '{userData}/worlds/<uuid>/minecraft'`，`resolveRoot()` 运行时展开——世界可移植性的基础
- **托管世界永不 broken**（validateRegistry 1b 自愈）：`{userData}/minecraft` 在启动时 mkdir，缺失≠损坏；旧版误标 broken 曾导致"托管切换不一致"bug，现在加载即清除
- **save() 写锁**：`while(this.writeLock)` 自旋（同步写 <1ms，注释论证安全）+ tmp+rename 原子写
- **loadOrMigrate 三态**：存在→校验；损坏→`.corrupt-<ts>` 备份 + 从现有目录重建；无→`migrateFromExisting()`（零文件搬移，把现有 install 注册为托管世界）
- **createWorld 全局设置导入**：探测序 `spec.settingsPath` → `.minecraft/` → `minecraft/`（兼容 MultiMC/Prism 实例结构）→ 默认全局 .minecraft；`options.txt` + `config/` 拷入新世界根——**"新世界开箱即你自己的"**，竞品没有此体验
- **restoreWorld 三段回滚**：现 saves/ 先挪 `saves.pre-restore`（清理陈旧残留）→ 提取（内层 saves/ 前缀上移）→ 失败整体回滚；backupName **路径穿越守卫**（拒 `..`/`/\`）
- **getWorldMetrics 异步化**：dirSize 走 fs/promises（libuv 线程池）——注释记录了旧同步遍历冻结整个主进程的事故

**弱点**：自旋锁在 JS 单线程下其实永远不等待（同步代码无让步点），是防御性冗余而非真锁；`copyDirSync` 深拷贝大世界会阻塞主进程。

## 2.14 `src/main/tray-manager.ts`（Temporal Ping，~150 行）

**导出**：`initTray(mainWindow)` · `disposeTray()`。

**机制**：
- close-to-tray：close 事件 `preventDefault` + hide；**`isQuitting` 逃生舱**（disposeTray 置位，before-quit 触发）——注释点明 Electron 在 app.quit() 时也会对每窗发 close，无条件 preventDefault 会让应用不可退出
- 60s SLP ping，**人数上升 + 窗口隐藏** → Windows 原生通知"Someone just joined the server!"
- **基线语义**：不可达/无数值 → 基线置 null（下次上线重新观察，避免"对旧人数误报有人加入"）；首次成功 ping 只观察不通知
- 通知**仅在窗口隐藏时**触发（用户盯着启动器时不被自己的通知打断）

## 2.15 `src/main/server-pinger.ts`（自研 SLP，~236 行）

**导出**：`pingMinecraftServer(host, port)` → `ServerStatus`。

零依赖手写 Minecraft Server List Ping（1.7+）：VarInt 编解码（`>>>0` 处理 -1 协议版本 → 5 字节 FF FF FF FF 0F）、Handshake(state=1) → Status Request → JSON 载荷。**永不抛出**契约。已知限制：无 SRV 记录查找。

**战略意义**：竞品用第三方库或完整协议栈实现服务器列表；Ember 用 ~200 行零依赖实现 + 60s 后台监控 + 人数变化通知，把"服务器状态"变成产品氛围的一部分。

---

# 3. 渲染器进程组件

## 3.1 架构总览

**无路由库、无状态库**。`App.tsx` 的 `View` 类型（'auth'|'play'|'worlds'|'settings'）+ useState 即是路由。**关键决策：keep-alive 导航**——所有视图常驻挂载，CSS `display:none` 切换。注释给出测量依据：Play 场景两个 WebGL 上下文 + three.js 着色器编译，旧 mount/unmount 模式每次 Worlds→Play 测得 **70–95ms 主线程冻结**；隐藏代替卸载保活上下文，PlayView 的 IntersectionObserver 在隐藏时暂停 RAF，后台零 GPU 消耗。

**状态管理策略**：
- 启动状态（launching/steps/error/isRunning）**App 级单监听器**持有（REPORT-001 修复：进度跨导航存活）
- 视图局部状态 useState；跨视图同步靠 `auth-changed` 推送事件（"重拉"语义）
- `upsertStep` 带**身份重写跳过**（高频 MCLC 事件同值帧不重渲染）+ 'done' 终态不可逆（'working' 复活被拒——灯丝不倒退）
- 乐观更新 + 事后对账：`handleSetActiveWorld` 先切 UI 再 IPC，失败必然 `loadWorlds()` 回真

## 3.2 App.tsx（~300 行）

**Props**：无（根）。**核心 state**：currentView/launching/launchError/launchSteps/isRunning/worlds/activeWorld/hearthFlare + 3 个 ref（launchingRef 防重入、cancelRequestedRef 区分"用户取消≠失败"、mclcRef 复合进度桶）。

**MCLC 复合进度算法**：未知 step 名（'assets'/'classes'/'natives'…）按正则入桶，`compositeMclc = Σ min-max(桶)×weight`，单调 max，无定时器无假百分比——**测量而非动画**。

## 3.3 PlayView.tsx（596 行）

**Props 契约**（11 项）：`launching/launchError/launchSteps/isRunning/onPlay/onRetry/onCancelLaunch?/activeWorld/worlds/onSetActiveWorld`。

**四阶段映射**：STAGES 将 8 个真实管线步骤聚合为 4 个用户可读阶段（Authenticating/Igniting/Forging/Launching）；`activeStageLabel` 取第一个 working 阶段作为 hero 大字。

**渲染栈**：SkinViewerCanvas（skinview3d + PlayerDirector）+ ForgeLine（灯丝）+ WorldSwitcher + SideRays/MagicRings（ogl 氛围）+ Server Pulse（ping-server 轮询）+ **Oracle 崩溃预警横幅**（diagnose-world 在 Play 前显示"上次崩溃的肇事模组"）+ Mod Update Notifier 计数。

**布局工程**：`HERO_SLOT`（文档保留，clamp(200px,38vh,380px)）与 `HERO_CANVAS`（实际渲染帧，clamp(280px,46vh,460px)）**刻意解耦**——注释含精确像素级碰撞演算（696.8 vs 692.4 的 20px 碰撞记录），"结构上限 ~352px，超过必碰撞其一"。

## 3.4 SetupView.tsx（~140 行）

Props：`activeWorld, onWorldsChanged`。RAM 滑杆 2048–16384 步进 512，**ref 计时器防抖 500ms** 持久化（注释：per-render `let` 会在每次拖动泄漏活定时器 → N 次 IPC）。Java "Detect" 走 `detect-java`。**诚实缺口**：Open Folder/Clear Cache/分辨率仍是 console.log 存根。

## 3.5 NewWorldDialog.tsx（388 行）

三清单（Mojang/Fabric/Quilt）**独立加载**（一个 API 慢不阻塞另两个已答的）+ **失败态显式化**（`mcFailed` 等——空列表与加载中不可混淆，瞬时失败不冻结下拉）。Forge/NeoForge 保持策划钉版。settingsPath 可选导入全局设置。

## 3.6 ModrinthBrowser.tsx（317 行）

**Props**：`worldId/worldName/worldVersion/worldLoader/onClose/onInstalled`。

- 挂载即跑空查询（= 下载排序热门榜），500ms 防抖输入
- **latest-effect-wins**：`searchSeq` 序号，陈旧响应直接丢弃（慢响应不覆盖新键入的结果）
- 版本覆盖下拉：世界版本恒在首位；异端钉版（如 SMP "26.3"）会零化结果，故初始选空（无版本 facet）
- 每卡安装状态机 idle→installing→installed（session 内粘滞）+ onInstalled 上抛刷新

## 3.7 IdentityView.tsx（597 行）

**Identity Studio**：skinview3d 全身 + 皮肤上传（select-skin-file dataURL 预览 → upload-skin 无路径）+ classic/slim 变体 + 强制刷新（force 绕 24h 缓存）。账户列表 hasSession 富化显示；remove-account 双击确认；offline 账户禁皮肤操作。`onAuthChanged` 推送重拉——Play 端登录即时反映。

## 3.8 fx/PlayerDirector.ts（1106 行，**仓库最大单文件**）

**设计**：单一长命 `PlayerAnimation` 实例拥有全部姿态状态——**没有任何代码争抢骨骼**，`viewer.animation` 永不换（swap 经 resetJoints 会跳变）。一切 easing，零 snap。

**四层加性合成**（每帧，无状态机库，状态只是一撮标量）：
1. **BASE**：呼吸 bob（0.035 单位，~9s 周期，注释：潜意识到但不显眼）+ ±1.7° 体摆 + 微头漂移
2. **GAZE**：头优先视线追踪。窗口指针 → canvas NDC → **相机系 yaw/pitch（±23°世界扫视）→ 头局部需求（target−bodyYaw）钳颈限 ±35°**；指针存活时身体缓向相机 7°（"square-up"，方向无关）——注释解释这是让对称世界扫视在颈预算内可达的关键（旧 bug：右缘 49° 颈扭+左缘零）
3. **GREETING**：一次性 1.6s 关键帧时间线（anticipation→抬臂穿前→两摆→归位）
4. **WAVE/GOODBYE**：`energetic` 信号（真实 launch 状态）驱动**时长由 launch 决定**的挥手——节奏爬升后恒速，arm mechanics 复用 WAVE_CONFIG（greeting 曾用错误 Euler 顺序读作"侧平举"，026 帧对比实证后统一）

**欧拉轴知识**显式文档化：XYZ 顺序下 rotation.z 先于 rotation.x 生效——"rotation.x<0 抬臂穿前（友好 hi），rotation.z 抬臂会弧过背后（拳击手预备）"。

## 3.9 fx/SkinViewerCanvas.tsx（349 行）

**skinUrl 三态语义**：string=自定义 / null=确认无皮肤→内置 Steve / undefined=解析中→**渲染空**（杜绝 Steve 闪现为加载占位——"有自定义皮肤时第一可见帧就是它"）。焦点/可见性：窗口隐藏或失焦暂停渲染循环（renderPaused 属性翻转恢复）。IntersectionObserver 只在入视口跑 RAF。内嵌 Steve 为硬编码 base64 PNG。

## 3.10 样式系统（EMBER 设计系统）

`tailwind.config.js` 全部色值**源自 CSS 变量**（index.css 的 `--ground/--ink/--ember/--line`…），mu-* 遗留别名保留映射。字体栈 Segoe UI Variable Display/Text + Cascadia Mono。时序 token：micro 120ms / state 300ms / scene 600ms，缓动 `cubic-bezier(0.22,1,0.36,1)`。**无 antd/MUI/组件库**——全套自研，视觉 DNA 不可被复刻性引用。

---

# 4. 认证与安全系统

## 4.1 双系统架构（手册规定不可合并）

```
AuthService (legacy)                    IdentityService (identity)
├─ msmc Auth('select_account')          ├─ 账户注册表 identity.json (无 token)
├─ 单活会话 auth-session.bin            ├─ 加密 token 库 identity-tokens.bin (safeStorage)
├─ currentToken: Xbox | null            ├─ 多账户/离线账户/皮肤操作
└─ ensureValidAuth() 刷新链             └─ validateSession/ensureValidSession
        ▲                                        ▲
        └────── 双向收敛桥 ─────────────────────┘
   启动时: importSession()  (legacy → identity, 幂等不覆写)
   Play登录后: syncMicrosoftSignIn()  (legacy → identity)
   Account登录后: adoptExternalSession()  (identity → legacy)
```

**为什么并存**：AuthService 是 OAuth 引擎（MSMC 弹窗、Xbox 链刷新）；IdentityService 是账户管理面。强行合并 = 高风险重构，桥接收敛已使两者永远描述**同一个现实**。

## 4.2 MSMC OAuth 完整流程

1. `authManager.launch('electron', {width:500,height:650})` — Electron 弹窗模式，默认重定向 `oauth20_desktop.srf`（注释：避免 setServer()+localhost 的 redirect_uri 不匹配）
2. `xboxToken.getMinecraft()` — Xbox→XSTS→Minecraft 链
3. **所有权验证**：`minecraft.mclc().uuid` 空值/全零 → `[E101] "此 Microsoft 账户不拥有 Java 版"`；mclc 异常 → `[E102]`
4. profile `{uuid, name, accessToken}` 持久化
5. 弹窗关闭识别：`error.gui.closed` → `[E108] "登录已取消"`（区别于 `[E103]` 一般失败）

**刷新链**：`ensureValidAuth()` 快路径（内存 Xbox token，refresh() 对 <1h 有效 token 是 no-op）→ 慢路径（`authManager.refresh(savedRefreshToken)` 重建全链 + persistSession）→ 失败清空会话让上层提示重登。

## 4.3 令牌存储

- `safeStorage.encryptString`（DPAPI 机器键）；**加密不可用时永不降级明文**——直接放弃持久化（auth-service persistSession L~330：`console.warn('safeStorage unavailable, session will not persist')`）。这是**安全高于便利的显式决策**
- identity-tokens.bin 同机制，逐账户 `Map<accountId, Session>`
- **Token 永不跨桥**：渲染器只见 `{loggedIn, profile:{uuid,name}}`，access/refresh token 全程主进程

## 4.4 复活守卫（remove-account，index.ts L1102-1170）

删除与 legacy 会话 UUID 相同的账户时：**先** `auth.logout()` → **验证** `hasPersistedSession()===false` → 验证失败**中止删除**（账户完整、可重试）→ 才允许 `identityService.removeAccount`。顺序论证写在注释里：删除后清理会留下"账户已删但 legacy 文件存活"的崩溃窗口 → 启动桥 importSession 复活账户。

## 4.5 离线模式

`addOfflineAccount(username)`：≤16 字符校验，**Minecraft 官方离线 UUID 算法**（MD5("OfflinePlayer:"+name) → UUID v3 位操作：`hash[6]&0x0f|0x30`、`hash[8]&0x3f|0x80`）→ 会话恒 authenticated → `ensureValidSession` 返回 `{access_token:'offline', uuid, name}`（MCLC 离线模式接受）。

## 4.6 安全边界清单

| 层 | 措施 |
|---|---|
| 窗口 | sandbox:true, contextIsolation:true, nodeIntegration:false；window-open/will-navigate 双拦截外链 |
| IPC 输入 | `ipc-validate.ts`：URL 白名单（9 域 + http 仅 localhost）、版本正则、路径反注入正则、通道名正则 |
| 文件系统 | 渲染器**永不供路径**：皮肤走主进程对话框持有（pendingSkinPath）、模组走 worldId 解析、webUtils.getPathForFile 仅 preload |
| 归档 | zip-slip 三重守卫（modpack-installer 逐段拒 ..、mod-manager/mod-downloader assertSafeFilename、restoreWorld backupName 拒穿越）|
| 下载 | Mojang 清单 SHA-1、mod-data sha1/sha512、流式边算 |
| 已知暴露 | `mod-download`/`modrinth-download` 的下载 URL 无哈希校验（信任 Modrinth TLS）；launch-poc 的 root 参数未过 validatePath（内部 POC 面）；`fetch-version-list` 白名单 kinds 防代理滥用 ✅ |

---

# 5. 版本与模组管理

## 5.1 版本钉死机制（三层）

1. **代码层**：`LaunchManager.mcVersion='26.1.2'`、`JavaProvisioner.mcVersion='26.1.2'`、`FabricInstaller(mc='26.1.2', loader='0.19.3')`、`ServerInjector` 服务器地址——四个模块默认值互相咬合
2. **注册表层**：`World.version/loader/loaderVersion` 每世界独立；托管世界 `MANAGED_WORLD_CONFIG` 钉版
3. **数据层**：`mod-data.ts` 静态清单 URL+hash

**世界与管线的连接**：`launch-game` 读 `activeWorld.ramAllocation` 传 JVM；`mod-download`/`check-mod-updates` 读 `world.version/loader` 作为 Modrinth facet——**个人世界版本真正驱动下载兼容过滤**（Sodium NeoForge-only 案例的解法）。

## 5.2 Fabric 安装器逐行逻辑

见 §2.3。补充兼容性关键：profile 写入 **MCLC 自己的 versions/ 目录结构**，`version.custom = fabricProfileId` 让 MCLC 沿 `inheritsFrom` 解析——无需 fork MCLC。

## 5.3 模组依赖解析

**不解析依赖图**（与 Modrinth 的 `dependencies` 字段无交互）。兼容性策略是**过滤式**而非解析式：
- 搜索 facet `project_type:mod + versions:X + categories:loader`
- 下载时 world filter 双匹配（gameVersion AND loader）
- 更新检查同 facet

设计权衡：SMP 单服务器场景下官方推荐榜即权威，省去完整解析器的维护成本；代价是依赖缺失交给 Fabric 加载器在启动时报错 → 被 Oracle 捕获归因 → **形成闭环**（装错 → 崩溃 → 点名）。

## 5.4 `.mrpack` 实现

`parse-modpack`（index.ts L560-600）：Buffer 构造 adm-zip → 找 `modrinth.index.json` → 提取 `{name, versionId, dependencies.minecraft, dependencies['fabric-loader']}` → UI 确认。
`installModpackOverrides`：仅搬 `overrides/`（configs/resourcepacks/shaderpacks）。
**未实现**：modrinth.index.json 的 `files[]` 声明式下载清单（format 规范核心）。当前是部分导入。

---

# 6. 文件系统操作

## 6.1 持久化路径全表

| 路径 | 所有者 | 格式 | 恢复策略 |
|---|---|---|---|
| `{userData}/worlds.json` | WorldManager | JSON (schema v1) | 损坏→`.corrupt-<ts>` 备份+从目录重建 |
| `{userData}/identity.json` | IdentityService | JSON | 损坏→静默重开（**无备份**，R-10）|
| `{userData}/identity-tokens.bin` | IdentityService | safeStorage 加密 JSON | 加载失败仅日志 |
| `{userData}/auth-session.bin` | AuthService | safeStorage 加密 JSON | 损坏→删除 |
| `{userData}/runtime/current-java-path.txt` | JavaProvisioner | 文本路径 | 冒烟测试失败→重下 |
| `{userData}/skins/<uuid>.png/.json` | SkinService | PNG+JSON | 损坏→refetch |
| `{userData}/minecraft/versions/fabric-loader-*/…json` | FabricInstaller | MCLC 兼容 JSON | 损坏→删+refetch |
| `{userData}/minecraft/servers.dat` | ServerInjector | 未压缩 NBT | 损坏→`.corrupt-<ts>`+重建 |
| `{userData}/worlds/<id>/minecraft/**` | 各服务 | 游戏文件 | root 缺失→broken 标记→repair |
| `{userData}/worlds/<id>/backups/*.zip` | WorldManager | adm-zip | verify：size>0+zip 可读+含 level.dat |

## 6.2 临时文件策略（统一 tmp+rename 原子写）

`worlds.json.tmp` / `identity.json.tmp` / `servers.dat.tmp` / Fabric profile `.tmp` / mod 下载 `.tmp`——**崩溃半写永不落真路径**。下载失败半成品一律 unlink。

## 6.3 崩溃恢复机制矩阵

1. **注册表**：`.corrupt-<timestamp>` 手动可恢复备份
2. **servers.dat**：同上
3. **Fabric profile**：验证→删→refetch
4. **Java 缓存**：版本感知冒烟测试拒错版本
5. **世界备份还原**：pre-restore 目录 + 三段回滚
6. **启动停滞**：看门狗 180s 强制 settle
7. **进程 EPIPE**：uncaughtException 静默分类
8. **托管世界 broken 自愈**：加载时强制清除误标

## 6.4 配置验证

worlds.json：schemaVersion 检查 + validateRegistry 四步（托管存在性/自愈/activeWorldId 有效性/个人 root 存在性）。identity.json：**无 schema 版本**（R-10）。`.mrpack`：结构探测式。皮肤 PNG：魔数 + IHDR 维度（offset 16/20 读 u32BE，64×64/64×32）+ 128KB 上限。

---

# 7. 网络层实现

## 7.1 API 端点全表

| 端点 | 调用方 | 用途 | 超时 |
|---|---|---|---|
| piston-meta.mojang.com/version_manifest_v2 | JavaProvisioner, fetch-version-list | MC 清单 | 30s/8s |
| launchermeta.mojang.com/java-runtime/all.json | JavaProvisioner | JRE 产品清单 | 30s |
| piston-meta JRE file manifest | JavaProvisioner | 文件级 SHA-1 | 30s |
| meta.fabricmc.net/v2/versions/loader/{mc}/{v}/profile/json | FabricInstaller | profile JSON | 30s |
| api.modrinth.com/v2/search /project/{id}/version | mod-downloader, update-checker | 搜索/版本 | 5s/无 |
| sessionserver.mojang.com/profile/{uuid} | SkinService | 皮肤 profile | 15s |
| crafatar.com/skins/{uuid} | SkinService 兜底 | 皮肤 PNG | 20s |
| api.minecraftservices.com/profile/skins (POST) | IdentityService | 皮肤上传 | 30s |
| auth/graph Xbox 链 | msmc 内部 | OAuth | 库管 |
| raw TCP SLP | server-pinger | 服务器 ping | 5s |
| GitHub Releases | electron-updater | 应用更新 | 库管 |

## 7.2 重试与恢复策略

**无自动重试**——刻意设计：每类失败映射人类可读错误码（[E2xx] 网络/[E4xx] Fabric/[E5xx] 注入/[E6xx] 启动），UI 呈现 + 用户手动重试。理由：下载器已有暂停守卫 + SHA-1 验证，自动重试坏链只会放大问题。**恢复**：Java JRE 逐文件（部分成功保留），mod 逐条目（失败 continue），模组更新下载-先删-后序不变式。

## 7.3 进度报告机制

双通道：`java-progress`（phase/percent/message，EventEmitter→webContents.send）与 `launch-step`（step/status/progress，含 MCLC 子事件重映射 + version-jar 字节分数 + 渲染端加权复合）。**全部是测量值，零假进度**。

## 7.4 网络错误分类

`timedFetch`→[E220] 总窗；`downloadGuard`→[E221] 连接期；`readWithStallGuard`→[E222] 停滞；HTTP 状态→[E201/E216/E401-402...] 按语义分派。五秒 Modrinth 搜索超时 + AbortSignal 前沿用法（Node 20 原生）。

---

# 8. 构建与部署

## 8.1 electron-builder.yml 关键点

- `appId: com.mastersunion.ember`，NSIS 非一键、per-machine=false、**`deleteAppDataOnUninstall: false`**（注释：卸载绝不能抹掉世界/存档/账户——产品价值观写进构建配置）
- publish: GitHub Releases (prathamsethiongithub/mu-launcher)
- **无代码签名**：注释记录 v25 winCodeSign symlink 提取失败史，v26 跳过工具链——代价是 SmartScreen 摩擦（R-17）
- artifactName 含 arch；files 仅 out/**+package.json（干净产物）

## 8.2 自动更新

electron-updater 6.x + 四事件（available/not-available/download-progress/downloaded）经 preload 暴露。**无更新器 UI 实现**在当前渲染器代码中（监听器存在、消费端缺失——SetupView 显示静态 "Ember v1.0.0"）。

## 8.3 跨平台现实

**Windows 专用**：JavaProvisioner 平台键硬编码 `windows-x64`、detect-java 仅 win32 路径、taskkill win32 分支、NSIS target、SMF 服务器钉 Windows 风格路径展示。macOS/Linux 无实现路径（`window-all-closed` 有 darwin 分支但是孤例）。

## 8.4 启动性能工程

splash 视频（360×360 无边框）先行 + 主窗 `show:false` → ready-to-show 只标记不展示 → `__splashDone` 轮询 + 8s 硬上限。背景色 `#0b0a09` 消白闪。renderer 2MB bundle 在视频播放期间后台编译。**主进程 bundle 单文件化**决策（禁止运行时 require 兄弟模块）是重大约束，注释三处强调。

---

# 9. 性能与优化

| 技术 | 位置 | 效果 |
|---|---|---|
| 重依赖动态 import | adm-zip（3 处）、mod-downloader | 启动路径减负 |
| Keep-alive 视图 + IntersectionObserver RAF | App/PlayView | 消除 70–95ms 导航冻结，后台零 GPU |
| renderPaused 焦点暂停 | SkinViewerCanvas | 隐藏窗口零渲染循环 |
| fs/promises 目录遍历 | WorldManager.dirSize | 大世界不阻塞主进程（曾冻结全部 IPC）|
| 流式下载+边算哈希 | net.ts 消费方 | 恒定内存，零二次 I/O |
| 单调复合进度 + 同值帧跳过 | App.tsx upsertStep | 高频事件零多余重渲染 |
| 防抖（RAM 500ms / 搜索 500ms）| SetupView/ModrinthBrowser | IPC/网络节流 |
| latest-effect-wins 序号 | ModrinthBrowser | 竞态响应丢弃 |
| 24h 皮肤磁盘缓存 + write-through | SkinService | 重复打开即时 + 上传即时可见 |
| 版本感知 JRE 缓存 | JavaProvisioner | 缓存命中跳过全部下载 |
| splash 视频门控 | index.ts | 感知启动时间≈视频时长 |

**内存管理**：无显式泄漏防护层；依赖"每启动新建 LaunchManager/Provisioner + 实例作用域 ref 清理"。`verifyHash` 全量读文件是最大单点内存峰值（大 mod 数百 MB 理论峰值，实际 mod 尺寸下可接受）。

---

# 10. 竞争优势代码级分析

## 10.1 与 MultiMC/Prism Launcher 的技术差异

| 维度 | Prism/MultiMC | Ember |
|---|---|---|
| 架构 | C++/Qt，跨平台，20 年积累 | Electron 40 + React 19 + TypeScript 严格模式 |
| 目标用户 | 通用模组玩家 | **单一服务器社区（Masters' Union SMP）一键加入** |
| Java | 手动/半自动路径配置 | Mojang 官方 JRE 全自动供给 + SHA-1 + 版本感知冒烟测试 |
| 服务器 | 手动添加列表 | **NBT 二进制注入 servers.dat** + SLP 心跳 + 人数变化原生通知 |
| 身份 | 多账户（文件级） | 双系统收敛桥 + **复活守卫**（删除前验证 legacy 清除）+ 离线 UUID 规范实现 |
| 崩溃处理 | 显示崩溃日志文件 | **Oracle**：mtime 选最新报告 + 三信号归因肇事模组 + UI 横幅预警 |
| 世界 | 实例（含存档） | 实例 + **全局设置导入**（options.txt+config/，兼容 Prism/MultiMC 目录结构）+ 备份/还原/健康检查/指标 |
| 启动反馈 | 日志窗口 | 帧级编排：WebGL 角色（四层动画大脑）+ 停滞看门狗 + 加权复合进度 |
| 防呆 | 强（20 年规则） | 中（原子写矩阵 + 缓存验证 + 自愈标记）|

## 10.2 难以复制的核心代码段（按复制难度排序）

1. **`fx/PlayerDirector.ts`（1106 行）**——四层加性姿态合成 + 颈限钳制 + Euler 轴知识的实战校准（greeting 曾读作"侧平举"的帧对比实证）。这不是算法问题，是**数百小时视觉调校的编码沉淀**。复制者拿到代码也拿不到校准过程。
2. **`net.ts` 三层超时模型 + race 语义**——reject-before-abort 的确定性 settle、吞迟到拒绝防 unhandled rejection。每一步都是真实断网事故的修复痕迹（注释可考古）。
3. **启动管线编排**（watchdog + MCLC 事件语义修正 + 取消即 error 不即 done）——与 MCLC 库的**缺陷级深度集成**知识。MCLC 的 `task` 计数器语义、`version-jar` 字节流、EPIPE 行为——这些只在踩坑后得知。
4. **Oracle 崩溃归因**——NON_MOD_PACKAGES 白名单 + 栈帧两段式包遍历 + 三信号优先级。规则库可复制，但" mixin 配置名=模组名"这类领域启发式来自真实 Fabric 崩溃语料。
5. **复活守卫 + 双系统收敛桥**——不是功能，是**正确性论证**（顺序、验证、失败中止）。删除这种代码的竞品会重新踩一遍多会话复活 bug。
6. **数据韧性矩阵**（§6.3 八项自愈）——单项简单，**系统性全覆盖**是工程纪律差异。

## 10.3 IP 保护机会

- **可注册商标**：Ember 名称 + 视觉语言（hearth/ember 概念、ForgeLine 灯丝、Temporal Ping、The Oracle 命名体系）
- **商业秘密**：PlayerDirector 全部校准常数（IDLE/GAZE/GLANCE/GREET/WAVE CONFIG——数值即产品）；Oracle 归因规则库
- **不具专利性**但具先发：全局设置导入、复活守卫、SLP 心跳通知
- **文档资产**：docs/project-truth/ 18 卷审计（claim 状态分类学 CONFIRMED/INFERRED/HISTORICAL/STALE）本身是罕见的工程流程资产，招聘/尽调时价值高

---

# 11. 技术债务与改进机会

## 11.1 已确认风险（与 project-truth/17 对齐 + 本轮复核）

**CRITICAL**
- R-01 three.js 双拷贝脆弱性：electron.vite.config.ts 别名是唯一防线，lockfile 变化可重引入 getProgram() 崩溃
- R-02 **零测试套件**（CONFIRMED：package.json 无 test script）——全部保证靠手动 harness

**HIGH**
- R-03 单提交仓库 + 巨型未提交 delta——git reset 即失一切
- R-04 mod-data.ts 静态清单腐化
- R-05 legacy 会话复活类 bug 面仍开放（守卫只护删除）
- R-06 未压缩 NBT 钉 26.1.2 行为
- R-07 孤儿 Minecraft 双实例窗口（E605 看不到上次会话的进程）

**MEDIUM**（R-08 至 R-13）：并发 Java 供给无互斥、identity.json 无 schema 版本、launch-poc 双路径漂移、WorldData 类型 5 处重复、env.d.ts 手工漂移（getJavaPath 参数实锤）。

**LOW**：run-preflight-check 孤儿、removeAllListeners 二订阅者陷阱、AuthView/DockNav 死文件、wmic 弃用、皮肤快速切换竞态。

## 11.2 本轮新增发现（project-truth 未列）

1. **WorldManager 写锁是伪锁**：同步代码无让步点，`while(writeLock)` 自旋在单线程 JS 中永不等待——防御性冗余，但注释声称防 IPC 竞态的论证不成立（IPC 处理本就串行）
2. **`verifyHash`/mod 下载全量内存读**：`readFileSync`/`arrayBuffer` 对 100MB+ 资源包有峰值风险（mod-installer verifyHash 可改流式）
3. **SetupView 存根密度高**：Open Folder/Clear Cache/分辨率均为 console.log——用户可见的假按钮
4. **modrinth-download 与 mod-download 通道并存**：后者带兼容过滤，前者无——不一致的 API 面
5. **splash 8s 硬上限 vs 慢盘**：低配机 2MB bundle 编译可能超 8s，视频结束后白窗窗口存在（低概率）
6. **`launch-poc` root 参数未过 validatePath**（launch-game 有）——内部面但不对称

## 11.3 性能瓶颈排序

1. `copyDirSync` 世界深拷贝（同步、主进程阻塞）——duplicate-world 大世界卡 UI
2. verifyHash 全量读内存
3. 三.js 双上下文常驻（keep-alive 代价）——低端 GPU 显存占用
4. 每次启动重建 LaunchManager + 全量 MCLC 监听器（微小但模式可优化）

## 11.4 安全隐患

- Modrinth 下载无哈希校验（TLS 信任即可，但断链/中间人风险面大于 Mojang 路径）
- safeStorage 后端强度 UNKNOWN（project-truth 已标）
- `select-directory`/`select-mod-file` 返回绝对路径给渲染器——与皮肤路径隔离原则不一致（低危：仅回显用户自选）
- NSIS 未签名（SmartScreen 拦截 → 用户绕过习惯培养，安全文化成本）

## 11.5 缺失测试覆盖

全部。优先补测序：① net.ts 三函数（纯函数易测）② update-checker isNewerVersion（边界丰富：0.6.9 vs 0.6.13、build metadata、异端版本）③ crash-diagnostic detectModName/detectReason（正则+白名单，样例驱动）④ world-manager 注册表三态 ⑤ identity 离线 UUID（对照官方算法）。**这五个是纯逻辑模块，无需 Electron mock，投入产出比最高。**

---

# 12. 商业化潜力

## 12.1 可付费高级功能（按实现距离排序）

| 功能 | 实现基础 | 定位 |
|---|---|---|
| **Ember Pro 皮肤工坊** | IdentityView 已有上传/预览/3D；加历史/预设/多人皮肤同步 | ¥15/月 社区变现 |
| **世界快照云备份** | backupWorld ZIP 管线现成；加 R2/S3 上传 | 对标 CurseForge，¥10/月 |
| **服务器增长仪表盘** | SLP 心跳已 60s 运行；加历史曲线/加入提醒规则 | 面向服主 B 端 |
| **一键实例分享** | world rootPath 模板 + .mrpack 导入已有；补 modrinth.index.json files[] 下载 | 社区传播引擎 |
| **Oracle Pro** | crash-diagnostic 已归因；加 Modrinth 自动修复建议（"Sodium 0.6.13 修复此崩溃"→一键更新，perform-mod-update 已存在） | **差异化卖点，几乎免费实现** |
| **无广告纯净承诺** | 现状即卖点 | 定价锚 |

## 12.2 企业授权可能性

- **教育机构**（Masters' Union 自身即原型客户）：启动器白标 + 课程服务器钉版 + 学生账户池（IdentityService 多账户已支持）→ SaaS 化
- **服务器托管商**：嵌入式 SLP 监控组件 + 加入通知 SDK 授权
- **MC 社区联盟**：多服务器钉版配置中心（ServerInjector 已参数化潜力——构造器可注入）

## 12.3 市场定位

**不要做"更好的 Prism"**——C++/Qt 20 年积累不可追。Ember 的护城河是**垂直体验**：

1. **"零思考启动"**：从安装到进服的三次点击（装→登录→Play），全程自动 Java/Fabric/模组/服务器注入
2. **"崩溃不再神秘"**：Oracle 是全市场唯一"UI 点名肇事模组"的启动器
3. **"启动器有灵魂"**：WebGL 角色注视你、挥手送你进服、人数变化通知——情感差异化，竞品的工程文化不可能复制（PlayerDirector 的校准史无法并购）
4. **社区即分发**：SMP 钉死设计让启动器成为服务器成员的**必备客户端**——获客成本≈零，留存由服务器绑定保证

**一句话定位**：*Ember is not a launcher. It's the front door to your community's world.* —— 对 Prism 是工具竞争，对 Ember 是**身份竞争**。

---

## 附录 A：错误码全表（源码考古）

| 码域 | 模块 | 代表 |
|---|---|---|
| E1xx | Auth | E101 无 Java 版所有权 / E103 登录失败 / E106-E107 刷新 / E108 取消 |
| E2xx | 网络 | E201-E218 Java 供给链 / E220-E222 三层超时 |
| E3xx | 启动 | E301/E303 launch 失败 / E306 停滞 / E307 取消 |
| E4xx | Fabric | E401-E406 |
| E5xx | 注入 | E501/E502 |
| E6xx | IPC | E602 未认证 / E603 无可取消 / E604/E605 重入 / E608 路径/世界 / E609 会话过期 |

## 附录 B：与提示词 8 模块对照（历史结论维持）

提示词功能清单 8 项中 7 项已实现且多数超出（见先前对话），唯一缺口是"游戏内截图/成就展示"。提示词的技术栈要求（Rust/antd/SQLite）与 Ember as-built 相悖，按用户决策**忽略冲突技术栈，保留 Ember**。
