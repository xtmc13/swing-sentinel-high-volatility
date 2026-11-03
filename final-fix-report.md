# Final whole-branch fix report

Branch: `feat/mainnet-momentum`
Base for this wave: `a52df70`
Scope: all Critical/Important findings in `.superpowers/sdd/2026-11-02-mainnet-momentum/final-findings.md`, plus the pending-intent and arming races found during self-review.

No real exchange credentials, real orders, preview database, or preview server were used. LIVE defaults remain disabled. Valid interrupted work was preserved and completed.

## Finding evidence

### Critical 1 — missed first fills and terminal orders

- RED: `reconciliation.test.ts > recovers a missed first fill from a terminal owned order using its persisted intent seed` returned `ok=false` and no recovered position in the interrupted baseline.
- GREEN: every owned order, including FILLED/CANCEL, is recovered with an existing position or persisted intent/bracket seed. Production passes `currentSeed` and the accounting ledger into reconciliation. The recovered position is visible to close/emergency and native protection is restored.
- Proof: `api/live/reconciliation.test.ts` (23 passed); durable DB suites below.

### Critical 2 — LIVE account and `manage()` stubs

- RED: all three tests in `liveExecution.management.test.ts` failed: PnL/daily lock stayed zero/false, no reduceOnly exits occurred, and trailing protection did not move.
- GREEN: signed account, signed positionAmt/entry/mark/liquidation/isolatedWallet, persisted UTC daily baseline/lock, daily-loss close, 2.2R close, breakeven/trailing stop, 72-hour close, and native protection replacement are implemented. Original risk stop and tick size survive restart; legacy missing original-stop history remains unknown and cannot invent a target.
- Proof: `api/live/liveExecution.management.test.ts` (4 passed); `liveDailyRisk.test.ts`; real DB daily restart test.

### Critical 3 — signed daily/portfolio/correlation/maxPositions/same-symbol risk

- RED: review reproduction at the wave base showed database-only margin, zero existing margin, and no production portfolio/correlation/maxPositions/same-symbol admission. The interrupted helper tests were already present; production composition was unfinished. Self-review then produced RED when pending intents were ignored by maxPositions/same-symbol checks.
- GREEN: preflight caches signed account and all positionRisk rows outside DB locks. The final DB gate uses signed margin, exposure, marks, liquidation and equity, current persisted stops, DB-time pending reservations and symbols, daily state, portfolio/correlation budgets, active-plus-pending maxPositions, and active-or-pending same-symbol exclusion. Flat symbols use a conservative maintenance-margin estimate; active symbols use exchange liquidation data.
- Proof: `api/live/liveRisk.test.ts` (11 passed), `productionServices.test.ts`, and typechecked production composition in `productionServices.ts`.

### Critical 4 — REST deadlines and network under DB locks

- RED: the real-DB arming regression timed out disarm for 500 ms while preflight held the controls lock. Deadline tests from the interrupted wave were already present and passing.
- GREEN: every signed REST call and response-body parse has an abort/deadline; placeOrder timeout enters UNKNOWN through the existing state machine. create/admit/arming preflight runs outside DB transactions. Final admission checks controls, generation, and DB-time expiry atomically. Arming carries its initial generation, so a concurrent disarm wins.
- Proof: `api/live/binanceSigned.test.ts` (46 passed); `drizzleLiveOrderStore.test.ts`; `livePersistence.integration.test.ts > arming 网络预检不持有 controls 锁，并发 disarm 获胜且不被旧 arming 覆盖` RED→GREEN.

### Important 1 — final expiry

- RED: `rechecks intent expiry against database time at final transport admission` returned SUBMITTING for an expired intent.
- GREEN: final transport admission reads DB current time and cancels expired entry intents before network transport; replacement submissions use the same path.
- Proof: `api/live/drizzleLiveOrderStore.test.ts` (4 passed) and real DB integration.

### Important 2 — ledger-aware issue resolution

- RED: ledger-explained wallet change returned `ok=false` and left BALANCE_MISMATCH open.
- GREEN: wallet/cross-wallet deltas are compared with ledger expectations, commission signs are normalized, recovered asset issues are resolved, and unexplained differences remain severe. Available balance is not misclassified as a ledger-only delta because margin movements also affect it.
- Proof: `api/live/reconciliation.test.ts` (23 passed).

### Important 3 — idle WS and flat-symbol handling

- RED: an idle connected WS with healthy heartbeat/REST reconciliation was not ready; flat-symbol coverage was incomplete.
- GREEN: readiness uses running/connected state, valid heartbeat timestamp, and fresh successful REST reconciliation rather than requiring an application event every 10 seconds. Flat symbols receive a conservative liquidation buffer; signed active liquidation remains authoritative.
- Proof: `productionServices.test.ts > keeps an idle but connected private WS eligible while heartbeat and REST reconciliation stay healthy`; `liveRisk.test.ts > derives a conservative maintenance-margin liquidation buffer for a flat symbol`.

### Important 4 — directional tick normalization

- RED: trailing management did not normalize/replace protection in the baseline.
- GREEN: entry, initial stop, and trailing protection use directional exact-decimal tick rounding. STOP_MARKET replacement updates both price and stopPrice. Persisted tick size is restored after restart.
- Proof: `decimal.test.ts` (11 passed), `liveExecution.management.test.ts`, and durable trailing-stop DB test.

### Important 5 — replay/Rust sampling and P80 parity

- RED: both `momentumReplay.parity.test.ts` tests failed; replay fabricated marks from books. The new engine P80 regression failed with `波动未达到 P80 确认阈值` when one-minute returns were used.
- GREEN: replay consumes independent trade/mark/book events, never samples a future mark, requires three marks like Rust, and retains two-candidate confirmations. Engine P80 uses a bounded, source-reset history of prior GOOD Rust realized-volatility frames, not one-minute candle returns; insufficient history fails closed.
- Proof: replay 9 tests passed, engine 29 tests passed, Rust feature/candidate suites passed.

### Important 6 — truthful LIVE UI

- RED: `formatSignedNumber` was missing; signed REST failure initially escaped the snapshot path.
- GREEN: unknown PnL/mark/percentage values display `—`; measured zero displays `0.00`; targets derive from durable original risk or remain unknown. Signed positionRisk refreshes persisted marks. If signed REST reads fail, the snapshot returns invalid/NaN fields with `dailyLocked=true`, not stale marks or zero PnL.
- Proof: `src/lib/format.test.ts`; `liveExecution.management.test.ts > returns an unavailable LIVE snapshot instead of stale marks or zero PnL when signed REST fails` RED→GREEN; production build.

### Important 7 — controlled canary route

- RED: `trading.manualCanary` was NOT_FOUND.
- GREEN: admin-only mutation requires bearer auth, fresh admin secret, exact `SUBMIT LIVE CANARY`, side/price validation, and calls only `openManual`; it never saves or enables autoTrade. The LIVE-only Risk page form uses the same controls and reports submission versus failure without claiming a fill.
- Proof: `api/tradingRouter.execution.test.ts` (10 passed); typecheck and production build.

### Important 8 — accurate documentation

- RED: README still claimed no credential collection/no real-order capability and Rust disconnected.
- GREEN: README and UPGRADE_NOTES now describe optional disabled-by-default LIVE execution, server-only credentials, real-order/canary boundaries, signed risk, independent test DB rules, Rust loopback candidate/frame integration, and unexecuted real-world gates.
- Proof: documentation review, `npm run check`, `npm run lint`, and `npm run build` after edits.

## Additional self-review fixes

- Pending intents now consume maxPositions and same-symbol admission, not only margin/risk (`liveRisk.test.ts` RED→GREEN).
- Arming/disarm generation race covered by a real independent DB regression (RED→GREEN).
- LIVE daily baseline uses DECIMAL(65,30), not double.
- Legacy positions without original-stop history do not fabricate a 2.2R target (`drizzleLiveOrderStore.test.ts` RED→GREEN).

## Verification commands and results

Focused regression runs were performed before the full pass; every final focused group is green.

- Clean MariaDB 10.11 migration: `DATABASE_URL=<disposable final-fix test DB> npm run db:migrate` → 0000–0013 applied, 14 migration rows; `tick_size`, `initial_stop_price`, and DECIMAL `live_daily_risk.day_start_equity` verified.
- Full general/unit/DB suite: `TEST_DATABASE_URL=<disposable final-fix test DB> npm test` → **473 passed, 33 skipped**; the 33 are the separately guarded LIVE groups run next.
- `TASK3_TEST_DATABASE_URL=<disposable task3 test DB> npx vitest run api/live/livePersistence.integration.test.ts` → **29 passed**.
- `TASK4_TEST_DATABASE_URL=<disposable task4 test DB> npx vitest run api/live/drizzleLiveOrderStore.integration.test.ts` → **4 passed**.
- Combined executed Node tests across these isolated runs: **506 passed, 0 failed**.
- `npm run check` → exit 0.
- `npm run lint` → exit 0.
- `npm run build` → exit 0; Vite and bundled API build completed.
- `git diff --check` → exit 0.
- `cargo fmt --check && cargo test && cargo clippy --all-targets -- -D warnings` → exit 0; **35 passed, 0 failed, 1 ignored** (the ignored test is the explicitly bounded real public-network smoke).

Test resources were cleaned afterward: `swing_sentinel_final_fix1_test`, `swing_sentinel_task3_test`, `swing_sentinel_task4_test`, and the test-only DB user were dropped; follow-up queries returned no rows.

## Commits

- Implementation commit: `599d514` (`fix: complete final live safety wave`).
- Report commit: this report and the final ledger note are committed separately on the same feature branch.

## Remaining real-world gates

- No profitability, optimal-parameter, multi-day soak, or real public/private network claim is made.
- Permission-restricted real read-only account/positionRisk/listenKey/income verification remains unexecuted.
- A real minimal-whitelist canary, native fill/protection/cancel/close/restart reconciliation, and the subsequent observation period remain unexecuted and require separate explicit user authorization.
- Automatic LIVE trading must remain off until those gates pass and the user explicitly enables one whitelisted symbol.
