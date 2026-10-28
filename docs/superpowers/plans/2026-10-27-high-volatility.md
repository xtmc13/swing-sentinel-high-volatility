# 完整高波动版实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复模拟交易与回测正确性，交付 100–150 合约三态高波动监测、统一组合风控和多标的组合回测。

**Architecture:** TypeScript 纯领域函数作为唯一权威逻辑，MariaDB/MySQL 事务保证执行原子性，WebSocket 提供快速风险监测，已收盘 K 线生成正式信号。React 展示状态和审计；Rust 保持影子隔离。

**Tech Stack:** TypeScript 5.9、Node.js 22、Hono/tRPC、Drizzle ORM、MariaDB/MySQL、Vitest、React 19、原生 WebSocket、Rust/Tokio/Axum。

**Spec:** `docs/superpowers/specs/2026-10-27-high-volatility-design.md`

## Global Constraints

- 仅公开行情和模拟交易，不接入密钥或真实订单；自动交易在验收前保持暂停。
- 正常扫描 45 秒，HIGH 风险检查 10 秒；正式入场仅使用已收盘 5M，信号有效期 15 秒。
- 默认池 100、允许 2–150；7 天 5M ATR 基线至少 2016 根，1M 跳动阈值 3σ/5σ，ATR 分位 90/99。
- HIGH 风险倍率 0.5；EXTREME 立即禁止新开仓；恢复稳定 180 秒；盘口/标记价 5 秒、1M 90 秒过期。
- 组合止损风险 1%、高相关同方向风险 0.5%、60 根 15M 相关性、阈值 0.8。
- 不读取或输出 `.env` 口令；测试只使用独立数据库，不清空预览或用户数据。
- 每个缺陷先写并运行失败测试；不得删除测试、放宽断言或用空 catch 掩盖失败。

## Review Focus

- 基线或相关性样本不足：预期失败关闭，Task 2 的样本边界测试固定。
- 单连接故障与全源故障：预期按受影响符号隔离，Task 3 的连接故障测试固定。
- 并发平仓和跨进程开仓：预期最多一次结算且不超预算，Task 4 的真实数据库测试固定。
- 同一根 K 线高低价路径未知：预期止损/强平保守优先、移动止损下一根生效，Task 6 固定。
- 多日浸泡：不能用短测冒充，Task 8 单独记录运行时长和未完成的时序验收。

---

### Task 1: 数据契约与可迁移结构

**Files:**
- Modify: `contracts/trading.ts`, `db/schema.ts`, `api/queries/trading.ts`, `api/tradingRouter.ts`, `vitest.config.ts`
- Create: `db/migrations/0001_high_volatility.sql`, `api/queries/volatility.ts`, `api/queries/volatility.test.ts`

**Interfaces:**
- Produces: `VolatilityMode`、`VolatilityState`、`MarketQuality`、`TradingSettings` 新字段；`positions.initialRisk`；`volatilityStates` 表及 `get/saveVolatilityState` 查询；Zod 设置输入和 2–150 限制。

- [ ] 写查询/迁移失败测试：新设置可持久化，状态保存/读取保留模式、确认数、稳定起点、指标和版本，持仓含非空 `initialRisk`。
- [ ] 运行 `npx vitest run api/queries/volatility.test.ts`，确认因结构/函数缺失失败。
- [ ] 实现契约、schema、查询和幂等 SQL 迁移；为 Vitest 增加 `@db` alias，不改动现有预览库。
- [ ] 在独立测试库执行迁移并重跑测试，预期通过；运行 `npm run check`。

### Task 2: 纯信号、三态与组合风险函数

**Files:**
- Create: `api/services/strategy.ts`, `api/services/volatility.ts`, `api/services/risk.ts`
- Create: `api/services/strategy.test.ts`, `api/services/volatility.test.ts`, `api/services/risk.test.ts`
- Modify: `api/services/opportunity.ts`, `api/services/indicators.ts`

**Interfaces:**
- Consumes: Task 1 契约。
- Produces: `analyzeClosedCandles(...)`、`evaluateVolatility(input, previous, now)`、`sizePosition(input)`、`portfolioRisk(...)`、`correlation(...)`、`managePositionPrice(...)` 纯函数；`Opportunity` 携带 `signalCloseTime` 和 `stateVersion`。

- [ ] 为未收盘过滤、90/99 分位、3σ/5σ、最小波动下限、点差基线、两次 HIGH 确认、立即 EXTREME、180 秒恢复和旧版本拒绝写失败测试。
- [ ] 为实际成交价止损风险、双边成本、HIGH 减半、1% 组合风险、0.5% 高相关风险、保本后零贡献及样本不足写失败测试。
- [ ] 运行上述三个测试文件并确认失败原因正确。
- [ ] 实现纯函数并让 `analyzeMarket` 只负责取数与调用正式信号函数；不接入订单执行。
- [ ] 重跑测试和 `npm run check`，预期通过。

### Task 3: 单源行情与 WebSocket 快速监测

**Files:**
- Modify: `api/services/binance.ts`
- Create: `api/services/marketMonitor.ts`, `api/services/binance.test.ts`, `api/services/marketMonitor.test.ts`

**Interfaces:**
- Consumes: Task 1 行情质量/状态类型和 Task 2 三态输入。
- Produces: 单源 `getMarketSnapshot()`、分页 7 天基线、带源缓存、监测器 `start/stop/getMetrics/getSymbolMetrics`；WebSocket 延迟、重连、丢包和限流指标。

- [ ] 用注入 fetch/clock/WebSocket fake 写失败测试：跨源缓存不混用，NaN/非正/交叉/陈旧盘口拒绝，2016 根基线分页，1M 不作正式信号。
- [ ] 写连接断开仅影响相应符号、REST 恢复启动稳定计时、重连与指标记录测试；运行并确认失败。
- [ ] 实现单源 REST 快照、受控降级和分连接 WebSocket 监测，不增加 npm 依赖。
- [ ] 重跑测试、`npm run check`，并对公开主网做只读连接冒烟，记录实际数据源和延迟。

### Task 4: 原子模拟开平仓与风险审批

**Files:**
- Modify: `api/services/paper.ts`, `api/queries/trading.ts`, `db/schema.ts`
- Create: `api/services/execution.ts`, `api/services/paper.test.ts`, `api/services/paper.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 风险/持仓纯函数和 Task 3 当前单源行情。
- Produces: 统一 `approveAndPriceEntry(...)`；事务化 `openPaperPosition`、`closePaperPosition`；正确的 affectedRows 处理和不可变 `initialRisk`。

- [ ] 写失败测试：旧信号价/超时/偏离/EXTREME/陈旧或超点差拒绝；实际买卖侧成交后重新计算数量、目标、费用和保证金。
- [ ] 在独立数据库写并发集成测试：跨 Promise/连接开仓不超持仓和预算，重复平仓只有一笔 CLOSE/closedTrade 且账户只结算一次，条件更新 0 行回滚。
- [ ] 运行测试确认现有实现失败，再实现账户行锁、原子金额更新、统一风险审批和初始风险保存。
- [ ] 重跑单元/集成测试、`npm run check`，预期全部通过且不操作预览数据库。

### Task 5: 三态引擎编排与陈旧信号防护

**Files:**
- Modify: `api/services/engine.ts`, `api/tradingRouter.ts`, `api/queries/trading.ts`
- Create: `api/services/engine.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4 的纯函数、监测器和执行接口。
- Produces: 45 秒信号扫描、HIGH 10 秒风险重估、状态迁移审计、恢复后新信号生成、所有开仓路径统一审批。

- [ ] 写失败测试：正常不加速下单、HIGH 只加速风险、EXTREME/断流零新开仓、恢复不执行积压信号、单币失败不中断、100–150 有界调度。
- [ ] 实现编排与状态持久化，手动扫描和自动交易都不得绕过风险审批。
- [ ] 重跑引擎测试及 Tasks 2–4 测试、`npm run check`。

### Task 6: 多标的同步组合回测

**Files:**
- Create: `api/services/portfolioBacktest.ts`, `api/services/portfolioBacktest.test.ts`
- Modify: `api/services/backtest.ts`, `api/tradingRouter.ts`, `contracts/trading.ts`

**Interfaces:**
- Consumes: Tasks 2、4、5 的正式信号、风险和持仓规则。
- Produces: `runPortfolioBacktest(symbols, timeframe, bars)`，同步账户/组合/三态，返回权益、逐币交易、资金费、拒绝和状态迁移。

- [ ] 写失败测试：下一根成交、同根止损保守优先、移动止损下一根生效、跳空强平、期末滑点、盘中回撤、历史资金费、数据缺口失败关闭。
- [ ] 写多标的共享权益、1% 组合风险、相关性、日损和 EXTREME 不开仓测试并确认失败。
- [ ] 实现同步事件回测和 API，保留旧结果可读；不伪造历史盘口。
- [ ] 重跑全部 API 测试和 `npm run check`。

### Task 7: 页面状态、配置与可观测性

**Files:**
- Modify: `src/pages/RiskPage.tsx`, `src/pages/MarketsPage.tsx`, `src/pages/Home.tsx`, `src/pages/ReviewPage.tsx`, `src/components/TerminalLayout.tsx`
- Create: `src/components/VolatilityBadge.tsx`
- Modify: 必要的 ESLint/UI 共享文件

**Interfaces:**
- Consumes: Dashboard 的三态、行情质量、组合风险、监测指标、审计和组合回测结果。

- [ ] 先按现有风格完成轻量 UI 设计说明，再实现三态参数、每币状态/数据年龄/指标、组合风险、WebSocket 指标、状态日志和多标的回测入口。
- [ ] 修正 180 分钟旧文案及所有现有 lint 错误，不通过禁用规则掩盖。
- [ ] 运行 `npm run check`、`npm run lint`、`npm test`、`npm run build`，预期通过。

### Task 8: 全链路验收与浸泡

**Files:**
- Modify: 仅验证发现的缺陷所需文件及 `README.md`, `UPGRADE_NOTES.md`

**Interfaces:**
- Consumes: Tasks 1–7 全部产物。

- [ ] 全新独立数据库执行迁移、类型检查、全部测试、lint、生产构建和 `cargo test`；修复 Rust 既有浮点编译错误但不接入交易。
- [ ] 启动生产服务，验证 Dashboard、风险页、交易池、组合回测、数据库持久化、主网 REST/WebSocket、断流恢复和浏览器控制台。
- [ ] 独立审查全部改动，Critical/Important 修复后重跑完整验证。
- [ ] 自动交易保持暂停，向用户报告代码验收结果；经确认后开启模拟浸泡，记录开始时间、异常、订单和风险日志。数天时长未达到前明确标记浸泡验收未完成。
