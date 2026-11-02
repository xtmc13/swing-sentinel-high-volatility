# Task 7 Report — TS 动量接受、Replay 与快速退出

## Status

已在 `feat/mainnet-momentum` 完成本地实现、测试和提交，未 push。动量仍默认 `momentumEnabled=false`、`strategyMode=SWING`；候选只通过现有 `TradingEngine` / `ExecutionCoordinator` / adapter 路径，不能绕过风险、健康、autoTrade 或主网 armed 门控。未使用真实凭据、真实订单、preview DB 或 preview server。

代码/测试提交：`749732dc2d2f7231e244430b2ae473d64f285910`（`feat: integrate TS momentum acceptance and exits`）。本报告单独提交，以保持上述 SHA 精确对应代码和测试。

## RED / GREEN evidence

- 中断现场基线：`momentum.test.ts` 7 项通过；`momentumReplay.test.ts` 的早期候选用例 RED，原因是已收盘 1m K 线被 1 秒阈值误判为断流。将滚动窗口新鲜度改为正常 60 秒收盘间隔加信号 TTL 后，10/10 GREEN。
- 快速退出与协调器 RED：新增无跟随、跌回突破位且流向反转、镜像空头、side-flip replay、默认关闭和 coordinator close 用例，首轮 6 项按预期失败（函数缺失、跨方向错误确认、默认仍进入 adapter、未平仓）。实现后 30/30 GREEN。
- Engine 接收 RED：两个实际 engine 用例因 `receiveMomentumCandidate` 不存在而失败；零反向主动量用例同时暴露 boolean/number coercion 导致合法单边流被拒。实现 engine 接收和无限大方向比后，相关 58/58 GREEN。
- 内部入口 RED：回环地址用例因 `isLoopbackRemoteAddress` 缺失失败；实现 literal IPv4/IPv6/IPv4-mapped loopback 校验并注册 64 KiB 内部候选端点后通过。
- 安全复核 RED：旧 generation replay 破坏当前确认、参考价不一致/点差超限被接受、paper IOC 实际定价超过动量限价仍被接受，三项均先失败；修复后 focused 77/77 GREEN，`npm run check` 通过。
- 改单 RED：真实 adapter 的 fake-transport 用例首次暴露测试夹具未确认 cancel；修正夹具后第二次改单按预期 RED。实现每 intent 最多一次、重启后从持久化订单恢复计数，liveExecution focused 10/10 GREEN。

## Implementation

- `api/services/momentum.ts`：严格 candidate/frame schema；默认参数；4H/1H 方向、15M 结构、120 秒突破与 buffer、深度/主动量/burst/P80、双边追价上限、真实触发价止损与目标；动量快速退出决策；回环 peer 校验。
- `api/services/momentumReplay.ts`：时间戳 trade/order-book/feature-frame replay；有界微结构历史；连续两次同方向确认；重复/旧 generation/断流抑制；明确不代表 5m 回测一致性、成交或盈利。
- `api/services/engine.ts`：内部候选接收入口，刷新合约和波动状态，加载实际高周期/1m 数据与风险基线，执行健康/代际/状态版本/持仓门控；`autoTrade=false` 只接受机会，不调用执行 adapter。
- `api/services/executionCoordinator.ts`：动量默认关闭的二次防线、过期和 signalId 幂等、入场元数据与新鲜 frame 观察、无跟随/流向反转退出；先执行原 adapter manage，再走同一 adapter close，未结算退出不重复提交。
- `api/services/execution.ts`：paper 定价也执行 MOMENTUM IOC limit，避免模拟路径越过追价上限；既有 size/portfolio/HIGH/EXTREME/强平缓冲门保持原调用链。
- `api/live/liveExecution.ts`：IOC entry 最多改单一次；以 store 中同 intent 的持久化 sibling orders 恢复重启后的额度，进程内计数防止并发越过上限。
- `api/boot.ts`：`POST /v1/momentum/candidate`，仅 literal loopback peer、64 KiB body limit、无效 JSON 400；候选交给 engine，而非订单客户端。
- `contracts/trading.ts`：Opportunity 增加可选 `breakoutPrice`，供既有持仓链执行失败突破退出。
- 测试：`api/services/momentum.test.ts`、`momentumReplay.test.ts`、`engine.test.ts`、`executionCoordinator.test.ts`、`paper.test.ts`、`api/live/liveExecution.test.ts`。

## Verification

从 worktree 根目录运行：

- Focused acceptance/replay/engine/coordinator/paper：77 passed，0 failed。
- Focused live adapter/restart replacement：10 passed，0 failed。
- `npm test`：37 files passed，4 skipped；359 passed，53 skipped，0 failed。53 项均为需要专用数据库环境的既有 integration 测试；按任务限制未访问 preview DB。
- `npm run check`：exit 0。
- `npm run lint`：exit 0。
- `git diff --check`：exit 0（代码提交前）。

完整测试中的 engine stderr 是既有错误隔离用例主动记录的预期日志，对应测试全部通过。

## Concerns / follow-up

- 参数仍是待校准工程默认值；replay 不证明盈利能力，也没有用 5m K 线冒充微结构。P80 使用现有一分钟收益基线的绝对值，与 Rust 短窗 log-return realized volatility 的量纲/采样口径仍需后续校准。
- 快速退出的 opportunity/frame 关联目前是 coordinator 进程内状态。进程重启后，交易所原生硬止损、现有对账和 emergency 仍保留，但 120 秒无跟随和流向反转的自动关联需要后续持久化恢复；Rust 当前只发送候选，因此流向反转退出也依赖收到新的有效候选 frame，而非持续全量 frame 流。
- 未运行真实 DB migration/integration、服务器或任何真实网络/账户/订单调用；这些不在本任务的授权验证范围内。


## Review fix round 1

代码/测试/迁移提交 SHA：`a53e8e306838ff5f0d185220883f5c252658c890`（`fix: harden momentum live gates and recovery`）。本报告更新单独提交；未 push，未使用真实凭据、真实订单、preview DB/server 或真实交易调用。

### RED / GREEN

- Live 限价 RED：`prepareIntent=100.01` 超过已接受 `opportunity.limitPrice=100` 仍成功；`100→100.01` 改单也成功。修正旧测试的错误成功预期后，两个用例均先失败。GREEN：初次意图同时校验机会限价及方向一致的 bps/ATR 上限；验证后的上限写入 `live_orders.max_entry_price`，替换单继承并在重启后仍执行相同上限。原有一次改单/重启用例继续通过。
- Live HIGH RED：相同输入 NORMAL quantity=100，HIGH 仍错误为 100；adapter  finalGate 也收不到事务模式。GREEN：`createLiveIntent` 在事务中锁定 `trading_settings` 和该 symbol 的 `volatility_states`，传递 `{mode, highVolatilityRiskMultiplier}`；精确风险计算在 HIGH 下数量/估计风险减半，EXTREME 拒绝。Focused liveRisk + liveExecution：21 passed。
- Replay parity RED：深度不达标的 GOOD frame 后接合格 frame 被错误确认；6 秒前主动量被旧 5 秒窗口丢弃。GREEN：TS acceptance/replay 共用完整 `qualifiedMomentumSide` 门槛，return/flow 默认均为 10 秒；parity 和窗口回归通过。Focused momentum + replay：20 passed。
- 持续退出/持久化 RED：durable store 和 frame 接收不存在；随后将持仓 mark 故意保持旧值、只让新 frame 跌回突破位，退出仍失败。GREEN：Rust 每个 feature frame 通过既有 no-proxy/no-redirect loopback client 发至 `/v1/momentum/frame`；TS 持久化 frame 并立即评估，使用新鲜 frame 的 mark，无需候选或 20 秒 tick。Coordinator focused：17 passed。
- 重启状态：paper/live PositionView 现在携带持久化 signalId、strategyType、breakoutPrice、entryPrice、exitPending；最新 frame 存入 `momentum_frames`，pending 在 close 前写入并在明确失败时清除。测试使用未调用 open 的新 coordinator 验证元数据/frame 重hydrate，以及第二个 coordinator 不重复提交 pending exit。
- Paper 幂等 RED：两个 service 实例面对已持久化 momentum signal 仍继续市场/开仓流程。GREEN：在行情工作前查询持久化 signalId，`positions_signal_unique` 为并发竞争提供数据库唯一兜底；focused 1/1 passed。
- 离线生成 `db/migrations/0009_momentum_durability.sql` 及 snapshot；未执行迁移或连接数据库。

### Final verification

- `npm test`：38 files passed，4 skipped；**366 passed，53 skipped，0 failed**。
- `npm run check`：exit 0；`npm run lint`：exit 0。
- Rust `cargo test`：**35 passed，0 failed，1 ignored**（既有真实公共网络 smoke，未运行）。
- Rust `cargo fmt --check` 与 `cargo clippy --all-targets -- -D warnings`：exit 0。
- 代码提交前 `git diff --check` / staged diff check：exit 0。

本节取代上一版“快速退出仅进程内、Rust 只发送候选”的限制：现已有持久化恢复和连续 frame 路径。真实 DB integration 仍因任务边界保持 skipped；参数校准和不盈利保证的限制不变。
