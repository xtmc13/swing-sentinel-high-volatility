# Task 8 Report — Dashboard 与管理操作

## Status

已在 `feat/mainnet-momentum` 完成本地实现、验证和提交，未 push。保留现有 HashRouter、路由、Industrial terminal 样式、语义表格、定义列表、表单 label、键盘滚动区域和 alert。未使用真实凭据、真实订单、preview DB 或 preview server。

代码、测试和迁移提交：`d4bcceacde65aff64e78c03c0ebb88c77c6e8bf1`（`feat: add live execution readiness controls`）。本报告单独提交，以保持上述 SHA 精确对应实现树。

## RED / GREEN evidence

### 首轮 RED

新增 coordinator/router/live adapter/private WS/SSR panel 测试后运行 6 个既有文件和新 panel 文件：

- 6 个文件失败；10 个测试按预期失败，53 个既有测试通过。
- 失败原因分别为：fresh admin 精确校验不存在；`setLiveControls` / `setExecutionMode` 路由不存在；dashboard 尚未经过 coordinator；`openManual` / `setArmed` / `status` 不存在；manual canary 在 autoTrade=false 时被 CANCEL；`UserDataStream.health` 不存在；`ExecutionStatusPanel` 模块不存在。
- 无权限用例最初得到 `NOT_FOUND`，证明路由尚未注册；实现后由 admin middleware 返回 `UNAUTHORIZED`（tRPC HTTP 映射 401），且不触及 coordinator armed。

随后为真实订单读模型新增 `liveOperations.test.ts`：因 `liveOperations` 模块不存在而 RED，覆盖真实状态、已成交数量、成交均价、手续费、未结意图和对账问题。

### 第二轮 RED

- LIVE 未配置 adapter 时 dashboard 仍抛出“LIVE_MAINNET adapter 尚未配置”，无法安全 disarm；新增用例确认不得回退 paper 账户。
- `liveSubmissionPolicy.test.ts` 因共享提交策略不存在而 RED，覆盖 manual canary 只绕过 autoTrade，不能绕过 emergency generation 或 PENDING_SEND 状态。

### GREEN

- 实现后首轮 focused：7 files / 66 tests 全通过。
- 修复既有 live coordinator 测试夹具，使其显式注入本地 passing preflight，而非删除新门控。
- 完成 LIVE unavailable dashboard、共享 manual admission、live operations、私有 WS 健康和页面接线后，focused 最终为 **10 files / 71 tests passed，0 failed**。
- `src/lib/executionFeedback.test.ts` 包含失败平仓/未结算紧急停止不显示成功的既有回归，focused 中通过。
- SSR panel 测试明确验证 `PAPER · 模拟`、`LIVE · 真实`、凭据未配置、预检/私有 WS/对账和缺失止损 alert。

## Implementation

- `contracts/trading.ts`：新增执行状态、预检、动量健康、未结风险、对账、私有 WS、真实订单/意图/问题视图契约；dashboard 携带这些真实数据。
- `api/services/executionCoordinator.ts`：
  - close/emergency 之外，dashboard 和模式/armed 状态统一经过 coordinator。
  - 聚合真实持仓、live orders、未结意图、对账问题、私有 WS 和动量 frame 新鲜度；LIVE 持仓无有效 STOP_MARKET 时给出保护缺失警告。
  - LIVE adapter 缺失时返回明确不可用账户状态，绝不回退 paper 数据，仍允许读取状态和 disarm。
  - armed 与 open 串行化；armed 要求 LIVE_MAINNET、MAINNET 行情、环境总开关、live adapter 和完整 preflight。每次真实 open 都重新执行 preflight。
  - `openManual` 只绕过 autoTrade，其他门控不变。凭据仅返回 `credentialsConfigured` 布尔值，不返回内容。
- `api/tradingRouter.ts`：新增专用 `setExecutionMode` / `setLiveControls`；armed 同时要求当前 Bearer 管理员会话、重新输入的 APP_SECRET 和精确短语 `ARM LIVE MAINNET`。disarm 不依赖 preflight。普通 `saveSettings` schema 继续剥离 executionMode/armed/liveControls，保存时从当前设置保留执行模式。
- `api/admin.ts`：新增常量时间 fresh-secret 精确比较，并复用于 Bearer 校验。
- `api/live/liveOperations.ts`：从实际 order store / reconciliation store 读取订单状态、已成交/原数量、成交均价、手续费、未结意图及未解决问题。
- `api/live/liveExecution.ts`、`livePersistence.ts`、`drizzleLiveOrderStore.ts`、`orderStateMachine.ts`：manual canary 的 admission class 持久化到 live intent；自动与手动提交都复核 emergency generation 和 intent 状态，只有自动提交要求 autoTrade。
- `api/live/userDataStream.ts`：健康来自实际 running/socket/reconciliation/message/reconnect 状态，不是静态占位。
- `api/live/reconciliation.ts`、`drizzleLiveOrderStore.ts`、`orderStateMachine.ts`：将既有 constructor parameter properties 改为显式字段，满足项目 `erasableSyntaxOnly` 检查，无行为变化。
- UI：
  - `src/components/ExecutionStatusPanel.tsx` 显示模式、预检、armed、适配器、凭据配置状态、动量、未结数量、对账、私有 WS 和保护警告。
  - `src/pages/RiskPage.tsx` 增加独立 PAPER/LIVE 切换、fresh-auth armed 表单和立即可用 disarm；紧急停止保留真实未结算错误反馈，LIVE 不显示 paper reset。
  - `src/components/TerminalLayout.tsx`、`src/pages/Home.tsx` 的账户、引擎、持仓和平仓文案按 PAPER/LIVE 标识。
  - `src/pages/PositionsPage.tsx` 在 LIVE 显示真实订单成交/均价/状态以及未结意图和对账明细，不拿 paper 订单冒充真实订单。
- 配置与迁移：
  - `.env.example` 仅添加空白凭据和 `LIVE_TRADING_ENABLED=false` 示例。
  - `db/schema.ts`、`db/migrations/0011_lively_tarantula.sql`、snapshot/journal 添加 `live_intents.manual_canary`，默认 false。
  - Drizzle 首次 generate 因无 DATABASE_URL 拒绝；随后使用明确 dummy 的本地 URL 完成纯离线生成，没有连接或迁移数据库。

## Files

实现：`contracts/trading.ts`、`api/admin.ts`、`api/tradingRouter.ts`、`api/services/executionCoordinator.ts`、`api/live/liveOperations.ts`、`api/live/liveExecution.ts`、`api/live/livePersistence.ts`、`api/live/drizzleLiveOrderStore.ts`、`api/live/orderStateMachine.ts`、`api/live/reconciliation.ts`、`api/live/userDataStream.ts`、`db/schema.ts`、`db/migrations/0011_lively_tarantula.sql`、`db/migrations/meta/0011_snapshot.json`、`db/migrations/meta/_journal.json`、`.env.example`、`src/components/ExecutionStatusPanel.tsx`、`src/components/TerminalLayout.tsx`、`src/pages/Home.tsx`、`src/pages/PositionsPage.tsx`、`src/pages/RiskPage.tsx`。

测试：`api/admin.test.ts`、`api/tradingRouter.execution.test.ts`、`api/tradingRouter.dashboard.test.ts`、`api/services/executionCoordinator.test.ts`、`api/live/liveExecution.test.ts`、`api/live/liveOperations.test.ts`、`api/live/liveSubmissionPolicy.test.ts`、`api/live/userDataStream.test.ts`、`src/components/ExecutionStatusPanel.test.ts`；既有 `src/lib/executionFeedback.test.ts` 作为失败退出回归验证。

## Verification

从 worktree 根目录运行，最终代码提交前重新完整验证：

- Focused：10 files passed；**71 passed，0 failed**。
- `npm test`：41 files passed，4 skipped；**385 passed，53 skipped，0 failed**。
- `npm run check`：exit 0。
- `npm run lint`：exit 0。
- `npm run build`：exit 0；Vite 2440 modules，Node boot bundle 完成。
- `git diff --check` 和 staged diff check：exit 0。

53 项 skipped 均为需要专用数据库环境的既有 integration 测试；按任务限制未连接 preview DB。完整测试中的 engine stderr 是错误隔离用例主动记录的预期日志，对应测试全部通过。build 仅报告既有 boot bundle 约 2.5 MB 的体积提示，无构建错误。

## Concerns / follow-up

- 按“不得启用真实订单”的边界，本任务没有把真实 Binance adapter、签名客户端、私有 WS 或完整 preflight 组装进 singleton；因此默认部署的 LIVE 会明确显示未配置并失败关闭，armed/open 不会发送真实订单。后续接入时必须把这些真实健康/预检提供者注入 coordinator，不能把 missing 当成 ready。
- 手动 canary 已有 coordinator/adapter/persistence 安全路径，但未新增公共页面下单按钮，也未进行真实 canary。
- 新迁移只离线生成，未执行；真实 DB integration 继续 skipped。上线前需在授权环境执行迁移和集成验证。
- 私有 WS 健康已可由实际 `UserDataStream.health()` 注入；singleton 未注入时显示未配置/未连接。动量健康使用本进程最近有效 frame，重启后收到新 frame 前会显示未就绪。
- 未启动 preview server 或浏览器端到端会话；UI 通过 SSR 可访问性/文案测试、TypeScript、lint 和生产 build 验证。
- live operations 当前从 store 读取后按时间截取 60 条展示；若长期订单量很大，可后续把分页/排序下推数据库。


## Review fix round 1

代码/测试提交 SHA：`117de47aaea51936824ba5eba88f213131aca5c2`（`fix: enforce current live admission gates`）。本报告更新单独提交；未 push，未使用真实凭据、真实订单、preview DB/server 或真实交易调用。

### RED / GREEN

- 首轮 review RED：8 个文件失败，9 个测试按预期失败，另有 `executionStatus` 套件因模块不存在而失败；53 个其他 focused 测试通过。失败覆盖 disarmed DB admission 仍进入 SUBMITTING、跨 worker disarm 后仍提交、armed/LIVE 策略缺失、dashboard 设置快照混用、MAINNET 凭据不被识别、当前健康门控被忽略、预检在私有 WS 不健康时仍显示通过，以及 live operations 没有有界/独立保护查询。
- 当前授权 guard RED：`createLiveAdmissionGuard` 不存在；实现后逐次重读环境并重新运行预检，环境关闭或成功预检时间陈旧均拒绝，且没有缓存 ready。
- 最终 transport RED：第二个 admission 检查时 disarm 仍错误返回开仓成功并调用 fake gateway；guard 自身抛错但本地状态不变也曾可能继续。实现第二次 locked/current admission 和拒绝即 CANCEL 后，两项均通过，fake gateway 调用为 0。
- 修复成功测试夹具，使其显式提供 MAINNET 假凭据、新鲜私有 WS/对账、有效 frame 和 confirmed reduceOnly STOP_MARKET；不健康用例仍逐项保留失败条件，没有删除门控。
- 最终 focused review：**9 files / 71 tests passed，0 failed**。

### Fixes

- `livePersistence.ts`：`lockLiveControls` 在同一事务中 `FOR UPDATE` 读取 armed 和 emergency generation。create/assert/admit 都要求当前 armed + LIVE_MAINNET + 合法 intent 状态 + generation，且必须调用 server-owned 当前环境/预检 guard；不接受客户端 ready 布尔值。
- `setLiveArmed` / `disarmLiveExecution` / `pauseLiveExecution`：模式和控制行加锁；disarm/emergency 设置 armed=false、递增 generation，并将 PENDING_SEND/SUBMITTING intents/orders 置为 CANCEL。生产默认 armed 写入不再使用无事务 upsert。
- `drizzleLiveOrderStore.ts` / `orderStateMachine.ts` / `liveExecution.ts`：所有 entry worker 共用当前 admission 签名；在首次 SUBMITTING 后、实际 transport 前再执行一次 admission。guard 缺失、抛错、disarm、模式或 generation 变化均失败关闭。跨 worker 共享 store 回归覆盖两个 worker 均无 transport。
- `tradingRouter.ts` / `ExecutionCoordinator.dashboard()`：dashboard 设置来自 coordinator 同一快照，标签和组合风险不再使用独立读取的旧 PAPER/LIVE 设置。
- 当前 readiness：每次 status/dashboard/open/arm 重新获取预检；成功结果必须有非未来且不超过 10 秒的 checkedAt。canSubmit 同时要求凭据、环境、armed、adapter、新鲜 preflight、私有 WS 运行/连接/消息新鲜、对账运行/新鲜/无严重问题、按需动量 frame、已确认保护和 autoTrade。手动 canary 仍只豁免 autoTrade。
- 对账健康不再硬编码为正常；未配置、未运行、陈旧或严重问题均不健康。UI 在有任一当前 gate reason 时不能显示“预检通过”；PAPER 显示不适用。
- `TerminalLayout.tsx` 使用 `executionEngineActive`：PAPER ACTIVE 看 autoTrade，LIVE ACTIVE 必须 canSubmit；暂停/启动按钮仍只操作 autoTrade，不混用健康状态。
- 保护判断改用独立 `protectionOrders`，只接受 reduceOnly STOP_MARKET 的 NEW/PARTIALLY_FILLED；PENDING_SEND、SUBMITTING、UNKNOWN、RECONCILING、非 reduceOnly 均不确认保护。
- `.env.example` 与 coordinator 统一使用 `BINANCE_MAINNET_API_KEY` / `BINANCE_MAINNET_API_SECRET`，凭据状态复用 `getLivePublicStatus`。
- `liveOperations.ts` / stores：最近订单 SQL 下推 limit 60，dashboard 对账/意图各 limit 100；active protection 独立查询。订单 fills 改为按订单 ID 批量 `IN` 查询，消除展示路径 N+1，且最近 60 条截断不会隐藏活动止损。内部 reconciliation 的无 limit 全量读取保持不变。

### Final verification

- Focused review：9 files passed；**71 passed，0 failed**。
- `npm test`：42 files passed，4 skipped；**401 passed，53 skipped，0 failed**。
- `npm run check`：exit 0；`npm run lint`：exit 0。
- `npm run build`：exit 0；Vite 2441 modules，Node boot bundle 完成。
- `git diff --check` / staged diff check：exit 0。

真实 DB integration 仍按任务边界 skipped；相关 fixture 已更新为 armed/generation 基线和 server-side guard，但需在授权专用数据库环境后续执行。disarm 会阻止新的 admission 和最终 transport 检查；已经实际进入交易所 transport 的请求不能靠界面状态撤回，仍由既有 UNKNOWN/reconciliation 流程确认结果。本节取代上一版 live operations 未下推限制。
