# 币安真实账户全配置兼容设计

## 目的

让系统适配币安账户现有的双向/单向、全仓/逐仓、多资产/单资产和实际杠杆配置，而不是强迫账户改成 one-way、isolated、固定 20 倍。实现下单、保护、平仓、估值、恢复和对账的完整一致性，不通过删除风控来制造“可下单”。

## 已确认现状

当前真实账户为双向、多资产，BTC 为 cross/150x，无持仓和订单，总权益约 0.00009174。当前代码在下单身份、保证金、杠杆、持仓匹配和持久化中假设 one-way/isolated/固定杠杆，因此不能只修改预检文案。

## 方案选择

1. 完整适配现有账户模式：修改执行层和数据库，工作量大，符合用户选择。
2. 只放开实际杠杆：阶段交付，不完整支持当前账户。
3. 修改币安为单向逐仓固定杠杆：改变用户账户，不采用。

## 目标与边界

- 支持 USDT 本位永续、one-way/dual、isolated/cross、单资产/多资产以及账户实际杠杆。
- 实际杠杆只影响保证金和强平风险，不放大风险预算；不自动修改交易所杠杆。
- 保留合约白名单、TRADING 状态、tick/step/minQty/minNotional、费用/滑点、止损、强平缓冲、外部订单/持仓隔离、armed、私有 WS、对账和紧急门控。
- 当前余额低于最小名义价值时必须继续拒绝；本任务不执行真实 canary，不擅自提交订单或修改币安账户设置。
- 不支持币币杠杆、COIN-M、期权；非 USDT 手续费等未支持账本情况继续失败关闭。

## 统一身份与持久化

新增内部概念：

- `positionSide`: `LONG | SHORT`，是持仓身份，不再只用 symbol 或 positionAmt 推断。
- `marginType`: `ISOLATED | CROSS`。
- `effectiveLeverage`: 最终批准的账户实际杠杆。
- `entrySemantics`: `ENTRY | REDUCE`；内部 REDUCE 不再等同于币安 wire 的 reduceOnly 字段。
- `liquidationPriceSource`: `EXCHANGE | PRETRADE_ESTIMATE`。
- 账户模式指纹：dualSide、multiAssets 和必要估值口径；未结订单遇到账户模式变化时冻结并报告。

`live_intents`、`live_orders`、`live_positions` 通过新迁移保存上述字段及最终 maintenance bracket。历史记录保留并按可证明的 one-way 旧语义迁移；无法证明的记录保持冻结，不猜测。

所有本地/远端持仓匹配、预检、组合风险、私有成交、REST 恢复、退出重试和对账使用 `symbol + positionSide`。同一 symbol 的另一方向外部持仓不能被误认为系统持仓。

## 下单与保护请求矩阵

内部 REDUCE 始终表示减少持仓；币安 wire 参数由账户模式生成：

- one-way 开多/开空：BUY/SELL，positionSide=BOTH 或省略。
- dual 开多：BUY + LONG；开空：SELL + SHORT。
- one-way 平多/平空：SELL/BUY + reduceOnly=true。
- dual 平多：SELL + LONG；平空：BUY + SHORT，不发送 reduceOnly。
- 双向止损同样带目标 LONG/SHORT 和精确数量，不把内部 REDUCE 错写为开仓。

私有流和 REST 成交都必须校验 positionSide；内部订单状态机按 ENTRY/REDUCE 处理，不依赖远端 reduceOnly 推断成交语义。

双向没有 reduceOnly 兜底，因此平仓/重试前必须重新读取目标侧远端数量，使用精确剩余数量和确定性 clientOrderId。全部平仓后处理同侧残留保护单；UNKNOWN 继续对账，CANCEL 才允许受控重试，活动订单不得重复。

## Cross 与多资产估值

- 账户展示和 finalGate 共用同一份账户快照：权益使用币安 `totalMarginBalance`，现金使用 `totalWalletBalance`，可用余额使用账户级 `availableBalance`。这些是币安返回的等值口径，不直接相加不同资产的原生数量。
- 多资产模式缺少合法汇总值时估值无效，不回退为 USDT=0。
- usedMargin 优先使用账户 `totalPositionInitialMargin` 或接口真实持仓初始保证金；cross 缺少 isolatedWallet 不再误判为 0。
- 单仓视图使用接口真实初始保证金；若只能由名义价值/实际杠杆估算，必须标注来源且不得用于伪造精确对账。
- 现有持仓优先读取对应 symbol+positionSide 的真实 liquidationPrice；成交后立即刷新真实保证金和强平价。
- Cross 强平只使用 cross 专用钱包、cross 未实现盈亏和 cross 持仓，排除 isolated 保证金。以当前 cross 权益为基准，只计算候选价格变化产生的增量 PnL，不重复加入当前 uPnL。
- 求解 `crossEquity(P) = crossMaintenance(P)` 的账户级边界；全部 cross 持仓及双向两腿分别计入维持保证金，目标侧使用成交后的 bracket 与 cum，不能净额抵消。
- 存在相关 cross 待成交意图时拒绝新增，除非显式模拟其成交后的仓位和价格敏感性；不能只扣 reservedMargin 充当估算。
- 多资产抵押品必须具有可验证的最新估值与折算率/压力假设；缺失时拒绝新开仓。不能用当前总权益假装覆盖未来抵押品价格变化。
- 估算使用同一轮账户、持仓和活动单并做第二次一致性复核；数据发生变化则丢弃结果。LONG 强平边界向更高的不利方向取整，SHORT 向更低的不利方向取整。
- 若 LONG 方程没有正根，只有能证明整个正价格区间内止损均先于强平才允许“无正强平边界”；否则失败关闭。
- 新开仓估算与交易所实际值在 UI/持久化中区分。

## 历史迁移与冻结

- 新运行记录的身份、模式、实际杠杆、最终 bracket 和强平价来源必须完整。历史记录允许 `NULL/LEGACY_UNKNOWN`，不得用当前 bracket 或账户状态倒填。
- 可证明的旧 one-way 记录按 `reduceOnly=true → REDUCE`，否则为 ENTRY；positionSide 沿用 side，effectiveLeverage 沿用已持久化 leverage。
- 无法证明的活动/未结旧记录持久标记为冻结，并在 submit、replace、protect、exit-retry 入口实际阻断，重启不能失效；已关闭历史可以保留未知来源。
- 每次 dual 平仓和 CANCEL 重试使用该订单持久化的模式指纹，并重新读取目标侧远端数量；活动单复用、UNKNOWN 先对账、目标侧归零后只清理本系统同侧保护单。
- one-way 远端 positionSide=BOTH 按模式映射，dual 必须精确匹配 LONG/SHORT；WS/REST 都校验。所有内部状态机和对账分支使用 ENTRY/REDUCE，不再依赖远端 reduceOnly 推断。
- `effectiveLeverage` 必须成为 finalGate 批准输出，替代 prepare 值做一致性检查。ACCOUNT_CONFIGURED 同步进入 contract、RPC 和 settingsFromRow；PAPER 显式保留旧 symbol-max 行为。

## 实际杠杆

新增 `ACCOUNT_CONFIGURED` 模式：逐 symbol 使用签名 positionRisk 中的实际杠杆，不强迫所有 symbol 等于同一个固定值。当前旧 SYMBOL_MAX 设置在迁移后转为 ACCOUNT_CONFIGURED，避免继续把模拟 Market.maxLeverage 当成真实账户杠杆；FIXED 保留为显式目标模式。

一次 finalGate 产生唯一 `effectiveLeverage`，供数量、保证金、强平估算、canary 和批准值一致性检查复用。实际杠杆必须为正整数、符合账户值且不超过目标名义价值对应 bracket 的 initialLeverage；150x 只在账户和档位允许时接受，不设置另一个任意全局上限。

修正现有组合 exposure 错用于目标 symbol 杠杆档位的问题：档位只根据目标 symbol+positionSide 的名义价值选择，账户级 cross 风险单独检查。最终 bracket 持久化，重启不再按不同口径重新猜测。

## 预检与 UI

- 预检按账户模式执行相应检查，不再简单拒绝 dual/multi/cross；非法模式组合、缺失字段和外部风险仍失败关闭。
- RiskPage 展示实际 one-way/dual、isolated/cross、多资产、逐 symbol 实际杠杆和强平价来源。杠杆文案不再宣称使用模拟上限。
- 未 armed 时继续提供只读预检；armed 和真实订单提交仍需要现有确认流程。
- 实时余额使用账户汇总值，小额非零不得显示为 0。

## 验收

- 请求矩阵：LONG/SHORT × one-way/dual × entry/exit/stop；双向不发送非法 reduceOnly，内部 REDUCE 不变成开仓。
- 成交与恢复：WS/REST positionSide 校验、同 symbol 双侧隔离、部分成交、UNKNOWN、CANCEL、重启、模式指纹变化和残留保护单。
- Cross/多资产：账户汇总与 finalGate 一致、真实 usedMargin、外部持仓、实际/估算强平来源、缺少字段失败关闭。
- 杠杆：不同 symbol 不同实际值、150x 合法档位、超档拒绝、effectiveLeverage 全链一致、bracket 重启一致。
- 风险：费用、滑点、minNotional、止损、组合预算、日损、armed、WS/REST 新鲜度和紧急退出不得被绕过。
- 数据库迁移与新旧记录兼容、Paper 行为不回退、完整 TypeScript/Rust/lint/build 和专用测试库通过。
- 部署只做只读账户、预检和页面验证；真实 canary 必须另行明确确认，并受最小数量和全部风控限制。
