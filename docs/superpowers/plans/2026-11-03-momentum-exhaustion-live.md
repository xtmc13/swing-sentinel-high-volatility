# Momentum Exhaustion Live Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在当前真实交易分支加入多周期动能衰竭检测、SWING 评分/界面/回测诊断，以及受管 MOMENTUM 持仓的自动止损收紧与 reduce-only 平仓。

**Architecture:** 选择性移植 `main` 的分析器，新增纯函数保护策略计算，再由 `ExecutionCoordinator` 在定时管理中调用现有 Paper/LIVE 适配器。LIVE 继续使用原生 STOP_MARKET、订单状态机、持久化退出 claim 和对账，不新建第二套下单系统。

**Tech Stack:** TypeScript、React 19、Vitest、Drizzle/MySQL、现有 Node 主服务与 Rust 动量数据源。

**Spec:** `docs/superpowers/specs/2026-11-03-momentum-exhaustion-live-design.md`

## Global Constraints

- 只处理系统管理的 MOMENTUM 持仓；不接管外部人工持仓，不处理 SWING 持仓的自动衰竭动作。
- 不加仓、摊平、反手或部分减仓；部署不执行真实 canary，不改变凭据、armed、autoTrade 或现有持仓。
- 不合并旧 `main` 的管理员认证、旧执行器或过时 Rust 服务。
- 所有新行为先写失败测试；LIVE 改单必须确认后才持久化，退出必须防重且可对账。

## Review Focus

- 陈旧、乱序或带缺口的 K 线不得产生真实动作：Task 1 的数据质量测试覆盖。
- 普通 trailing 与衰竭收紧竞争不得把严格止损改宽松：Task 3/4 的最新状态与串行测试覆盖。
- CANCEL/UNKNOWN/部分成交不得被误记为平仓成功：Task 4 的恢复与退出测试覆盖。
- 未 armed、autoTrade=false 不得阻断风险降低：Task 4 门控测试覆盖。
- 影子回测不得改变成交或权益：Task 2 比较有无诊断的同一回测结果。

---

### Task 1: 多周期分析器与强类型契约

**Files:**
- Create: `api/services/momentumExhaustion.ts`
- Create: `api/services/momentumExhaustion.test.ts`
- Modify: `contracts/trading.ts`

**Interfaces:**
- Produces: `evaluateMomentumExhaustion({ side, candles15m, candles1h, candles4h, now }): MomentumExhaustionSnapshot`。
- Produces: `MomentumProtection = "NONE" | "WARN" | "TIGHTEN" | "REDUCE_CANDIDATE" | "EXIT_CANDIDATE"`；`MomentumExhaustionSnapshot.protection` 使用该联合类型。
- Produces: `Opportunity.momentumExhaustion?: { score, resonanceCount, resonant, protection, structureBreak }` 和 `MomentumExhaustionEvent`；`PortfolioBacktestResult.momentumExhaustion?: MomentumExhaustionEvent[]`。

- [ ] **Step 1: 写失败测试并运行**
  从 `main` 移植现有样本测试，再增加 LONG/SHORT 方向选择、30/50/70 阈值、EXIT 优先级、五根结构窗口、乱序/重复/缺口/非法 OHLC、15m 超过 45 分钟、1h 超过 3 小时、4h 超过 9 小时均返回 NONE 的测试。运行 `npx vitest run api/services/momentumExhaustion.test.ts`，确认因模块/行为缺失而失败。

- [ ] **Step 2: 移植并实现分析器**
  保留 `main` 的 RSI、MACD、ROC、效率、ADX、成交量评分和 15m/1h/4h 的 0.5/0.3/0.2 权重。添加已收盘数据排序、周期间隔、OHLC/成交量及新鲜度校验；不合格数据失败关闭为 NONE。

- [ ] **Step 3: 加入契约并验证**
  运行 `npx vitest run api/services/momentumExhaustion.test.ts && npm run check`，确认测试和类型检查通过。

- [ ] **Step 4: 提交**
  `git add api/services/momentumExhaustion.ts api/services/momentumExhaustion.test.ts contracts/trading.ts && git commit -m "feat: add multi-timeframe exhaustion analysis"`

### Task 2: SWING 信号、首页与影子回测

**Files:**
- Modify: `api/services/strategy.ts`
- Modify: `api/services/strategy.test.ts`
- Modify: `api/services/portfolioBacktest.ts`
- Modify: `api/services/portfolioBacktest.test.ts`
- Create: `src/components/MomentumExhaustion.tsx`
- Create: `src/components/MomentumExhaustion.test.ts`
- Modify: `src/pages/Home.tsx`
- Modify: `src/pages/ReviewPage.tsx`

**Interfaces:**
- Consumes: Task 1 的 `evaluateMomentumExhaustion` 和契约字段。
- Produces: 扫描机会与组合回测的 `momentumExhaustion` 展示数据；不产生任何订单动作。

- [ ] **Step 1: 写信号与界面失败测试**
  对同一有效 SWING fixture 精确断言扣分 `Math.round(score * 0.2)`、方向不变、衰竭不单独制造 READY。组件测试展示分数、共振、保护、结构和旧结果兼容。运行相关测试，确认字段缺失时失败。

- [ ] **Step 2: 接入信号与首页**
  `analyzeClosedCandles` 在选定 side 后计算衰竭，追加判断理由并扣分；首页机会表增加“动能衰竭”列，复用现有 terminal 样式。

- [ ] **Step 3: 写并接入影子回测**
  先增加诊断不改变止损、trades 或 equityCurve 的对比测试及事件显示测试。定时轴只记录已有历史持仓的非 NONE 事件，数据库保存全部事件，Review 页只展示最近六条。

- [ ] **Step 4: 验证并提交**
  运行 `npx vitest run api/services/strategy.test.ts api/services/portfolioBacktest.test.ts src/components/MomentumExhaustion.test.ts src/pages/Home.test.ts && npm run check && npm run lint`，通过后提交 `feat: expose exhaustion signals and diagnostics`。

### Task 3: 止损候选与 Paper/LIVE 单调收紧

**Files:**
- Create: `api/services/momentumProtection.ts`
- Create: `api/services/momentumProtection.test.ts`
- Modify: `api/services/executionCoordinator.ts`
- Modify: `api/services/paper.ts`
- Modify: `api/services/paper.test.ts`
- Modify: `api/live/liveExecution.ts`
- Modify: `api/live/liveExecution.management.test.ts`
- Modify: `api/live/orderStateMachine.ts`
- Modify: `api/live/orderStateMachine.test.ts`

**Interfaces:**
- Produces: `momentumProtectionStop({ side, markPrice, candles15m, now }): number | null`，实现 Spec 的 ATR14/五根结构公式并拒绝陈旧或无效数据。
- Produces: `ExecutionAdapter.tightenStop(positionId: string, stopPrice: number, reason: string): Promise<StopTightenResult>`；`StopTightenResult = { ok: true; changed: boolean; reason: string } | { ok: false; reason: string }`。
- Produces: LIVE 公共收紧方法复用私有 `updateTrailingProtection`；Paper 使用数据库条件更新。

- [ ] **Step 1: 写纯函数和适配器失败测试**
  覆盖 LONG/SHORT 公式、无 ATR/无标记价、tick 舍入、相同/宽松值零请求、exitPending 短路。LIVE 测试必须证明 NEW 确认前本地止损不变，撤单超时/替换 UNKNOWN/NEW 后 DB 失败触发告警与 reduce-only 兜底。Paper 测试证明数据库条件更新单调。

- [ ] **Step 2: 实现候选计算与收紧接口**
  在持仓级串行区内重新读取最新持仓并重新校验；不得撤销已有退出中的保护单。保留现有 LIVE 失败兜底，Paper 失败只告警并保留原止损。

- [ ] **Step 3: 验证并提交**
  运行 `npx vitest run api/services/momentumProtection.test.ts api/services/paper.test.ts api/live/liveExecution.management.test.ts api/live/orderStateMachine.test.ts && npm run check`，通过后提交 `feat: add monotonic exhaustion stop tightening`。

### Task 4: 定时衰竭保护、退出防重与事件

**Files:**
- Modify: `api/services/executionCoordinator.ts`
- Modify: `api/services/executionCoordinator.test.ts`
- Modify: `api/services/engine.ts`
- Modify: `api/services/engine.test.ts`
- Modify: `api/live/liveExecution.ts`
- Modify: `api/live/liveExecution.test.ts`
- Modify: `api/live/orderStateMachine.ts`
- Modify: `api/live/orderStateMachine.test.ts`

**Interfaces:**
- Consumes: Task 1 评估器、Task 3 的 `tightenStop` 和 `momentumProtectionStop`。
- Produces: `ExecutionCoordinator.manageMomentumProtection()`；只在定时 `manage()` 调用，不在 `receiveMomentumFrame()` 调用。
- Produces: 复用 `momentumStore.claimExit/markExitSubmitted/releaseExit` 的衰竭退出，复用本轮同一 adapter，不重新选择模式。

- [ ] **Step 1: 写协调器失败测试**
  覆盖 NONE/WARN 零动作、TIGHTEN/REDUCE 收紧、EXIT 优先平仓、非 MOMENTUM/外部/exitPending 不处理、sourceGeneration 改变不动作、单币 REST 失败隔离、事件去重。验证未 armed 和 autoTrade=false 仍可降低风险。

- [ ] **Step 2: 实现定时评估与事件**
  为 market 依赖补充 `sourceGeneration/getCandles`，请求前后校验代际；普通 manage 失败不得静默吞掉，但不得因此跳过允许的风险降低。Paper 无有效估值不收紧且不能伪平仓；LIVE 可在估值失效但 K 线有效时提交 reduce-only EXIT。

- [ ] **Step 3: 写退出恢复测试并修复状态边界**
  先复现 CANCEL 被当作成功的问题。持久化 claim 后才调用 adapter.close；UNKNOWN/PENDING_SEND 保留恢复，CANCEL 且仍有 OPEN 持仓必须返回未结算并允许受控新重试订单。覆盖重启、多进程 claim、人工平仓竞争及兜底失败。

- [ ] **Step 4: 验证并提交**
  运行 `npx vitest run api/services/executionCoordinator.test.ts api/services/engine.test.ts api/live/liveExecution.test.ts api/live/orderStateMachine.test.ts && npm run check`，通过后提交 `feat: automate momentum exhaustion protection`。

### Task 5: 全量验证与只读部署

**Files:**
- Modify only if evidence requires it: 上述实现及对应测试。
- Verify: `docs/superpowers/specs/2026-11-03-momentum-exhaustion-live-design.md` 与本计划保持同步。

- [ ] **Step 1: 全量本地验证**
  运行 `npm test && npm run check && npm run lint && npm run build && cargo test --manifest-path rust-core/Cargo.toml`。记录真实通过/跳过数量，不把测试称为真实下单验证。

- [ ] **Step 2: 代码审查与差异检查**
  检查没有管理员入口、真实凭据、临时诊断文件或意外配置变更；`git diff --check` 和 `git status --short` 必须干净。发现的问题先回归测试再修复。

- [ ] **Step 3: 推送、部署和只读验证**
  推送 `feat/mainnet-momentum`，服务器 fast-forward、构建并重启。验证页面出现衰竭数据/事件、账户只读、私有 WS 和对账状态；确认 DB 中 armed/autoTrade 保持原值，无新增 live order/intent。

- [ ] **Step 4: 提交验证记录**
  仅在结果与文档不一致时更新文档；提交最终修复并报告仍未执行的真实 canary 和账户预检限制。
