# Binance Account Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完整支持币安 USDT 永续账户的 one-way/dual、isolated/cross、单/多资产和实际杠杆，同时保留全部真实交易风控与恢复能力。

**Architecture:** 先建立统一身份、账户快照和迁移契约，再修改 wire 请求、状态机、风险计算和生产组合服务。每阶段独立测试，最后做全分支审查与只读部署，不执行真实 canary。

**Tech Stack:** TypeScript、Drizzle/MySQL、React、Vitest、Binance USDⓈ-M REST/WS。

**Spec:** `docs/superpowers/specs/2026-11-04-binance-account-compatibility-design.md`

## Global Constraints

- 不提交真实订单、不修改币安账户设置；当前余额不足最小名义价值时继续拒绝。
- 不删除白名单、合约状态、数量/价格过滤、费用、止损、强平缓冲、外部风险隔离、armed、WS/REST 新鲜度或对账。
- 内部 ENTRY/REDUCE 与币安 reduceOnly wire 字段分离；所有持仓使用 symbol+positionSide。
- 历史未知值不得伪造；无法证明的活动旧记录持久冻结。
- 实际杠杆不放大风险预算，最终 effectiveLeverage 和 bracket 必须持久化并在恢复中复用。

## Review Focus

- 双向 REDUCE 不得变成反向开仓：Task 2/3 覆盖 wire、成交、退出及保护单。
- 混合 isolated/cross 不得用总权益冒充 cross 抵押：Task 5 覆盖组合边界。
- 多资产缺估值/折算率不得放行：Task 4/5 覆盖失败关闭。
- 不同 symbol 杠杆和 bracket 不得混用：Task 4/6 覆盖最终批准及重启一致性。
- 旧活动记录和账户模式变化不得自动恢复提交：Task 1/6 覆盖持久冻结与对账。

---

### Task 1: 统一契约与数据库迁移

**Files:**
- Modify: `contracts/trading.ts`
- Modify: `db/schema.ts`
- Create: `db/migrations/0015_account_compatibility.sql`
- Modify: `api/queries/trading.ts`
- Modify: `api/tradingRouter.ts`
- Test: `api/live/livePersistence.integration.test.ts`, `api/live/drizzleLiveOrderStore.integration.test.ts`, `api/queries/tradingSettings.test.ts`

**Interfaces:**
- Produces: `PositionSide=LONG|SHORT`、`MarginType=ISOLATED|CROSS`、`EntrySemantics=ENTRY|REDUCE`、`LiquidationPriceSource=EXCHANGE|PRETRADE_ESTIMATE|LEGACY_UNKNOWN`。
- Produces: `LeverageMode` 增加 `ACCOUNT_CONFIGURED`；账户快照包含 dual/multiAssets/估值口径，持仓包含 marginType/effectiveLeverage/liquidationPriceSource。
- Produces: live intents/orders/positions 的 positionSide、marginType、entrySemantics、effectiveLeverage、最终 bracket、强平来源、账户指纹和持久冻结字段。

- [ ] **Step 1:** 在专用测试库写迁移失败测试：新记录字段完整，旧 one-way 记录仅迁移可证明字段，LEGACY_UNKNOWN 活动记录被持久冻结，关闭历史不伪造来源；ACCOUNT_CONFIGURED 读写不丢失。
- [ ] **Step 2:** 运行迁移测试并确认因字段/模式缺失失败。
- [ ] **Step 3:** 实现 schema、迁移、设置校验与序列化；PAPER 显式保留旧 symbol-max 行为。
- [ ] **Step 4:** 在专用测试库跑迁移与读写测试，确认通过后提交 `feat: add account compatibility persistence`。

### Task 2: 币安 wire 身份与请求矩阵

**Files:**
- Modify: `api/live/binanceSigned.ts`
- Modify: `api/live/orderStateMachine.ts`
- Create: `api/live/orderWire.ts`
- Test: `api/live/binanceSigned.test.ts`, `api/live/orderStateMachine.test.ts`

**Interfaces:**
- Consumes: Task 1 的身份字段。
- Produces: `buildOrderWire(order, accountMode)` 输出符合 Spec 的 LONG/SHORT × one-way/dual × ENTRY/REDUCE/STOP 参数；内部 REDUCE 不改变。

- [ ] **Step 1:** 写完整请求矩阵失败测试，包括 dual 平仓不发送 reduceOnly、one-way BOTH 映射、非法指纹拒绝。
- [ ] **Step 2:** 运行并确认缺少 positionSide/矩阵时失败。
- [ ] **Step 3:** 扩展 REST DTO 和 `PlaceOrderRequest`，由统一 wire builder 生成请求；下单签名逻辑保持原样。
- [ ] **Step 4:** 跑测试并提交 `feat: map orders to real account position modes`。

### Task 3: 成交、双向平仓与恢复

**Files:**
- Modify: `api/live/orderStateMachine.ts`, `api/live/userDataStream.ts`, `api/live/liveExecution.ts`, `api/services/momentumState.ts`, `api/services/executionCoordinator.ts`
- Test: 对应 `.test.ts` 文件及 `api/live/livePersistence.integration.test.ts`

**Interfaces:**
- Consumes: Task 1/2 身份、wire builder 和持久化模式指纹。
- Produces: WS/REST 成交 positionSide 校验、目标侧精确退出、REDUCE 状态更新及残留保护单清理。

- [ ] **Step 1:** 写 LONG/SHORT × one-way/dual 的成交、部分成交、CANCEL、UNKNOWN、重启和退出重试失败测试；同 symbol 另一侧外部持仓不得被修改。
- [ ] **Step 2:** 运行并确认当前 symbol-only 匹配/REDUCE 判断失败。
- [ ] **Step 3:** 全部状态机分支改用 EntrySemantics；dual 每次平仓/重试重新读取目标侧远端数量，活动单复用、UNKNOWN 对账、归零后只清理本系统同侧保护单。
- [ ] **Step 4:** 跑单元与专用数据库恢复测试，提交 `feat: preserve dual-side fill and exit identity`。

### Task 4: 账户估值、实际杠杆与模式化预检

**Files:**
- Modify: `api/live/liveExecution.ts`, `api/live/livePreflight.ts`, `api/live/liveRisk.ts`, `api/live/productionServices.ts`, `api/live/livePersistence.ts`
- Test: 对应测试及 `src/pages/RiskPage.test.ts`

**Interfaces:**
- Produces: 账户展示与 finalGate 共用 totalMarginBalance/totalWalletBalance/availableBalance；多资产缺汇总值失败关闭。
- Produces: `effectiveLeverage` 作为 finalGate 批准字段，逐 symbol 使用实际 positionRisk 杠杆并验证目标 bracket initialLeverage；FIXED 与 ACCOUNT_CONFIGURED 均受支持。
- Produces: cross 真实 usedMargin 和持仓保证金字段；修正用全组合 exposure 选择目标 symbol 档位的错误。

- [ ] **Step 1:** 写多资产 finalGate、cross 保证金、不同 symbol 杠杆、150x 合法/超档、批准一致性失败测试。
- [ ] **Step 2:** 运行并确认当前 USDT-only/fixed20/cross-isolatedWallet 假设失败。
- [ ] **Step 3:** 实现统一估值、模式化预检和 effectiveLeverage/bracket 持久化；不自动修改杠杆。
- [ ] **Step 4:** 跑测试并提交 `feat: use real account valuation and leverage`。

### Task 5: Cross 组合强平与失败关闭

**Files:**
- Create: `api/live/crossRisk.ts`, `api/live/crossRisk.test.ts`
- Modify: `api/live/liveRisk.ts`, `api/live/productionServices.ts`
- Modify: `api/live/binanceSigned.ts`

**Interfaces:**
- Produces: `estimateCrossLiquidationBoundary(snapshot,candidate)`，求解 `crossEquity(P)=crossMaintenance(P)`，返回带 PRETRADE_ESTIMATE 来源的边界或明确拒绝原因。
- Consumes: cross-only 钱包/uPnL、全部 cross 两腿、目标 bracket/cum、候选增量 PnL 和一致性问题。

- [ ] **Step 1:** 写混合 isolated/cross、双向两腿、候选增量 PnL、档位切换、多资产折算缺失、相关 pending、快照变化和 LONG 无正根的失败测试。
- [ ] **Step 2:** 运行并确认当前单仓近似不能满足组合语义。
- [ ] **Step 3:** 实现 cross-only 组合边界、保守取整和二次快照一致性复核；相关 pending 或不可证明数据直接拒绝。止损必须先于保守强平边界。
- [ ] **Step 4:** 跑测试并提交 `feat: add conservative cross portfolio risk`。

### Task 6: 对账、恢复指纹与真实只读 UI

**Files:**
- Modify: `api/live/reconciliation.ts`, `api/live/productionServices.ts`, `api/live/liveExecution.ts`, `contracts/trading.ts`
- Modify: `src/pages/RiskPage.tsx`, `src/components/ExecutionStatusPanel.tsx`
- Test: 对应 API/UI 测试

**Interfaces:**
- Consumes: 所有前述身份、估值、杠杆和 cross 结果。
- Produces: 模式化保护单识别、持久冻结执行阻断、账户模式/实际杠杆/强平来源的只读展示。

- [ ] **Step 1:** 写同 symbol 双侧、错误 positionSide、合法 dual 保护单、外部订单/持仓、账户指纹变化和旧记录重启冻结测试。
- [ ] **Step 2:** 运行并确认 symbol-only/reduceOnly=true 假设失败。
- [ ] **Step 3:** 完成对账和 UI；只读预检继续可用，armed/订单确认不变。
- [ ] **Step 4:** 跑测试并提交 `feat: reconcile real account modes end to end`。

### Task 7: 全量验证、独立审查与只读部署

**Files:** 仅根据证据修改上述实现及测试。

- [ ] **Step 1:** 运行 `npm test && npm run check && npm run lint && npm run build && cargo test --manifest-path rust-core/Cargo.toml`，并运行全部专用数据库集成测试；任何失败不得隐藏。
- [ ] **Step 2:** 检查迁移、管理员删除不回退、凭据/临时文件/配置差异；做独立全分支代码审查并修复 Critical/Important。
- [ ] **Step 3:** 推送并部署，验证真实账户模式、估值和只读预检；确认 DB 中 armed/autoTrade 未被改变，无新增订单/意图/持仓。
- [ ] **Step 4:** 报告实际验证范围、当前余额限制和未执行真实 canary；不得宣称真实成交已经验证。
