# Task 6 Report — Rust 早期动量检测器

## Status

Implemented on `feat/mainnet-momentum`. Local formatting, tests, and lint are green. The bounded public Binance smoke could not connect from this environment, so mainnet network operation is not claimed as verified. No push, credentials, account/order endpoints, preview database, or preview server were used.

Commit subject: `feat: add Rust public momentum detector` (local `HEAD`).

## RED / GREEN evidence

- Baseline: existing crate passed 2 tests with the pre-existing unused `Candle.time` warning.
- Depth RED: `cargo test --test depth_sync` initially failed because the library/contracts did not exist. After the first implementation, the resync case failed because a diff chained to the new snapshot was not accepted. GREEN: 4/4 tests pass, including bounded overflow, duplicate suppression, gap/rebuild, and ordered bridging.
- Features/candidates RED: `cargo test --test features` and `cargo test --test candidates` failed for missing modules and types. GREEN: 3/3 feature tests and 4/4 candidate tests pass, covering metrics/metadata, stale and one-sided/crossed data, one-frame suppression, consecutive confirmation, mirrored short, replay rejection, and fail-closed streak reset.
- Public/transport RED: both suites initially failed for missing modules. The first transport run then failed literal IPv6 loopback validation; a new non-finite metric test also failed before deep validation was added. GREEN: 3/3 public parser/subscription tests and 5/5 transport tests pass, including a real ephemeral loopback HTTP POST and strict unknown-field/value rejection.
- Runtime/HTTP RED: both suites initially failed for missing modules. Runtime then exposed a snapshot-before-diff bug: the snapshot was discarded instead of retained for first-diff bridging. GREEN: 2/2 runtime tests, all depth regressions, and the HTTP compatibility test pass.
- Settings RED: `cargo test --test settings` failed for the missing service module. GREEN: 3/3 tests pass for default-disabled operation, required loopback delivery, and malformed/duplicate symbol rejection.
- Final GREEN: 27 tests passed, 0 failed, 1 explicitly ignored live-network smoke; doc tests 0 failed. Compiler and clippy warning count is zero with `-D warnings`.

## Architecture

- `rust-core/src/public_market.rs`: fixed Binance USD-M mainnet public REST/WS URLs; aggTrade, bookTicker, diff depth, markPrice, and 1m K-line parsing; bounded snapshot/message sizes and connect/read support. No private URL or credential support exists.
- `rust-core/src/depth.rs`: REST snapshot plus buffered diff synchronization, `U/u/pu` continuity, duplicate handling, bounded buffers, generation increments, and gap-triggered fail-closed resync.
- `rust-core/src/features.rs`: microprice, spread bps, top-depth imbalance, aggressive buy/sell flow, short-window mark return, 1-second-bucket burst score, and unannualized realized log-return volatility. Frames carry event/receive time, sequence, generation, quality, and SHA-256 config hash.
- `rust-core/src/candidate.rs`: fresh Good-quality frames only, directional depth/flow/return/burst/spread/volatility gates, two-frame confirmation, replay suppression, 750 ms candidate expiry, and mirrored short logic.
- `rust-core/src/transport.rs`: strict candidate validation/JSON bounds, literal IPv4/IPv6 loopback-only HTTP(S), no credentials/query/fragment, no redirects, timeout, and non-2xx failure.
- `rust-core/src/runtime.rs`: per-symbol composition of depth, features, K-line consumption, and candidate detection.
- `rust-core/src/service.rs`: supervised public sessions with 100-level snapshots, 256-event depth buffers, 5-second request/send timeouts, 10-second read timeout, bounded reconnect backoff, and reconnect on gap/delivery failure.
- `rust-core/src/diagnostics.rs`, `http.rs`: health plus `/diagnostics` and `/v1/momentum/diagnostics`.
- `rust-core/src/legacy.rs`: old `/v1/analyze/batch` shadow analyzer retained with its 100-symbol/8-task bounds; `main.rs` is now only composition. HTTP remains loopback-only at `127.0.0.1:8787` by default. Momentum is disabled unless `MOMENTUM_ENABLED=true` with valid symbols and `MOMENTUM_CANDIDATE_URL`.

## Verification commands and exact results

Run from `rust-core/` using `/root/.cargo/bin/cargo`:

- `cargo fmt --check`: exit 0.
- `cargo test`: exit 0; 27 passed, 0 failed, 1 ignored (`public_snapshot_and_three_stream_events`); doc tests 0 failed.
- `cargo clippy -- -D warnings`: exit 0.
- `cargo clippy --all-targets -- -D warnings`: exit 0.
- `cargo test --test public_smoke -- --ignored --nocapture`: exit 101; REST public depth request timed out after 5 seconds before WS smoke could run. Direct `curl --max-time 10` to the same public depth URL also failed with curl 28, HTTP `000`, and connection timeout. Connections were bounded and dropped; no existing service was affected.

Coverage includes depth gap/resync, stale frames, one/two-sided and crossed books, single-frame suppression, consecutive confirmation, fail-closed no-candidate paths, sequence/replay and frame quality/config metadata, all required public event parsers, loopback delivery, runtime composition, settings, and old health/shadow compatibility.

## Concerns / follow-up

- Live public connectivity remains unverified in this environment; rerun the ignored smoke where Binance mainnet is reachable.
- Detector thresholds are initial engineering defaults, not calibrated trading parameters or evidence of profitability. TS acceptance/risk remains a separate task; this task does not place orders.
- K-lines are consumed and closed K-line diagnostics are tracked; higher-timeframe direction/structure stays outside Rust. Burst uses a 1-second-bucket score with a zero-baseline-variance fallback, and realized volatility is not annualized; replay/calibration should validate both choices.
- No long-duration soak, TS/Rust replay equivalence, or TS receiver integration was performed. The live smoke is intentionally ignored in the default suite to keep tests hermetic.


## Review fix round 1

Code/test commit SHA: `14979d3f818b156296ca1867e57a57c39ca42e41` (`fix: harden Rust momentum review boundaries`). The report update is committed separately so this SHA remains exact.

### RED / GREEN

- Generation RED: `reconnect_runtime_preserves_supplied_monotonic_generation` failed because `SymbolRuntime::new_with_generation` did not exist. `generation_change_resets_streak_and_allows_sequence_restart_but_rejects_old_generation` failed when a new generation's second frame could not confirm. GREEN: `run_session` receives an outer monotonically increasing generation; depth/runtime preserve it; candidate confirmation resets on generation advancement, permits sequence restart, and rejects older generations.
- Proxy RED: `candidate_delivery_bypasses_system_proxy_environment` set HTTP/HTTPS/ALL proxy variables to a real local 502 proxy and failed with `candidate endpoint returned 502 Bad Gateway`. GREEN: reqwest `no_proxy()` bypasses the system proxy; the loopback receiver accepts the candidate and the proxy remains unused.
- Snapshot RED: the chunked unknown-length test initially failed because cumulative `bounded_json` streaming did not exist. A raw-fixture request-exchange error was corrected without changing the assertion. GREEN: response chunks are accumulated with a pre-append hard byte check and rejected before JSON decoding; `depth_snapshot` uses this path for both known and unknown lengths.
- History RED: cap tests failed because `max_trade_history`, `max_mark_history`, and `HISTORY_OVERFLOW` were absent. GREEN: defaults cap trades at 50,000 and marks at 2,000 entries; overflow is sticky and fail-closed, emits `HISTORY_OVERFLOW`, and runtime requests resync for either history type.
- Mark causality RED: the regression selected `Some(999.0)` from a future mark instead of `Some(101.0)` at the frame event time. GREEN: frames select the latest mark with `event_time <= frame.event_time`.
- BookTicker sequence reuse is intentional: it emits a feature frame but cannot advance candidate confirmation until the depth sequence advances. The renamed `book_ticker_reusing_depth_sequence_cannot_confirm_or_emit` regression documents and verifies this behavior.

### Final verification

Using `/root/.cargo/bin/cargo` from `rust-core/`:

- `cargo fmt --check`: exit 0.
- `cargo test`: exit 0; **34 passed, 0 failed, 1 ignored** live-network smoke; doc tests 0 failed.
- `cargo clippy --all-targets -- -D warnings`: exit 0.
- `git diff --check`: exit 0 before commit.

No real credentials, account/order calls, preview services, or push were used. The prior environment-related public smoke limitation is unchanged.
