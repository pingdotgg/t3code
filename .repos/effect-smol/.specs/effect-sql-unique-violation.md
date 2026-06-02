# Effect SQL UniqueViolation SqlError Reason Specification

## Summary

Add a new SQL error reason class named `UniqueViolation` to the Effect SQL error model. The reason must be used when a database driver reports a UNIQUE constraint violation, and it must expose a required `constraint: string` property that identifies the violated constraint or unique index when possible. If the identifier cannot be determined reliably, `constraint` must be `"unknown"`.

## Background and Research

Current SQL error classification is centered in `packages/effect/src/unstable/sql/SqlError.ts` and in driver-specific clients:

- Core reason classes and `SqlErrorReason` union: `packages/effect/src/unstable/sql/SqlError.ts`.
- SQLite shared classifier: `classifySqliteError` in `packages/effect/src/unstable/sql/SqlError.ts`.
- PostgreSQL classifier: `packages/sql/pg/src/PgClient.ts`.
- PGlite classifier: `packages/sql/pglite/src/PgliteClient.ts`.
- MySQL classifier: `packages/sql/mysql2/src/MysqlClient.ts`.
- MSSQL classifier: `packages/sql/mssql/src/MssqlClient.ts`.

Today, all integrity constraint violations are represented by `ConstraintError`. This includes database-reported UNIQUE violations such as PostgreSQL/PGlite SQLSTATE `23505`, SQLite `SQLITE_CONSTRAINT_UNIQUE` / extended result code `2067`, MySQL duplicate-entry errno `1062`, and MSSQL errors `2601` / `2627`. The new `UniqueViolation` reason should represent those unique-specific cases, while non-unique integrity violations continue to use `ConstraintError`.

Existing consumers also key off `ConstraintError` for concurrency/duplicate-insert behavior:

- `packages/effect/src/unstable/sql/Migrator.ts` maps migration insert `ConstraintError` to a locked migration error.
- `packages/effect/src/unstable/eventlog/SqlEventLogServerUnencrypted.ts` ignores a duplicate singleton insert by catching `ConstraintError`.

Those consumers must be updated to treat `UniqueViolation` the same way where appropriate, otherwise the new classification would break existing behavior.

Existing tests to extend include:

- `packages/effect/test/unstable/sql/SqlError.test.ts`.
- `packages/sql/pg/test/SqlErrorClassification.test.ts`.
- `packages/sql/mysql2/test/SqlErrorClassification.test.ts`.
- `packages/sql/mssql/test/SqlErrorClassification.test.ts`.

A new PGlite classification test is expected because `packages/sql/pglite/test` currently has no dedicated `SqlErrorClassification.test.ts`.

## User Requirements and Clarifications

- Add a new `SqlError` reason class named `UniqueViolation`.
- Use `UniqueViolation` when a UNIQUE constraint is violated.
- `UniqueViolation` must include a `constraint` property.
- Map all supported drivers that can specifically identify a unique constraint violation.
- Keep other constraint violations mapped to `ConstraintError`.
- If a constraint identifier cannot be determined, set `constraint` to `"unknown"`.

## Functional Requirements

### Core SQL Error Model

1. Add `UniqueViolation` in `packages/effect/src/unstable/sql/SqlError.ts` as a sibling reason class to `ConstraintError`.
2. `UniqueViolation` must:
   - Have tag `"UniqueViolation"`.
   - Have class identifier `"effect/sql/SqlError/UniqueViolation"`.
   - Include all common reason fields: `cause`, optional `message`, optional `operation`.
   - Include required `constraint: string`.
   - Set `readonly [ReasonTypeId] = ReasonTypeId`.
   - Return `false` from `isRetryable`.
3. Add `UniqueViolation` to:
   - The `SqlErrorReason` TypeScript union.
   - The `SqlErrorReason` `Schema.Union` type tuple.
   - The runtime `Schema.Union([...])` list.
4. Place `UniqueViolation` adjacent to `ConstraintError`, preferably before `ConstraintError`, to keep unique violations grouped with integrity constraint reasons and to avoid any accidental preference for the broader type in future schema changes.
5. Existing `SqlError.message`, `SqlError.cause`, `SqlError.isRetryable`, `isSqlError`, and `isSqlErrorReason` behavior must remain unchanged.

### Constraint Identifier Normalization

1. `UniqueViolation.constraint` should be the best available database-reported identifier.
2. The fallback value must be exactly `"unknown"`.
3. All extraction helpers must normalize identifiers consistently:
   - Accept only strings.
   - Trim leading and trailing whitespace.
   - If the trimmed string is empty, use `"unknown"`.
4. Extraction precedence must be:
   - Prefer explicit structured fields such as `cause.constraint` when available.
   - Use driver-specific message parsing only for common stable messages when no structured field exists.
   - Never throw during extraction; malformed or absent metadata must produce `"unknown"`.
5. The `constraint` property may represent a constraint name, unique index name, key name, or stable database-produced descriptor depending on the driver.

### Driver Classification Requirements

#### PostgreSQL (`@effect/sql-pg`)

1. SQLSTATE `23505` must map to `UniqueViolation` before the broader `code.startsWith("23")` `ConstraintError` branch.
2. `constraint` must come from normalized `cause.constraint` when it is a non-empty string.
3. If `cause.constraint` is unavailable, not a string, or blank, use `"unknown"`.
4. Other `23***` SQLSTATE values, such as `23503`, must continue to map to `ConstraintError`.

#### PGlite (`@effect/sql-pglite`)

1. SQLSTATE `23505` must map to `UniqueViolation` before the broader `code.startsWith("23")` `ConstraintError` branch.
2. `constraint` must come from normalized `cause.constraint` when it is a non-empty string.
3. If unavailable or blank, use `"unknown"`.
4. Other `23***` SQLSTATE values must continue to map to `ConstraintError`.

#### SQLite-family drivers

Applies to all users of shared `classifySqliteError`, including sqlite-node, sqlite-bun, sqlite-wasm, sqlite-react-native, sqlite-do, libsql, and OPFS worker call sites.

1. String code `SQLITE_CONSTRAINT_UNIQUE` must map to `UniqueViolation`.
2. Numeric extended result code `2067` must map to `UniqueViolation`.
3. Generic `SQLITE_CONSTRAINT` and base numeric result code `19` must continue to map to `ConstraintError` unless the unique extended code is known.
4. SQLite primary-key-specific codes such as `SQLITE_CONSTRAINT_PRIMARYKEY` / `1555` are out of scope for this request and should remain classified as they are today unless separately requested.
5. `constraint` extraction must:
   - Prefer normalized `cause.constraint` if present.
   - Otherwise parse common messages such as `UNIQUE constraint failed: table.column` and use the normalized suffix after `: `, for example `table.column`.
   - Otherwise use `"unknown"`.

#### MySQL (`@effect/sql-mysql2`)

1. Errno `1062` must map to `UniqueViolation` before the broader constraint error code set.
2. Other MySQL constraint errno values, including `1022`, `1048`, `1169`, `1216`, `1217`, `1451`, `1452`, and `1557`, must continue to map to `ConstraintError`.
3. `constraint` extraction must:
   - Prefer normalized `cause.constraint` if present.
   - Otherwise parse common duplicate-entry messages from `cause.sqlMessage` or `cause.message` containing `for key 'key_name'`, `for key `key_name``, or `for key key_name`.
   - Otherwise use `"unknown"`.
4. If errno `1062` represents a duplicate primary key, the key name (for example `PRIMARY`) may be used as the `constraint` because MySQL reports primary-key and unique-index duplicates through the same duplicate-entry code.

#### MSSQL (`@effect/sql-mssql`)

1. Error numbers `2601` and `2627` must map to `UniqueViolation` before the broader constraint error code set.
2. Other MSSQL constraint errors, including `515` and `547`, must continue to map to `ConstraintError`.
3. `constraint` extraction must:
   - Prefer normalized `cause.constraint` if present.
   - For `2627`, parse common messages containing `constraint 'constraint_name'`.
   - For `2601`, parse common messages containing `unique index 'index_name'`.
   - Otherwise use `"unknown"`.

### Existing Consumer Requirements

1. `packages/effect/src/unstable/sql/Migrator.ts` must treat `UniqueViolation` the same way it currently treats `ConstraintError` when mapping duplicate migration insert failures to `MigrationError({ kind: "Locked", message: "Migrations already running" })`.
2. `packages/effect/src/unstable/eventlog/SqlEventLogServerUnencrypted.ts` must catch `UniqueViolation` in the same path that currently catches `ConstraintError` for duplicate singleton `remote_id` insertion.
3. The implementation should avoid duplicating tag checks across call sites if a small local predicate improves readability, but no new public helper is required by this request.

### Backward Compatibility and Release Notes

1. This is an additive reason class, but it changes classification for unique constraint violations from `ConstraintError` to `UniqueViolation`.
2. Code that only handles generic `ConstraintError` will no longer match unique violations by tag. The changeset must explicitly mention this behavior change.
3. Existing `ConstraintError` remains unchanged for non-unique constraint violations.
4. Existing uses that check `error.reason.isRetryable` will preserve behavior because both `ConstraintError` and `UniqueViolation` are non-retryable.
5. Existing schema encoding/decoding for previous reason classes must remain unchanged.
6. The changeset should be a patch release entry unless maintainers decide the tag-level classification change needs a larger semver impact.

## Non-Functional Requirements

1. Follow existing code style and patterns in `.patterns/` and surrounding source files.
2. Do not manually edit generated barrel `index.ts` files. No new module is expected, so `pnpm codegen` should not be required.
3. Do not use `async` / `await` or `try` / `catch` in Effect library implementation code.
4. Keep helper functions small and pure.
5. Avoid broad or fragile message parsing; use simple, well-scoped extraction and fall back to `"unknown"`.

## Acceptance Criteria

1. `new UniqueViolation({ cause, message, operation, constraint })` can be constructed and is recognized by `isSqlErrorReason`.
2. `UniqueViolation` has `_tag === "UniqueViolation"`, `isRetryable === false`, and exposes the normalized `constraint` string supplied to the constructor/classifier.
3. `SqlErrorReason` schema can encode/decode `SqlError` values wrapping `UniqueViolation`.
4. PostgreSQL and PGlite SQLSTATE `23505` classify as `UniqueViolation`, using non-empty `cause.constraint` when available and `"unknown"` otherwise.
5. PostgreSQL and PGlite non-unique `23***` SQLSTATE values still classify as `ConstraintError`.
6. SQLite `SQLITE_CONSTRAINT_UNIQUE` and numeric extended code `2067` classify as `UniqueViolation`.
7. SQLite generic constraint code `SQLITE_CONSTRAINT` and base numeric code `19` still classify as `ConstraintError`.
8. MySQL errno `1062` classifies as `UniqueViolation`; other existing constraint errno values still classify as `ConstraintError`.
9. MSSQL numbers `2601` and `2627` classify as `UniqueViolation`; other existing constraint numbers still classify as `ConstraintError`.
10. `Migrator.ts` and `SqlEventLogServerUnencrypted.ts` preserve their existing duplicate-insert behavior after unique violations classify as `UniqueViolation`.
11. All new and existing affected tests pass.
12. Type checking, linting, and localized docgen checks pass as required by repository guidelines.
13. A changeset is added documenting the new `UniqueViolation` reason and the classification change for unique constraint violations.

## Implementation Plan

### Task 1: Add the core `UniqueViolation` reason class and core tests

Status: Completed. The core `UniqueViolation` reason was added to `SqlError.ts`, included in the `SqlErrorReason` type and schema unions, and covered by construction, recognition, retryability, constraint-retention, and schema roundtrip tests in `SqlError.test.ts`.

Validation completed for this task:

- `pnpm lint-fix`
- `pnpm test packages/effect/test/unstable/sql/SqlError.test.ts`
- `pnpm check:tsgo`
- `cd packages/effect && pnpm docgen`

Scope:

- `packages/effect/src/unstable/sql/SqlError.ts`.
- `packages/effect/test/unstable/sql/SqlError.test.ts`.

Steps:

1. Define `UniqueViolation` fields by extending the existing reason fields with `constraint: Schema.String`.
2. Add `export class UniqueViolation extends Schema.TaggedErrorClass<UniqueViolation>("effect/sql/SqlError/UniqueViolation")("UniqueViolation", UniqueViolationFields)`.
3. Implement `readonly [ReasonTypeId] = ReasonTypeId` and `get isRetryable(): boolean { return false }`.
4. Add `UniqueViolation` to the `SqlErrorReason` union and schema union, adjacent to and preferably before `ConstraintError`.
5. Update `packages/effect/test/unstable/sql/SqlError.test.ts`:
   - Include `UniqueViolation` in reason coverage using construction data that includes `constraint`.
   - Add a focused assertion that `constraint` is retained.
   - Add schema roundtrip coverage for `UniqueViolation`.
6. Run validation for this task:
   - `pnpm lint-fix`
   - `pnpm test packages/effect/test/unstable/sql/SqlError.test.ts`
   - `pnpm check:tsgo`
   - `cd packages/effect && pnpm docgen`

Rationale:

- The public reason class, union, schema, and tests must land together to keep the package type-correct and validated.

### Task 2: Update core consumers that currently catch `ConstraintError`

Status: Completed. Local `isConstraintConflict` predicates were added in both core consumers so `ConstraintError` and `UniqueViolation` continue to follow the existing duplicate/locked paths while non-SQL errors and other SQL errors remain unchanged.

Validation completed for this task:

- `pnpm lint-fix`
- `pnpm test packages/effect/test/unstable/sql/SqlError.test.ts`
- `pnpm test packages/sql/pg/test/SqlEventLogServerUnencrypted.test.ts`
- `pnpm test packages/sql/mysql2/test/SqlEventLogServerUnencrypted.test.ts`
- `pnpm test packages/sql/sqlite-node/test/SqlEventLogServerUnencrypted.test.ts`
- `pnpm check:tsgo`
- `cd packages/effect && pnpm docgen`

Scope:

- `packages/effect/src/unstable/sql/Migrator.ts`.
- `packages/effect/src/unstable/eventlog/SqlEventLogServerUnencrypted.ts`.
- Existing integration tests that exercise those paths.

Steps:

1. Update the migration insert error mapping so `error.reason._tag === "UniqueViolation"` is handled the same as `"ConstraintError"`.
2. Update the event log remote-id singleton insert catch predicate so `UniqueViolation` is handled the same as `ConstraintError`.
3. Prefer small local predicates such as `isConstraintConflict` if they make the affected code clearer.
4. Run validation for this task:
   - `pnpm lint-fix`
   - `pnpm test packages/effect/test/unstable/sql/SqlError.test.ts`
   - `pnpm test packages/sql/pg/test/SqlEventLogServerUnencrypted.test.ts`
   - `pnpm test packages/sql/mysql2/test/SqlEventLogServerUnencrypted.test.ts`
   - `pnpm test packages/sql/sqlite-node/test/SqlEventLogServerUnencrypted.test.ts`
   - `pnpm check:tsgo`
   - `cd packages/effect && pnpm docgen`

Rationale:

- Once unique violations stop being `ConstraintError`, these existing consumers would otherwise regress. Updating them is required for a shippable core behavior change.

### Task 3: Update SQLite shared classification and tests

Status: Completed. The shared SQLite classifier now normalizes unique constraint identifiers, extracts SQLite unique descriptors from explicit `cause.constraint` values or common `UNIQUE constraint failed: ...` messages, and maps both `SQLITE_CONSTRAINT_UNIQUE` and numeric extended result code `2067` to `UniqueViolation` before generic constraint handling. Generic `SQLITE_CONSTRAINT`, base numeric result code `19`, and primary-key-specific SQLite constraint codes remain classified as `ConstraintError`.

Validation completed for this task:

- `pnpm lint-fix`
- `pnpm test packages/effect/test/unstable/sql/SqlError.test.ts`
- `pnpm check:tsgo`
- `cd packages/effect && pnpm docgen`

Scope:

- `packages/effect/src/unstable/sql/SqlError.ts`.
- `packages/effect/test/unstable/sql/SqlError.test.ts`.

Steps:

1. Add small pure helpers in `SqlError.ts` to safely extract normalized string properties and SQLite unique constraint descriptors.
2. In string-code classification, check exact `SQLITE_CONSTRAINT_UNIQUE` before generic `SQLITE_CONSTRAINT`.
3. In numeric-code classification, check exact extended result code `2067` before masking to the base result code.
4. Create `UniqueViolation` with extracted `constraint` or `"unknown"`.
5. Keep generic `SQLITE_CONSTRAINT` and base result code `19` mapped to `ConstraintError`.
6. Do not add special mapping for SQLite primary-key-specific codes in this task.
7. Add tests for:
   - String code `SQLITE_CONSTRAINT_UNIQUE` -> `UniqueViolation`.
   - Numeric code / errno `2067` -> `UniqueViolation`.
   - Constraint descriptor parsing from `UNIQUE constraint failed: users.email`.
   - Blank or missing identifiers fall back to `"unknown"`.
   - Generic constraint remains `ConstraintError`.
8. Run validation for this task:
   - `pnpm lint-fix`
   - `pnpm test packages/effect/test/unstable/sql/SqlError.test.ts`
   - `pnpm check:tsgo`
   - `cd packages/effect && pnpm docgen`

Rationale:

- SQLite classification lives in the core Effect package, so pairing it with the core SqlError tests keeps validation self-contained.

### Task 4: Update PostgreSQL classification and tests

Status: Completed. PostgreSQL SQLSTATE `23505` is now classified as `UniqueViolation` before the broader integrity-constraint branch. The classifier normalizes `cause.constraint` by accepting only strings, trimming whitespace, and falling back to `"unknown"` for missing, non-string, or blank values. Non-unique integrity SQLSTATEs such as `23503` remain classified as `ConstraintError`.

Validation completed for this task:

- `pnpm lint-fix`
- `pnpm test packages/sql/pg/test/SqlErrorClassification.test.ts`
- `pnpm check:tsgo`

Scope:

- `packages/sql/pg/src/PgClient.ts`.
- `packages/sql/pg/test/SqlErrorClassification.test.ts`.

Steps:

1. Import `UniqueViolation` from `effect/unstable/sql/SqlError`.
2. Add a small helper to extract normalized `constraint` from a cause object, falling back to `"unknown"`.
3. Check `code === "23505"` before `code.startsWith("23")`.
4. Return `new UniqueViolation({ ...props, constraint })` for `23505`.
5. Ensure non-unique SQLSTATEs such as `23503` still return `ConstraintError`.
6. Extend `packages/sql/pg/test/SqlErrorClassification.test.ts` to assert:
   - `23505` -> `UniqueViolation`.
   - Constraint field is preserved from `cause.constraint` after trimming.
   - Missing or blank constraint falls back to `"unknown"`.
   - `23503` remains `ConstraintError`.
7. Run validation for this task:
   - `pnpm lint-fix`
   - `pnpm test packages/sql/pg/test/SqlErrorClassification.test.ts`
   - `pnpm check:tsgo`

Rationale:

- PostgreSQL has its own package and test surface; keeping it separate makes the task independently shippable.

### Task 5: Update PGlite classification and tests

Status: Completed. PGlite SQLSTATE `23505` is now classified as `UniqueViolation` before the broader integrity-constraint branch. The classifier normalizes `cause.constraint` by accepting only strings, trimming whitespace, and falling back to `"unknown"` for missing, non-string, or blank values. Non-unique integrity SQLSTATEs such as `23503` remain classified as `ConstraintError`. A dedicated `SqlErrorClassification.test.ts` uses a lightweight rejecting PGlite client mock to exercise classification without a live database.

Validation completed for this task:

- `pnpm lint-fix`
- `pnpm test packages/sql/pglite/test/SqlErrorClassification.test.ts`
- `pnpm check:tsgo`

Scope:

- `packages/sql/pglite/src/PgliteClient.ts`.
- New `packages/sql/pglite/test/SqlErrorClassification.test.ts`.

Steps:

1. Import `UniqueViolation` from `effect/unstable/sql/SqlError`.
2. Add a small helper to extract normalized `constraint` from a cause object, falling back to `"unknown"`.
3. Check `code === "23505"` before `code.startsWith("23")`.
4. Return `new UniqueViolation({ ...props, constraint })` for `23505`.
5. Ensure non-unique SQLSTATEs such as `23503` still return `ConstraintError`.
6. Add a dedicated classification test following nearby `@effect/vitest` patterns. Prefer a lightweight mocked/rejecting client path that exercises the PGlite classifier without needing a live database.
7. Test:
   - `23505` -> `UniqueViolation`.
   - Constraint field is preserved from `cause.constraint` after trimming.
   - Missing or blank constraint falls back to `"unknown"`.
   - `23503` remains `ConstraintError`.
8. Run validation for this task:
   - `pnpm lint-fix`
   - `pnpm test packages/sql/pglite/test/SqlErrorClassification.test.ts`
   - `pnpm check:tsgo`

Rationale:

- PGlite is similar to PostgreSQL but is a separate package. A dedicated task keeps validation focused and independently shippable.

### Task 6: Update MySQL classification and tests

Status: Completed. MySQL duplicate-entry errno `1062` is now classified as `UniqueViolation` before the generic constraint errno set. The classifier prefers a non-empty structured `cause.constraint`, then parses common duplicate-entry `for key ...` forms from `cause.sqlMessage` or `cause.message`, and falls back to exactly `"unknown"` for missing, blank, malformed, or non-string metadata. Other MySQL constraint errno values remain classified as `ConstraintError`.

Validation completed for this task:

- `pnpm lint-fix`
- `pnpm test packages/sql/mysql2/test/SqlErrorClassification.test.ts`
- `pnpm check:tsgo`

Scope:

- `packages/sql/mysql2/src/MysqlClient.ts`.
- `packages/sql/mysql2/test/SqlErrorClassification.test.ts`.

Steps:

1. Import `UniqueViolation` from `effect/unstable/sql/SqlError`.
2. Remove errno `1062` from the generic constraint classification path or check it before the constraint set.
3. Add helper logic to extract normalized `constraint`:
   - Prefer `cause.constraint` if it is a non-empty string after trimming.
   - Otherwise parse `cause.sqlMessage` or `cause.message` for `for key ...`.
   - Otherwise return `"unknown"`.
4. Return `new UniqueViolation({ ...props, constraint })` for errno `1062`.
5. Keep other existing constraint errno values mapped to `ConstraintError`.
6. Update tests to assert:
   - `1062` -> `UniqueViolation`.
   - Constraint key extraction from representative duplicate-entry messages.
   - Blank/missing/invalid message -> `"unknown"`.
   - Another constraint errno, such as `1048` or `1452`, remains `ConstraintError`.
7. Run validation for this task:
   - `pnpm lint-fix`
   - `pnpm test packages/sql/mysql2/test/SqlErrorClassification.test.ts`
   - `pnpm check:tsgo`

Rationale:

- MySQL has a distinct error shape and test mocking setup; this can ship independently after the core reason exists.

### Task 7: Update MSSQL classification and tests

Status: Completed. MSSQL error numbers `2601` and `2627` are now classified as `UniqueViolation` before generic constraint handling, with `515` and `547` retained as `ConstraintError`. The classifier normalizes structured `cause.constraint` values, parses common `constraint 'name'` and `unique index 'name'` messages for the respective MSSQL unique-violation numbers, and falls back to exactly `"unknown"` for missing, blank, malformed, or non-string metadata. Tests cover both unique numbers, structured-field precedence and trimming, fallback behavior, and the non-unique `547` constraint path.

Validation completed for this task:

- `pnpm lint-fix`
- `pnpm test packages/sql/mssql/test/SqlErrorClassification.test.ts`
- `pnpm check:tsgo`

Scope:

- `packages/sql/mssql/src/MssqlClient.ts`.
- `packages/sql/mssql/test/SqlErrorClassification.test.ts`.

Steps:

1. Import `UniqueViolation` from `effect/unstable/sql/SqlError`.
2. Remove numbers `2601` and `2627` from the generic constraint path or check them before the constraint set.
3. Add helper logic to extract normalized `constraint`:
   - Prefer `cause.constraint` if it is a non-empty string after trimming.
   - Parse `constraint 'name'` for `2627` messages.
   - Parse `unique index 'name'` for `2601` messages.
   - Otherwise return `"unknown"`.
4. Return `new UniqueViolation({ ...props, constraint })` for numbers `2601` and `2627`.
5. Keep other existing constraint numbers mapped to `ConstraintError`.
6. Update tests to assert:
   - `2601` -> `UniqueViolation` and extracts unique index name.
   - `2627` -> `UniqueViolation` and extracts constraint name.
   - Structured `cause.constraint` is preferred and trimmed.
   - Blank/missing/invalid message -> `"unknown"`.
   - `547` remains `ConstraintError`.
7. Run validation for this task:
   - `pnpm lint-fix`
   - `pnpm test packages/sql/mssql/test/SqlErrorClassification.test.ts`
   - `pnpm check:tsgo`

Rationale:

- MSSQL has a distinct error shape and test mocking setup; this can ship independently after the core reason exists.

### Task 8: Add release documentation and final validation

Status: Completed. The existing `.changeset/silver-snails-sqlite.md` was expanded to cover all directly affected release packages: `effect`, PostgreSQL, PGlite, MySQL, MSSQL, `@effect/sql-libsql`, and the SQLite-family packages using the shared SQLite classifier. The changeset now documents the new `UniqueViolation` SQL error reason, the classification change from `ConstraintError` to `UniqueViolation` for supported unique constraint violations, the exact `"unknown"` fallback, and the broadened PostgreSQL/PGlite/MySQL/MSSQL/shared-SQLite classification coverage.

Validation completed for this release-metadata task:

- `pnpm lint-fix`
- `pnpm check:tsgo`

Scope:

- Update the existing changeset under `.changeset/`.
- Run the final validation requested for this release-metadata-only task.

Steps:

1. Update the existing changeset for affected package(s). At minimum include `effect`, `@effect/sql-pg`, `@effect/sql-pglite`, `@effect/sql-mysql2`, and `@effect/sql-mssql`. This follow-up used exhaustive package entries for the SQLite-family packages whose classification changes through shared `classifySqliteError`.
2. The changeset must state:
   - `UniqueViolation` was added as a new SQL error reason.
   - Unique constraint violations now classify as `UniqueViolation` instead of `ConstraintError`.
   - The reason includes `constraint`, falling back to `"unknown"`.
3. For this release-metadata-only follow-up, run the validation requested by the task:
   - `pnpm lint-fix`
   - `pnpm check:tsgo`
   - If `pnpm check:tsgo` repeatedly fails due to stale caches, run `pnpm clean` and then rerun `pnpm check:tsgo`.
   - The behavior tests and localized docgen were completed in the implementation tasks above; no source code changes were made in this follow-up.
4. Confirm no generated barrel files were manually edited.
5. Confirm no scratchpad files remain.

Rationale:

- Documentation and full validation should happen after all behavior changes are present; this task is independently reviewable as release metadata plus verification.

## Risks and Mitigations

1. Risk: Existing application code checks only `error.reason._tag === "ConstraintError"` for unique violations.
   - Mitigation: Document the classification change in a changeset and release notes.
2. Risk: Internal consumers that currently catch `ConstraintError` regress.
   - Mitigation: Update `Migrator.ts` and `SqlEventLogServerUnencrypted.ts` and run integration tests for the affected storage paths.
3. Risk: Driver message formats vary by database version or locale.
   - Mitigation: Prefer structured properties, keep parsing conservative, normalize blank strings to `"unknown"`, and fall back to `"unknown"`.
4. Risk: SQLite numeric classification currently masks extended result codes to base codes.
   - Mitigation: Check exact extended unique code `2067` before masking with `0xff`.
5. Risk: Tests that use common reason-case constructor types may not account for `constraint` being required.
   - Mitigation: Adjust test helpers to support per-reason construction data or add focused `UniqueViolation` tests.
6. Risk: Adding `UniqueViolation` to schema union incorrectly can break schema encode/decode.
   - Mitigation: Add schema roundtrip tests wrapping `UniqueViolation`.

## Subagent Review Notes Incorporated

Two subagents reviewed the specification and implementation plan. Their recommendations were incorporated as follows:

- Added requirements and a dedicated task for internal consumers that currently catch `ConstraintError`.
- Split PostgreSQL and PGlite into separate independently shippable tasks.
- Added explicit blank/whitespace normalization rules for `constraint` extraction.
- Added explicit schema union placement guidance.
- Added SQLite primary-key-specific code scope guidance.
- Expanded validation to include event log storage tests.
- Made changeset package coverage and classification behavior change explicit.

## Open Questions

None. The user clarified that all supported drivers with specific unique violation identification should map to `UniqueViolation`, and that `constraint` may fall back to `"unknown"`.
