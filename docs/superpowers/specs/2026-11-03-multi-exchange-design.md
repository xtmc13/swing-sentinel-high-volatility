# 币安 / OKX 行情与真实交易切换设计

## 目标

在现有系统中加入统一交易所适配层，支持币安和 OKX 永续的公开行情、账户、订单、持仓、费用、对账和风控切换。增加密钥填写入口。保持现有动量/波段策略、前端和模拟能力，不创建第二套应用。

## 安全与边界

- 默认仍 PAPER，LIVE、momentum、armed 均关闭；本次不自动提交真实订单。
- 页面与操作不依赖应用内管理员认证，也不设只读模式。密钥录入、armed、canary 和交易控制仍受各自的显式确认与执行门控；无域名/可信 TLS 时，密钥录入仅允许 SSH 隧道，不在明文公网 HTTP 提交。
- 密钥不明文回显、不写日志、不进入 Rust 或前端持久化。数据库仅保存 AES-256-GCM 密文、IV、tag 和不可逆指纹；主密钥仅来自服务器 `CREDENTIAL_ENCRYPTION_KEY`。
- 币安使用 API key/secret，OKX 使用 API key/secret/passphrase。OKX 还需禁止提现并绑定服务器 IP。
- 交易所切换不能混用行情、账户、持仓或订单。有持仓、活动意图、未完成订单、严重对账问题时拒绝切换。

## 方案比较与选择

选择统一 `ExchangeAdapter`：现有 Binance 实现归并到适配器，新增 OKX 实现，协调器按 activeExchange 选择。相比复制两套页面/策略，能保持风控和状态机一致；相比只做行情切换，满足用户要求的真实交易切换。工作集中在适配、密钥和测试，不重复策略代码。

## 实施内容

1. **适配器契约**：定义公共行情、账户配置、下单/撤单、私有事件、费用和对账接口；统一 symbol、side、订单状态、成交和资金费模型。Binance 主网实现保持原行为。
2. **OKX SWAP 客户端**：固定官方 REST/WS 地址，服务器时间、HMAC-SHA256/Base64 签名、passphrase、限流和超时；实现 instruments、books/tickets/trades、account/balance/positions、orders/fills/bills、private WS。使用精确十进制和 OKX 原生 ID。
3. **OKX 订单状态机映射**：复用现有 intent→submit→partial→fill→cancel/replace→UNKNOWN→reconcile；one-way、isolated、reduceOnly、IOC、原生止损/保护，处理部分成交、重启和对账。
4. **密钥管理**：在风险页按交易所添加/替换/删除；只显示 configured/created/fingerprint，不显示原文。AES-GCM 加解密、所有权、过期和审计测试。Rust 永不接触密钥。
5. **切换与 UI**：Dashboard 显示 BINANCE/OKX、连接质量和真实/模拟标签；提供切换下拉框、密钥状态和入口。任何切换重新建立独立 generation、缓存、WebSocket、基线和对账，旧事件不得写入新源。
6. **公网部署**：应用不提供管理员认证或只读模式；如需限制访问，应由反向代理保护整个服务。端口开放和防火墙最小化，服务仍默认不交易。
7. **验证**：Binance 回归；OKX 已知签名、公共数据解析、部分成交/撤单/保护/对账、密钥加解密、切换隔离、并发切换和 UI 流程。完整 TS/Rust/MariaDB/浏览器检查。

## 审查后明确项

- 应用内不区分匿名只读与管理权限；真实余额、持仓、订单、成交和 PnL 的可见性由整个服务的部署访问边界决定，密钥明文始终不回显。
- 切换在数据库全局锁内暂停新意图并推进持久化 generation；先进入 DISABLED 保护状态，再初始化新交易所。失败时保持禁用，不回退到可能已 teardown 的旧源。重启后沿用持久化 activeExchange/generation。
- 首版仅支持 OKX USDT 线性永续 SWAP，使用合约元数据和 ctVal 精确换算；不支持 USDC 或币本位。
- 私有 WS 是执行事件首选来源，REST fills 用于补全；按 OKX 原生 fill/trade ID 幂等，bills 用于费用/资金费对账，禁止跨来源重复记账。
- 保护使用 OKX 独立 algo STOP、标记价触发和 reduce-only/平仓约束；部分成交、改单、拒绝和缺失保护均进入现有恢复链路。
- 密钥记录带 keyVersion；支持受控轮换。主密钥丢失时允许并要求重新录入，不尝试不可逆恢复。

## 上线门

代码与模拟验证通过后，分别进行币安/OKX 主网只读验证，再由用户单独确认每个交易所的一笔最小数量 canary。任何交易所都不能直接跳到自动真实交易。盈利、参数最优和多日浸泡不在代码完成声明内。
