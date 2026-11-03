# 波段哨兵 · 币安永续模拟与受控主网执行系统

多个高流动性加密货币 USDT 永续的波段／早期动量工程验证系统。默认交付状态仍是 **PAPER、动量关闭、主网关闭、armed=false**。代码包含服务器端签名账户读取、真实订单状态机、私有 WS、对账和受控手动 canary；只有另行配置权限受限凭据并通过全部门禁后才可能发送真实订单。本次未使用真实凭据、未发送真实订单，也不承诺盈利能力或实盘就绪。

## 核心闭环

- 币安 USDⓈ-M 主网公开行情失败时保持降级并禁止新增风险，不自动混入测试网行情；只有显式切换数据源时才使用测试网，缓存与信号按数据源及代际隔离。
- 按合约状态、24 小时成交额、买卖点差和价格有效性构建 2–150 个合约的动态池，默认 100 个。
- 4H／1H 判断方向，15M 寻找结构，5M 确认突破与动能；正式信号只使用已收盘 K 线。1M 与未收盘数据只用于风险监测。
- NORMAL／HIGH／EXTREME 三态共享实时与回测规则：HIGH 降低风险预算，EXTREME 立即禁止新增风险；恢复需持续稳定，默认 180 秒。
- WebSocket 监测 1M K 线、1 秒标记价和最优盘口，按流数分连接，支持重连、REST 受控补全、数据陈旧和限流观测。`bookTicker.u` 的正常跳号不被误计为丢包；该流本身不提供可靠丢包推断，因此 `missedMessages=null`，Dashboard 显示 `N/A` 而不是 `0 条`。
- 统一开仓审批覆盖行情质量、信号年龄与偏离、费用后单笔风险、保证金、持仓数、日损、组合止损风险、同方向高相关敞口和强平缓冲。
- 数据库事务与账户行锁串行化跨连接模拟开仓／平仓；开仓还以锁定读取检查最新波动状态与版本。持仓保存不可变 `initialRisk`，R 倍数不从移动后的止损反推。
- 模拟订单按盘口加不利滑点成交，计手续费与资金费；资金费以“持仓＋资金费时间”唯一约束防止跨重启重复结算。止损、2.2R 目标、保本移动、72 小时超时退出与人工紧急停止共享同一账务。紧急停止和账户重置保持暂停并报告未结算项；重置只有全部结算且最终锁内无 OPEN 持仓后才重置现金。
- 日亏熔断在账户锁内按 UTC 日锁存，价格恢复也不提前解禁；持仓行情缺失或无效时权益估值显示未知并进入降级，不回退到开仓价伪装成零浮盈浮亏。
- 新初始化、已有升级行及数据库列默认均暂停 `autoTrade`（升级迁移 `0003_pause_existing_auto_trade.sql`）。只有人工确认验收后才应开启自动模拟开仓；历史回测不受该实时开关影响。

## 默认风险参数

| 参数 | 默认值 |
|---|---:|
| 自动模拟开仓 | 暂停 |
| 单笔风险预算 | 账户权益的 0.35% |
| HIGH 单笔风险倍率 | 0.5 |
| 单笔保证金上限 | 账户权益的 2% |
| 最大持仓 | 4 个 |
| 总保证金上限 | 账户权益的 8% |
| 组合总止损风险上限 | 账户权益的 1% |
| 同方向高相关风险上限 | 账户权益的 0.5% |
| 高相关阈值／窗口 | 0.8／60 根已收盘 15M |
| 每日亏损熔断 | 2%，触发后锁定至下一 UTC 日 |
| 模拟吃单费 | 单边 5 bps |
| 基础滑点 | 单边 2 bps |
| 正常扫描／HIGH 风险检查 | 45／10 秒 |
| 盘口／1M 陈旧阈值 | 5／90 秒 |

这些是待回测校准的工程默认值，不是最优参数。PAPER 的“标的上限”是内置模拟杠杆；LIVE 禁止使用它，并读取签名账户、实际杠杆、持仓、维持保证金档位、强平价和 isolated margin。

## 页面

- 交易总览：账户、K 线、机会队列、持仓、组合风险、三态迁移和 WebSocket 指标；LIVE 估值未知时显示不可用，不以零或旧标记价代替。
- 流动性交易池：搜索、筛选、排序，以及每币状态、数据年龄和波动指标。
- 订单与持仓：明确区分模拟与真实成交、费用、平仓和复盘记录。
- 风险与执行：三态与组合参数、暂停、紧急停止、模拟账户重置，以及需独立管理员确认的手动真实 canary。
- 回测与复盘：单标的（以单合约组合运行）或多标的同步组合回测、历史结果和权益曲线；旧格式结果仍可读取。
- 信号验证：1–5 个合约、900–10000 根主时间轴的后台批量回测；按时间顺序 60%／20%／20% 划分训练、验证和样本外区间，保存每个 READY 的成交或拒绝、净 R、MFE、MAE 与成交偏差，并导出全部或测试集 CSV。

## 技术与数据

- 前端：React、TypeScript、Tailwind CSS、Lightweight Charts、Recharts。
- 后端：Hono、tRPC、Drizzle ORM。
- 数据库：外部 MySQL 兼容数据库；历史验收使用 MariaDB 10.11，本轮修复的 0000–0004 全量迁移与完整集成测试另在独立 MySQL 8.0.46 通过。
- 持久化：设置、订单、持仓、交易、三态、审计事件、权益快照和回测结果。

## 配置与运行

准备外部数据库并设置 `DATABASE_URL=mysql://user:password@host:port/database`。不要把生产数据库用于测试。另需设置至少 32 个字符的随机 `APP_SECRET`：它只用于本系统管理员控制鉴权，不是币安 API 密钥。可复制 `.env.example` 为 `.env` 后填写，切勿提交真实 `.env`。

开发运行：

```bash
npm install
npm run db:migrate
npm run dev
```

`npm run db:push` 仅适合可丢弃的开发库；升级和全新验收使用带迁移记录的 `db:migrate`。

生产检查与启动：

```bash
npm run check
npm test
npm run lint
npm run build
DATABASE_URL='mysql://user:password@host:port/database' APP_SECRET='replace-with-a-random-secret-of-32-plus-characters' PORT=3000 npm start
```

端口被占用时选择其他空闲端口（例如 3001），不要终止不认识的进程。只读查询保持公开；扫描、参数修改、自动交易开关、平仓、重置及回测写操作均要求 `Authorization: Bearer <APP_SECRET>`。页面顶部“解锁控制”会完成同源验证，令牌只保存在当前标签页的 `sessionStorage`。公网部署仍必须使用 HTTPS 和反向代理访问控制，不得把 `APP_SECRET` 写入前端环境变量、Git 或 URL。

### 主网执行门控

默认始终是 `PAPER`、`momentumEnabled=false`、`LIVE_TRADING_ENABLED=false`、`armed=false`。生产 coordinator 只保存懒解析入口；只有数据库选择 `LIVE_MAINNET`、环境总开关和主网凭据同时存在，并由持久化 armed、当前 arming 人工授权或已有未结真实风险触发时，才创建签名客户端、订单 adapter、私有 WS、对账与恢复服务。PAPER 不解析这些服务，缺配置或启动失败均失败关闭且不会回退成 paper 账户。

主网预检还要求 `BINANCE_MAINNET_ALLOWED_SYMBOLS` 显式白名单、固定 1–20 倍杠杆、one-way、关闭 multi-assets、isolated margin、真实档位/过滤值/强平数据、已连接私有 WS 与新鲜对账。最终风险使用签名 positionRisk 的持仓数量、标记价、margin、强平价和账户权益，执行日损、maxPositions、同 symbol、组合及相关性限制；flat symbol 仅使用保守估算缓冲。REST 与响应体有硬 deadline，预检网络不持有 DB 锁，transport 前以 DB 时间重查过期、armed 和 emergency generation。币安凭据可由服务器 `BINANCE_MAINNET_API_KEY`／`BINANCE_MAINNET_API_SECRET` 完整环境变量对提供，或在风险页保存为 AES-256-GCM 密文；完整环境变量对始终优先，否则读取数据库密文。后者必须在服务器设置 `CREDENTIAL_ENCRYPTION_KEY`（32 字节 base64 或 64 位十六进制），缺失或错误会失败关闭。保存、替换或删除凭据不会改变 LIVE、momentum、armed 或 autoTrade；只有成功写入后才停止已初始化的签名客户端，避免并发请求保留旧凭据，加密或数据库失败不会中断现有服务。明文不进入数据库、Rust、状态响应或日志。

本轮只完成 fake/replay、独立测试库与无真实凭据验证。主网只读仍需用户提供权限受限凭据并另行确认；真实 canary 由 `trading.manualCanary` 和风险页表单触发，必须重新输入管理员令牌及 `SUBMIT LIVE CANARY`，不会开启自动交易，并仍受白名单和完整风控约束。小范围自动交易还要求真实 canary 与观察期通过。完成这些工程验证不代表已经启用实盘或能够盈利。

Docker 采用多阶段构建，不复制 `.env` 进镜像：

```bash
docker build -t swing-sentinel .
docker run --rm --env-file .env -p 3000:3000 swing-sentinel
```

## 数据库集成测试

为测试单独创建数据库和仅拥有该库权限的用户，不得使用 preview 或生产库。通用套件使用 `swing_sentinel_final_fix1_test`，并先执行 0000–0013 迁移；设置 `TEST_DATABASE_URL` 后 Vitest 串行执行文件：

```bash
DATABASE_URL='mysql://task_user:task_password@127.0.0.1:3306/swing_sentinel_final_fix1_test' npm run db:migrate
TEST_DATABASE_URL='mysql://task_user:task_password@127.0.0.1:3306/swing_sentinel_final_fix1_test' npm test
```

LIVE 持久化组有独立安全门禁，必须分别使用 `TASK3_TEST_DATABASE_URL` 指向 `swing_sentinel_task3_test`、`TASK4_TEST_DATABASE_URL` 指向 `swing_sentinel_task4_test`，不要用同名变量绕过隔离。通用门禁还接受 `swing_sentinel_task1_test` 和 `swing_sentinel_task8_test`；其他库名会被拒绝。未设置对应变量时相关真实数据库套件跳过，其余单元测试仍运行。测试完成后删除这些专用测试库和测试用户。

## 回测口径与限制

组合回测按统一时间轴共享权益、持仓、日损和三态，信号收盘后在下一根开盘成交，计双边手续费与不利滑点，并读取历史资金费率。样本外验证的各区间使用相同参数和独立初始权益，不跨区间延续持仓或日亏状态；历史请求并发限制为 2，波动样本按需计算以控制长历史内存。相关性按 15M `closeTime` 对齐完整 60 收益窗口，缺口或未收盘样本失败关闭。资金费事件允许开盘起 1 秒内的交易所毫秒时间戳抖动并归一到该开盘；真正无法对齐的数据失败关闭。

同一根 K 线内按强平、止损、目标的保守顺序处理；移动止损在收盘确认后对后续 K 线生效。期末退出计滑点，回撤纳入盘中不利高低价。历史盘口不可重建，点差只使用显式摩擦假设；强平与资金费结算仍为近似，不代表真实账户结果。当前流动性合约池还存在存续与选品偏差，样本外指标和前向模拟都需要继续复核，不能单独据此推断实盘盈利。实时资金费使用结算检查时的当前标记价近似，历史资金费使用对齐事件开盘标记价近似；二者均不是交易所账单。

## Rust 影子核心

`rust-core/` 是独立 Tokio/Axum 服务，最多并发 8 个分析任务，默认只监听 `127.0.0.1:8787`：

```bash
cd rust-core
cargo test
cargo run --release
```

健康检查为 `GET /health`，批量分析为 `POST /v1/analyze/batch`。Rust 还消费主网公共 aggTrade/bookTicker/depth/markPrice，通过回环内部入口向 TypeScript 发送特征帧和候选；TS 负责接受、风控与订单。Rust 不接收凭据、账户数据或订单权限。Replay 使用独立 trade/mark/book 事件，默认三个 mark 历史和两次候选确认与 Rust 对齐，P80 使用同口径历史特征帧。真实公共网络、多日浸泡和实盘表现仍需独立验收。

## 验收边界

本轮全分支修复的命令、RED/GREEN 回归和独立数据库结果见 `final-fix-report.md`。短时有界测试不等于连续多日浸泡；本仓库未宣称已完成真实凭据只读、真实账户订单、真实交易所对账或实盘验收。
