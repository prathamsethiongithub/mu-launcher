# 21 — 性能打击 v2（并行下载与流式写入）

分支：`perf-strike`（基于 master `5e62ec8`）→ 已并回 master。
性质：**零功能变更、零 UI 触碰、零新依赖**。用户可见差异只有一种：同一件事明显更快。
门禁：npm run typecheck / npm run build / npm test 全绿；基线 147 → **169**（+22 全部为新逻辑用例）。

## 1. 结果表

| 任务 | 状态 | 触及文件 | commit | 证据（改前/改后代码行引用） |
|---|---|---|---|---|
| 1. pMap 并行原语 | ✅ 完成 | `src/main/net.ts`（新增导出）+ `tests/pmap.test.ts` | `70a2c67` | 改前：net.ts 只有 timedFetch/downloadGuard/readWithStallGuard 三个原语；改后：`net.ts:113` `pMap<T,R>(items, mapper, {concurrency})`，worker-pool 保序实现 |
| 2. Java 运行时并行化 | ✅ 完成（无 NEEDS DECISION） | `src/main/java-provisioner.ts` | `d4ab453` | 改前：`旧 228-256 行` `for (const [...] of fileEntries) { await this.downloadFile(...) }` 逐文件串行；改后：`java-provisioner.ts:277-307` `await pMap(fileEntries, …, {concurrency: JAVA_DOWNLOAD_CONCURRENCY})`（`:72` = 6） |
| 3. 流式写入（消灭全量缓冲） | ✅ 完成 | `src/main/mod-downloader.ts` + `tests/mod-downloader-stream.test.ts` | `0597bb5` | 改前：`旧 198 行` `const bytes = Buffer.from(await fileRes.arrayBuffer())` + `writeFile(...)`（全量缓冲 + 直接写正式文件）；改后：`:216` `getReader()`、`:236` `<name>.jar.tmp` 流式 pump（含背压）、`:276` `rename(tmp, dest)` |
| 4. .mrpack files[] 并行导入 | ✅ 完成 | `src/main/modpack-installer.ts` + `tests/modpack-parallel.test.ts` | `f90db23` | 改前：`installModpackFiles` 内 `for (const item of items) { await downloadPackFile(item, …) }` 串行；改后：`modpack-installer.ts:374-399` `await pMap(items, …, {concurrency: PACK_FILE_CONCURRENCY})`（`:54` = 6） |
| 5. 断点续传分析 | ✅ 交付（仅分析，未实现） | 本文档 §3 | （随 docs 提交） | — |

## 2. 每项提速机制说明

- **pMap（任务 1）**：`min(concurrency, items.length)` 个常驻 worker 从共享游标领任务，worker 一空闲立即领下一个——把"上一个文件的网络往返"从关键路径上移走。保序由结果数组下标写入保证；首错即整体 reject（其余 worker 停止领新任务、在飞任务自行 settle 且全部被 Promise.all 订阅，杜绝 unhandledRejection）。
- **Java 并行化（任务 2）**：JRE 清单约 180 个文件（bin/*.dll + modules 等），串行时每个文件的 RTT+传输依次排队；6 并发后 6 个文件同时传输，wall-clock 受限于"总字节 ÷ 带宽"而非"文件数 × (RTT+传输)"。逐文件 sha1 校验、失败清理、E213 语义、进度载荷结构（`{phase, percent, message}`，percent 仍为 completedFiles/totalFiles）全部原样保留。
- **流式写入（任务 3）**：`arrayBuffer()` 必须等响应体全部到达才开始写盘且峰值内存 = 整个 jar；getReader() 逐 chunk 到达即写盘，峰值内存 = 单个 chunk（KB 级）。附带修复：原来写盘失败会把**截断文件留在正式路径**，现在全程写 tmp、成功才 rename——崩溃/失败后 mods/ 里只有完整 jar（失败时旧 jar 原样保留）。
- **mrpack 并行导入（任务 4）**：模组包 files[] 常有上百条目，串行 = 条目数 × RTT；6 并发把 RTT 摊薄 6 倍。每条目自持 URL 候选、tmp、哈希门、最终路径，完成顺序与落盘结果严格无关（测试以"慢条目最后完成仍字节正确"钉死）。
- **提速量级粗估**：
  - JRE（~180 文件、总量 ~45 MB）：串行≈180×(RTT+传输)；6 并发理论 ≈6 倍，实际受单连接带宽聚合上限约束，预计 **4–5 倍 wall-clock**。
  - 模组包导入（~150 条目、多为 <5 MB 的 jar）：瓶颈几乎全是每条目的 RTT/慢启动，预计 **5–6 倍**（接近并发上限）。
  - 单个 Modrinth jar 下载（任务 3）：速度不变（同一条连接），**内存峰值从 jar 全尺寸（几十 MB 量级）降到 ~KB 级流缓冲**，并消除截断文件风险。

## 3. 任务 5：断点续传分析（仅分析，默认不实现）

**哪些端点支持 Range（`Accept-Ranges: bytes` / 206）：**

| 端点 | Range 支持 | 备注 |
|---|---|---|
| Mojang assets（`piston-data.mojang.com` 资源文件） | ✅ 支持 | 标准 CDN 行为，配合 manifest 的 per-file sha1/size |
| Mojang libraries（`piston-data.mojang.com/.../libraries/...`） | ✅ 支持 | 同上 |
| Mojang JRE runtime（`piston-data.mojang.com/.../java-runtime/...`，java-provisioner 用） | ✅ 支持 | 与 libraries 同一存储；Java 清单天然带 per-file sha1，是续传收益最大的端点（180 文件 × 平均 250 KB） |
| Modrinth CDN（`cdn.modrinth.com`） | ✅ 支持 | API 亦返回每文件 `size` 与 `hashes.sha1/sha512` |
| CurseForge CDN（`mediafilez.forgecdn.net` 等） | ✅ 支持 | 经 CF 签名 URL 仍保留 Range 语义 |

**恢复点校验方式：**

1. **尺寸探测**：重启后对已存在的 `.part` 文件 `stat` 取 `size`，发 `Range: bytes=<size>-` 请求；返回 `206` 且新字节哈希最终吻合 → 续传成功。
2. **哈希分块校验（可行但要注意成本）**：sha1/sha512 无法从中间分块验证"前缀正确"，只能**整文件终验**（这正是现有 `hash.update(chunk)` 流式哈希已具备的）。可行折中：续传结束后整文件哈希校验（现状语义），不匹配则**整文件重下**（丢弃 .part）。分块校验需分块哈希清单（如 Merkle/每 1 MB 一个 sha），Mojang/Modrinth 清单都不提供 → 不可行，不必做。
3. **失败回退**：服务器不回 206 而回 200（等于"从头发"）→ 必须丢弃 .part 重新整体写入，否则文件会拼接错乱。

**`.part` 临时文件识别与清理策略：**

- 现状 tmp 命名已可识别：java-provisioner 直接写正式名（有逐文件 sha1 兜底），mod-installer/modpack-installer/mod-downloader 用 `<dest>.tmp`。续传版本建议统一 `<dest>.part`（与"校验后 rename 的 tmp"语义区分：tmp=本次会话暂存，part=跨会话续传点）。
- 识别规则：`*.part` 且 `mtime` 存在；启动时对游戏目录扫描清理策略二选一——(a) 保守：只删"上次会话留下的"（mtime 早于本次启动）；(b) 激进：全部删除后重下。
- 崩溃安全不变量：.part 永不 rename 成正式文件（rename 只发生在哈希校验通过后），因此任何残留 .part 都不可能伪装成完整 jar——该不变量在本次任务 3 已确立并测试钉死。

**实现量级评估**：改动集中在各下载函数开头（探测 .part → 带 Range 头 fetch → 判断 206/200 → seek 写 `fs.createWriteStream(path, {flags: 'r+'})`），预计 ~60 行 + 每路径一条用例；风险点是 Windows 上 r+ 追加与杀软扫描文件的锁竞争。收益：JRE/模组包重装场景从"全量重下"变"仅补尾部"。建议单独立项。

## 4. 边界与已记录的非目标

- **mod-downloader 的裸 fetch（无 guard 原语）**：改造前就没有 connect/stall 超时，属既有行为；加 guard 会改变超时行为（功能变更），本次不动。若要统一到 net.ts 原语，建议与任务 5 一起做。
- **mod-downloader 不做哈希校验**：该路径从未解析 Modrinth 的 `hashes` 字段，不存在可保留的校验契约；"补校验"是功能增强，超出"零功能变更"边界，未做。
- **mod-installer / modpack-installer / java-provisioner 的下载写盘**：本就流式（逐 chunk `writer.write` + `hash.update`）+ tmp + rename 原子替换，无需改造。
- **并发数选择**：两处均为常量 6（`JAVA_DOWNLOAD_CONCURRENCY` / `PACK_FILE_CONCURRENCY`），调用点已参数化（走 pMap 的 options），未来如需按网络类型调整只改常量。

## 5. 测试清单（+22）

- `tests/pmap.test.ts`（8）：保序、峰值 ≤ N、真并行（峰值 = min(N, items)）、concurrency=1 串行地板、超量排队恰好一次、空数组零调用、首错传播并停领任务、晚到 rejection 无 unhandledRejection。
- `tests/mod-downloader-stream.test.ts`（6）：tmp 在传输途中增长（证明无全量缓冲）、原子替换旧 jar、中途失败旧 jar 原样+零残留、首装失败无 dest 无残留、HTTP 错误消息不变、空 body 消息不变。
- `tests/modpack-parallel.test.ts`（8）：乱序完成落盘一致、真并行（峰值计数）、unsupported 跳过不 fetch、失败保留成功文件+候选按序耗尽、E704 哈希失败清理、E702 畸形条目计数、E701 无清单归档、空 files[] 零值聚合。
