# 现有系统高波动动量与币安主网真实执行改造计划

## 目标

在现有交易系统中直接加入“方向一致、早期放量突破、限制追价、快速失败退出”的动量模式，并接入币安 USDⓈ-M 主网真实订单。Rust 负责实时特征，TypeScript 继续负责信号接受、组合风控、订单状态、账户和前端。不是另做独立应用，也不把大阳线或高波动本身当买点，不承诺止盈或盈利。

## 安全边界

- 默认保持 `PAPER`、`momentumEnabled=false`、`LIVE_TRADING_ENABLED=false`、`live_controls.armed=false`。
- 本计划只实现和验证代码，不索取或写入真实 API 密钥，不在本次自动开启真实下单。
- 主网真实提交必须同时满足：主网执行模式、环境总开关、人工 armed、autoTrade、凭据、行情/对账/风控全部通过。`APP_SECRET` 仅用于管理认证，不能替代这些开关。
- 禁止用模拟杠杆、模拟现金和立即成交模型计算真实订单。真实余额、杠杆档位、手续费、强平价和成交回报以币安签名接口为准。
- 不保存或输出密钥，不把密钥放进 Rust、数据库、URL、日志、前端或 Git。

## 架构

`主网公共 WS → Rust 实时特征/候选 → TS 动量接受与既有组合风控 → ExecutionCoordinator → Paper 或 MainnetLive adapter → 主网签名 REST/私有 WS → 对账与现有 Dashboard`

Rust 无凭据、无账户数据、无下单权限。TS 是订单和账户权威；Rust 故障只关闭动量入口，不影响已有波段模拟交易。

## 实施步骤

### 1. 统一执行边界与配置契约

修改 `api/services/engine.ts`、`api/tradingRouter.ts`、`contracts/trading.ts`、`db/schema.ts`：

- 新增 `ExecutionCoordinator`，统一 open/close/manage/emergency/account/positions；现有 paper 行为封装为 adapter，避免在 `openPaperPosition` 内暗发真实订单。
- 新增 `executionMode=PAPER|LIVE_MAINNET`、`strategyMode=SWING|MOMENTUM|BOTH`、独立 momentum 开关与 live armed 控制。模式切换在有持仓、意图或未完成订单时拒绝。
- Opportunity 增加唯一 signalId、策略类型、signal/expiry/trigger/limit、source generation、detector/config version，防止早期信号重复使用。
- 设置 Zod 边界，普通保存配置不能 armed 或开启主网。

测试：默认全部关闭；paper 现有行为不变；TESTNET 行情永远不能选择 LIVE_MAINNET；有未结风险时不能切换模式。

### 2. 主网签名只读客户端与精确数值

新增 `api/live/binanceSigned.ts`、`api/live/decimal.ts`、`api/live/liveConfig.ts`：

- 固定 `https://fapi.binance.com` 和主网私有 WS 地址，使用服务器时间偏移、recvWindow、HMAC-SHA256 与 X-MBX-APIKEY；错误脱敏、限流退避。
- 实现 account、positionRisk、leverageBracket、position/multi-assets mode、openOrders、userTrades、income、listenKey 等只读接口，以及后续 order/cancel 接口骨架。
- 真实价格、数量、费用用十进制字符串和精确运算，数据库新增 DECIMAL string 字段，禁止用 double 记账。
- 无凭据或总开关时不能构建 live adapter；公开状态只返回 credentialsConfigured 布尔值。

测试：已知答案签名、时间偏移、错误脱敏、固定主网地址、精度/步长，全部使用 fake fetch，无真实请求。

### 3. 主网持久化、预检与风险预留

新增 live intents/orders/fills/positions/account/ledger/reconciliation 表及迁移：

- clientOrderId、exchange order/trade/transaction ID、signalId 唯一；意图有版本、过期和 worker lease，避免多进程重复提交。
- 真实风控使用签名余额、实际杠杆/维持保证金档位、待成交意图预留、真实强平数据；live 禁止 SYMBOL_MAX，要求明确固定低杠杆。
- 预检 one-way、非 multi-assets、USDT 永续、isolated margin、合约过滤、无外部持仓/订单、无严重对账问题。不自动接管或撤销人工订单。
- DB 事务不跨币安网络调用；提交前重检新鲜度和风险。

测试：账户配置不符、真实档位、待单预留、外部持仓、精确取整、跨 worker 唯一意图。

### 4. 真实订单状态机与保护单

新增 `api/live/orderStateMachine.ts`、`api/live/liveExecution.ts`：

- 意图先持久化再提交；状态覆盖 PENDING_SEND/SUBMITTING/NEW/PARTIAL/FILLED/CANCEL/REPLACE/UNKNOWN/RECONCILING。
- 入场默认带最高/最低可接受价的 IOC limit，防止追价； acknowledgement 不算成交，只有执行回报/用户成交更新仓位。
- 按 exchange trade ID 幂等处理部分成交、乱序和重复事件，加权均价与实际手续费；剩余量按实际累计成交计算。
- 首次成交建立交易所原生 STOP_MARKET 保护，后续校准目标；保护失败必须告警并恢复或减仓退出。
- 改单先撤旧、确认、重算剩余，再用新 clientOrderId；超时进入 UNKNOWN，先查询禁止盲目重试。
- autoTrade=false 只停止新开仓；紧急停止撤销系统订单、尝试 reduceOnly 平仓并报告未解决项；live 禁用 paper reset。

测试：部分成交、重复/乱序回报、撤单超时、部分成交后改单、提交后崩溃恢复、保护单失败、重复 worker、reduceOnly。

### 5. 私有行情、重启恢复、真实费用对账

新增 `api/live/userDataStream.ts`、`api/live/reconciliation.ts`、`api/live/accounting.ts`：

- listenKey 创建/续期/重连，私有订单和账户事件入库；重连、UNKNOWN、启动时先 REST 对账再允许新开仓。
- 比较交易所与 DB 的持仓/订单；未知人工项只冻结并报告，不擅自接管。
- 资金费、手续费、已实现盈亏通过 signed income/userTrades 全量分页和 transaction/trade ID 去重，不再用 paper 近似。
- 未结意图、未保护仓位和余额差异进入 reconciliation_issues。

测试：每个状态的重启、断线重连、重复收入、余额/持仓差异、未知人工订单。

### 6. Rust 早期动量检测器

重构 `rust-core/src/`，保留 Axum health/diagnostics：

- 主网公共 aggTrade/bookTicker/diff depth/markPrice/必要 K 线；REST 快照＋diff 序列同步，缺口重建。
- 计算 microprice、spread、深度不平衡、主动买卖量、短窗收益、burst、实现波动率，帧带事件/接收时间、序列、generation、quality/config hash。
- 候选通过仅回环的内部端点发送 TS，严格校验；Rust 不包含任何账户或订单权限。

测试：depth gap/resync、陈旧帧、单边/双边、虚假单帧、连续确认、无候选时失败关闭。

### 7. TS 动量接受与快速退出

新增 `api/services/momentum.ts` 并接入现有 engine/risk：

- 多头要求已有 4H/1H 方向和 15M 结构，前序滚动阻力＋突破 buffer，深度不平衡、主动量、burst 和波动确认；空头完全镜像。
- 初始待校准参数：120 秒窗口、突破 1bps、最大追价 4bps 或 0.10 ATR、深度差 0.15、主动量比 1.5、burst Z=2、波动 P80、连续 2 次、信号 750ms、最多改单 1 次、120 秒无跟随退出。
- 同时满足 bps 与 ATR 追价上限才发 IOC；已超过上限直接过期，不等大阳线，也不追大阳线。
- EXTREME 禁止新开仓，HIGH 使用现有风险减半；止损按真实触发价和真实强平缓冲重算。
- 跌回突破位且流向反转、120 秒无跟随、原硬止损/目标/日损/紧急退出均纳入现有持仓链路。
- 增加时间戳 trade/order-book/feature-frame replay；不能用 5m K 线冒充微结构回测一致性。

测试：早期可入、晚期过期、突破失败、无跟随、镜像空头、数据断流、信号幂等、真实执行前所有风险门。

### 8. Dashboard 与管理操作

更新现有页面：

- 显示 PAPER/LIVE、动量检测健康、候选拒绝原因、真实订单状态/成交均量、未结意图、对账和私有 WS 健康、保护缺失警告。
- close/emergency/dashboard 通过 coordinator；所有账户/持仓/订单清楚标识模拟或真实。
- armed 需要新管理员授权、确认短语、全部预检和环境总开关；手动 canary 不依赖开启自动交易。

测试：无权限 401、普通保存不能 armed、缺任一条件不能提交、失败退出不显示成功。

### 9. 验证与分阶段上线

- 每步先写失败测试再实现；最终运行 `npm run check`、`npm test`、`npm run lint`、`npm run build`、Rust tests、独立 MariaDB 集成、浏览器验证。
- Rust shadow：replay 与 TS 特征一致，候选只记录。
- Paper/replay：动量→风控→部分成交→改单→退出→重启全链路通过。
- 主网只读：用户提供权限受限凭据后，仅验证余额、档位、私有流、收入和对账，不提交订单。
- 人工 canary：用户另行明确 armed 后，仅一个白名单合约、最小安全数量，验证真实成交、保护、撤单/平仓和重启对账；自动交易仍关。
- 小范围自动：只有 canary 和观察期全部通过，才由用户明确开启一个合约的自动交易；任何严重差异立即关闭入口但保留退出与对账。

## 交付边界

完成代码和模拟/回放/只读验证不等于已验证真实盈利或已允许自动实盘。真实下单与后续 armed/canary 必须另行明确确认。