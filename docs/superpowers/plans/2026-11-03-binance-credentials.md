# Binance Credential Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-only encrypted Binance MAINNET credential entry without changing LIVE, armed, momentum, or autoTrade gates.

**Architecture:** AES-256-GCM encrypts one JSON credential payload with a random IV and version-bound authentication data. Drizzle stores only ciphertext, IV, tag, key version, and timestamps; tRPC exposes only `{configured}`. Complete `BINANCE_MAINNET_*` environment pairs take precedence, otherwise the production runtime asynchronously decrypts the stored pair before constructing the existing signed client.

**Tech Stack:** TypeScript, Node crypto, Drizzle/MySQL, tRPC, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-multi-exchange-design.md` (credential subset; direct public RiskPage overrides its removed admin-only UI proposal).

## Global Constraints

- Binance MAINNET only; no OKX, subagents, preview, push, real credentials, or real orders.
- `CREDENTIAL_ENCRYPTION_KEY` is a server-only 32-byte base64 or 64-character hexadecimal key; missing/invalid keys fail closed with a safe configuration error.
- Public API responses contain exactly `{configured:boolean}` and logs/errors never contain plaintext or key fragments.
- Credential writes touch only the credential table and cannot arm, enable LIVE/momentum, or enable autoTrade.
- Preserve the Industrial UI and do not add admin controls or an admin bar.
- Database tests use only a dedicated independent test database.

## Review Focus

- Wrong key, modified ciphertext/IV/tag, and wrong keyVersion must fail authentication without returning plaintext.
- Malformed, overlong, non-string, or extra API input must be rejected before storage; credential HTTP bodies are capped at 4 KiB.
- Partial environment pairs must not be treated as complete; a complete pair deterministically overrides stored credentials.
- Saving/deleting while LIVE gates are configured must not mutate settings or controls or submit orders.
- Password fields must never be populated from status queries; success/error feedback must not echo submitted values.

### Task 1: Crypto, schema, and store

**Files:** Create `api/credentials/credentialCrypto.ts`, `api/credentials/binanceCredentialStore.ts`, focused unit/integration tests, migration `0014_binance_credentials.sql`; modify `db/schema.ts` and migration journal.

- [ ] Write roundtrip, random IV, tamper, wrong-key/version, missing/invalid-key, and no-leak tests; run them and confirm RED.
- [ ] Implement minimal AES-256-GCM helpers and run tests GREEN.
- [ ] Write store save/replace/delete/status and unchanged-live-gate integration tests against the independent DB; confirm RED.
- [ ] Add the schema/migration and Drizzle store; run focused tests GREEN.

### Task 2: Credential API and body limit

**Files:** Create `api/credentialRouter.ts` and tests; modify `api/router.ts` and `api/boot.ts`.

- [ ] Write caller tests for exact status/save/delete responses, strict 64-character alphanumeric input, safe configuration/internal errors, and no gate/coordinator writes; confirm RED.
- [ ] Implement public credential procedures with injected store and generic safe failures; confirm GREEN.
- [ ] Add a 4 KiB limit for credential tRPC paths and test the HTTP behavior without preview; confirm GREEN.

### Task 3: Stored credentials in live production resolution

**Files:** Modify `api/live/liveConfig.ts`, `productionServices.ts`, `productionRuntime.ts`, `productionSingleton.ts`, `api/services/executionCoordinator.ts`, focused tests, and `README.md`.

- [ ] Write failing tests for stored fallback, env precedence, missing-key fail-closed behavior, and unchanged existing gates.
- [ ] Add async credential resolution/factory support and inject stored status/resolution only in production singletons; confirm GREEN.
- [ ] Verify production services construct `BinanceSignedClient` from decrypted stored values without network/orders and credential saves do not alter settings/controls; confirm GREEN.
- [ ] Document key format and env-first precedence.

### Task 4: RiskPage credential form

**Files:** Create `src/components/BinanceCredentialForm.tsx` and test; modify `src/pages/RiskPage.tsx`.

- [ ] Write failing SSR tests for MAINNET labeling, password/empty fields, configured-only readback, save/delete feedback, and no admin wrapper.
- [ ] Implement the Industrial panel with tRPC mutations, field clearing, status invalidation, toast/inline feedback, and delete confirmation; mount it directly in RiskPage; confirm GREEN.

### Task 5: Verification and commit

- [ ] Run focused tests, `npm run check`, full `npm test`, `npm run lint`, and `npm run build` with no preview or real-order calls.
- [ ] Inspect the diff and secret-leak tests, preserve unrelated untracked files, and commit only this feature on `feat/mainnet-momentum` without pushing.
