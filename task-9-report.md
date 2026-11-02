# Task 9 Report — Production wiring and staged delivery verification

## Status

Complete for gated production wiring, isolated migrations, DB integration, fake/replay lifecycle, full checks, and production browser verification. No real credentials, real orders, preview DB, or preview server were used. No push was performed.

Implementation/docs commit: `4eb2b713fb55584649ec6025fa170ddf6742ed37` (`feat: wire gated production live services`). This report is committed separately so the implementation SHA identifies the exact code tree.

All live defaults remain off: `PAPER`, `momentumEnabled=false`, `LIVE_TRADING_ENABLED=false`, `autoTrade=false`, and `armed=false`.

## Production wiring

- `ExecutionCoordinator` now supports an async lazy live provider. PAPER always resolves only the paper adapter. LIVE unavailable/start-failed views fail closed and never substitute paper account data.
- The production singleton injects `productionLiveRuntime`; module import creates no Binance client, adapter, socket, timer, or reconciliation service.
- Actual service construction requires LIVE_MAINNET plus `LIVE_TRADING_ENABLED=true` and both server-side credentials, followed by persisted armed, the current explicit arming operation, or existing outstanding live risk for recovery/exit. Existing services remain available after disarm for recovery and reduce-only exits; the DB and transport admission gates still block entries.
- `productionServices` composes `BinanceSignedClient`, Drizzle order/reconciliation/accounting stores, the live order machine, private user-data WS, accounting synchronization, startup REST recovery/reconciliation, periodic reconciliation, and shutdown. Failed or in-flight startup is stopped and not cached as configured.
- `BINANCE_MAINNET_ALLOWED_SYMBOLS` is a new blank-by-default explicit whitelist. Preflight requires fixed leverage, account/contract gates, real filters/brackets/liquidation data, fresh private WS and reconciliation. Fresh signed account/preflight data is fetched before the DB transaction; `finalGate` performs only DB reads/rechecks inside the transaction.
- README, UPGRADE_NOTES, and `.env.example` document these gates and the remaining authorization stages without claiming profitability or enabled live trading.

## RED → GREEN evidence

1. `executionCoordinator.lazyLive.test.ts` initially failed 2/4: armed LIVE did not resolve the lazy adapter and arming had no human-approval context. After the coordinator change, the file and related coordinator/engine suites passed 65/65.
2. `productionRuntime.test.ts` initially failed because `productionRuntime` did not exist. The gate matrix, shared startup, disarm/recovery, and failed-start reset then passed. A new partial-start cleanup assertion failed with 0 stops before the fix; an in-flight shutdown test then failed with a null adapter race before stop was made to await/close the pending lifecycle. Final runtime suite: 9/9.
3. `productionServices.test.ts` initially failed because the builder did not exist. The real composition with fake Binance/WebSocket and in-memory stores then passed: startup reconciliation ran, preflight stayed false before a fresh private event, became ready after one, stop closed the socket, and `placeOrder` was never called.
4. `executionCoordinator.singleton.test.ts` initially rejected `LIVE_MAINNET adapter 尚未配置`; after singleton injection it passed and proved LIVE account access calls the gated runtime.
5. `npm run check` initially exposed non-erasable constructor syntax in three existing live modules plus new socket/leverage/test fixture errors. Those were minimally corrected; focused live suites passed 92/92 and the final type check passed.
6. The first DB-enabled full run failed on unmigrated Task 3/4 DBs and DB decimal scale. After isolated migrations, `drizzleLiveOrderStore.integration.test.ts` reproduced `3.000…` versus canonical `3`; Drizzle position mapping now normalizes decimals. Unit mocks then caught optional `undefined` breakout handling, which was also fixed.
7. `livePersistence.integration.test.ts` then exposed a stale fixture: no required NORMAL volatility row and intent expiry fixed over 13 hours in the past. The fixture was repaired without weakening the gates; final result 27/27.
8. The first real browser run found dashboard HTTP 500 on public Binance `fetch failed`. A router regression failed before the dashboard catch and passed afterward. The next run found missing live gates returned HTTP 500; a router test failed with `INTERNAL_SERVER_ERROR`, then passed as `PRECONDITION_FAILED` (HTTP 412). The next run found empty LIVE→PAPER still required a live adapter; a DB-risk regression failed before the fallback and passed afterward.
9. A PAPER status assertion failed with `adapterConfigured=true`; it now reports true only for an actually resolved adapter in LIVE mode.

## Isolated database and migrations

- Initialized a new temporary MariaDB 10.11.14 datadir at `/tmp/swing-task9-mariadb.apVXh8`, bound only to `127.0.0.1:3307`; PID 4375.
- Created a local-only fake user and three fresh databases: `swing_sentinel_task9_test`, `swing_sentinel_task3_test`, and `swing_sentinel_task4_test`. The verification config was a new mode-0600 file under that temporary directory. Existing `.env` and preview settings were not read or modified; subsequent dotenv commands explicitly used `DOTENV_CONFIG_PATH` for the temporary file.
- Ran `npm run db:migrate` independently against all three databases. Task 9 DB evidence: 13 migration records for 0000–0012, 22 tables, `live_orders.admission_generation=int`, and `max_entry_price=decimal`. Task 3 and Task 4 DBs each had 22 tables before their suites.
- Final `npm test` with `TEST_DATABASE_URL`, `TASK3_TEST_DATABASE_URL`, and `TASK4_TEST_DATABASE_URL` populated: **50 files passed, 476 tests passed, 0 failed, 0 skipped**. This includes paper 17, volatility 6, live persistence 27, and durable order store 3 real DB integration tests.

## Full checks and fake/replay lifecycle

- `npm run check`: exit 0.
- `npm run lint`: exit 0.
- `npm run build`: exit 0; Vite transformed 2441 modules and the Node boot bundle completed. Only the existing approximately 2.6 MB boot-size warning remains.
- `git diff --check` and staged diff check: exit 0.
- `cargo fmt --check`: exit 0.
- `cargo test`: **35 passed, 0 failed, 1 ignored**; the ignored test is the intentional bounded Binance public smoke.
- `cargo clippy --all-targets -- -D warnings`: exit 0.
- Exact fake/replay command: `npx vitest run api/services/momentum.test.ts api/services/momentumReplay.test.ts api/live/orderStateMachine.test.ts api/live/liveExecution.test.ts` → **4 files, 66/66 passed**. Coverage includes momentum acceptance/risk gates, timestamped trade/order-book replay, IOC partial/duplicate/out-of-order fills, replacement using actual remainder, reduce-only exit, UNKNOWN/reconciliation, and restart/crash recovery. No exchange order call was real.

## Production browser verification

- Ran the built `npm start` service on `127.0.0.1:3109`: npm PID 20887, node PID 20902; HTTP 200.
- WebBridge was unavailable (stale live PID without a listener), so no daemon stop/restart was attempted. Actual rendering used local headless Chromium through the already installed Playwright library, not SSR-only assertions.
- Nine completed steps: Dashboard PAPER; Risk with all gates off; invalid admin 401; valid admin 200; LIVE selected but failed closed; arming rejected HTTP 412 with `LIVE_TRADING_ENABLED`; returned to PAPER; backtest page rendered; out-of-sample page rendered.
- Final clean rendering phase: **0 console errors, 0 page errors, 0 HTTP errors**. The intentionally triggered admin 401 and gate 412 each produced the browser’s expected “Failed to load resource” message and are recorded separately, not hidden as clean-pass errors.
- Screenshots were visually inspected for Dashboard, disabled-LIVE Risk, backtest, and out-of-sample pages. Final SQL state: `PAPER`, momentum/autoTrade/armed all 0; live orders/intents/fills all 0.

## Service and data cleanup

- Production verification service stopped; PID 20887/20902 no longer exist and port 3109 is closed.
- Dropped only the three Task 9 verification databases and `swing_task9` user; SQL counts afterward were 0 and 0.
- Temporary MariaDB PID 4375 stopped; port 3307 is closed.
- Removed `/tmp/swing-task9-mariadb.apVXh8`, including its datadir, fake local config, browser script, reports, and screenshots. No preview resource was touched.

## Remaining mainnet gates / concerns

- Mainnet read-only verification remains: it needs separately approved, permission-restricted credentials to verify real account, leverage brackets, private stream, income/fees, and reconciliation. None was claimed here.
- An idle Binance private stream may have no account/order event. Current readiness intentionally requires a fresh real event, so an idle account remains disarmed/unready. This bootstrap behavior must be verified with restricted credentials before canary; do not manufacture freshness.
- For a flat symbol, exchange `liquidationPrice` can be zero. The real-risk gate rejects missing/nonpositive liquidation data rather than substituting paper estimates. A safe real-data canary path must be demonstrated before enabling entries.
- Manual canary remains a separate explicit authorization: one whitelist symbol, minimum safe quantity, real fill/protection/cancel/close/restart reconciliation, and autoTrade still off. It was not run. Small-scope auto trading additionally requires canary and observation-period success.
- Public Binance connectivity was unavailable in this environment. The browser verified the safe degraded dashboard, not live public connectivity or profitability. Real order/canary behavior is deliberately unverified and disabled.

## Review fix round 1

Code/test commit: `91bf07ff6af2b37da8bb533a99d33bc9a3c445e1` (`fix: preserve live recovery during lifecycle transitions`). This report update is committed separately. No subagents, push, real credentials, real exchange calls, or preview resources were used.

### RED / GREEN

- **Unresolved reconciliation hang**: the new real-composition regression initially timed out after 5 seconds because adapter publication awaited the `ok:false` retry loop. Startup now waits only for the first reconciliation outcome, publishes the adapter with entry admission suspended, and leaves retries active. The same test then completed fake reduce-only close and emergency while preflight remained unready; `placeOrder` was only the local fake.
- **PAPER transition cleanup**: the switch regression initially completed with zero stop calls. The coordinator now awaits the runtime stop hook after successful PAPER persistence; singleton wiring stops private WS/accounting/reconciliation. Focused test passed.
- **Process shutdown**: `processShutdown.test.ts` was initially RED because the module was absent. The installed SIGTERM/SIGINT handlers now await live cleanup before exit 0, or use exit 1 on cleanup failure. Both tests passed; `api/boot.ts` connects the actual production process without changing dev/test imports.
- **Restart during shutdown**: RED showed the second service constructed before the first deferred stop was released. A stopping promise and generation checks now serialize cleanup/restart and prevent stale publication. Runtime suite passed 10/10, including the earlier shutdown-during-start case.
- **Paper/live risk scope**: both new tests were RED—paper-only pending work returned true and a live pending intent returned false. The gate now reads only live positions/intents/orders with shared terminal statuses; both passed.
- **Router error sanitization**: RED reflected a fake internal DB URL as PRECONDITION_FAILED. Only known gate prefixes now retain their safe messages; unexpected errors use generic INTERNAL_SERVER_ERROR text without configuration content. Router suite passed 9/9.

### Verification

- Combined focused regression set: **10 files, 101/101 passed**.
- Final focused set after type-fixture cleanup: **6 files, 30/30 passed**.
- `npm test`: **48 files passed, 4 skipped; 431 passed, 53 skipped, 0 failed**. The skips are the DB suites because the verified temporary DB was already removed; their prior real-DB results remain documented above.
- `npm run check`: exit 0. `npm run lint`: exit 0. `npm run build`: exit 0; 2441 Vite modules and the production boot bundle completed. `git diff --check` and staged diff check: exit 0.
- Rust was not impacted by this TypeScript-only round, so no Rust result is claimed for the fix commit.
