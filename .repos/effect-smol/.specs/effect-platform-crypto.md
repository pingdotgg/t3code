# Effect Platform Crypto Service Specification

## Summary

Add a platform-agnostic `Crypto` service to `effect`. The service provides cryptographic random bytes, cryptographically secure random generators, UUIDv4 / UUIDv7 generation, and digest operations through an Effect service interface, with platform-specific implementations supplied by runtime packages such as `@effect/platform-node`, `@effect/platform-bun`, and `@effect/platform-browser`.

The service replaces `Random.nextUUIDv4`. UUIDv4 and UUIDv7 generation are exposed on the `Crypto` service and derived by the `make` constructor from the primitive `randomBytes` implementation. UUIDv7 also uses the `Clock` service for the Unix millisecond timestamp.

## Background and Research

Platform services in this repository follow the pattern used by `FileSystem`:

- Core service abstraction: `packages/effect/src/FileSystem.ts`.
- Node wrapper: `packages/platform-node/src/NodeFileSystem.ts`.
- Bun wrapper: `packages/platform-bun/src/BunFileSystem.ts`.
- Shared Node/Bun implementation: `packages/platform-node-shared/src/NodeFileSystem.ts`.

Important conventions from that implementation:

- The service interface lives in `effect` and carries a unique `TypeId` property.
- The service tag is created with `Context.Service`.
- Platform-specific packages expose `layer` values that provide the service.
- Node and Bun can share implementation code when Bun supports the relevant Node API.
- Generated `index.ts` barrel files must not be edited manually; run `pnpm codegen` after adding modules.
- Platform errors should use `PlatformError` where possible.
- Library implementation code should avoid `async` / `await` and `try` / `catch`, using Effect APIs instead.

The current base `Random` service is not cryptographically secure because its default implementation is based on `Math.random`. `Crypto` extends the `Random` service shape so platform crypto implementations can expose cryptographically secure random number generation through `Crypto` service methods.

## User Requirements and Clarifications

- Add a platform-agnostic `Crypto` Effect service.
- `Crypto` must extend the `Random` service.
- Include UUIDv4 and UUIDv7 generators so users can stop using `Random.nextUUIDv4`.
- `randomUUIDv4` must be a service method derived by `make`, not a primitive required from platform implementations.
- `randomUUIDv4` must format bytes from the service's `randomBytes(16)` and follow UUIDv4 version/variant requirements.
- `randomUUIDv7` must be a service method derived by `make`, format bytes from `randomBytes(16)`, use `Clock.currentTimeMillis` for the 48-bit Unix millisecond timestamp, and follow UUIDv7 version/variant requirements.
- Define `DigestAlgorithm` as a string literal union.
- Add cryptographically secure counterparts to the `Random` module generators as service methods with clearer names: `random`, `randomBoolean`, `randomInt`, `randomBetween`, `randomIntBetween`, `randomShuffle`, `randomUUIDv4`, and `randomUUIDv7`.
- Keep the initial `Crypto` surface limited to random bytes, random generators, UUID generation, and digests.

## Proposed Public API

Add `packages/effect/src/Crypto.ts`.

```ts
import * as Context from "./Context.ts"
import * as Clock from "./Clock.ts"
import type * as Effect from "./Effect.ts"
import type { PlatformError } from "./PlatformError.ts"
import type * as Random from "./Random.ts"

const TypeId = "~effect/platform/Crypto"

export type DigestAlgorithm = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512"

export interface Crypto extends Random.Random {
  readonly [TypeId]: typeof TypeId

  readonly randomBytes: (
    size: number
  ) => Effect.Effect<Uint8Array, PlatformError>

  readonly digest: (
    algorithm: DigestAlgorithm,
    data: Uint8Array
  ) => Effect.Effect<Uint8Array, PlatformError>

  readonly random: Effect.Effect<number>
  readonly randomBoolean: Effect.Effect<boolean>
  readonly randomInt: Effect.Effect<number>
  readonly randomBetween: (min: number, max: number) => Effect.Effect<number>
  readonly randomIntBetween: (
    min: number,
    max: number,
    options?: { readonly halfOpen?: boolean | undefined }
  ) => Effect.Effect<number>
  readonly randomShuffle: <A>(elements: Iterable<A>) => Effect.Effect<Array<A>>
  readonly randomUUIDv4: Effect.Effect<string, PlatformError>
  readonly randomUUIDv7: Effect.Effect<string, PlatformError>
}

export const Crypto: Context.Service<Crypto, Crypto> = Context.Service("effect/platform/Crypto")

export const make: (impl: Omit<Crypto, typeof TypeId | "random" | "randomBoolean" | "randomInt" | "randomBetween" | "randomIntBetween" | "randomShuffle" | "randomUUIDv4" | "randomUUIDv7">) => Crypto
```

## Functional Requirements

### Core `Crypto` Module

1. Add `packages/effect/src/Crypto.ts`.
2. Define `TypeId` as `"~effect/platform/Crypto"`.
3. Define `DigestAlgorithm` as a top-level string literal union.
4. Use Web Crypto algorithm names `"SHA-1"`, `"SHA-256"`, `"SHA-384"`, and `"SHA-512"`.
5. Do not require platform implementations to provide derived random generator helpers.
6. Define `Crypto` as an extension of `Random.Random` with `randomBytes` and `digest`.
7. Include `randomUUIDv4`, `randomUUIDv7`, and the random generator helpers on the `Crypto` service interface.
8. Define the service tag with `Context.Service("effect/platform/Crypto")`.
9. Do not add top-level accessors; users should retrieve the service and call its methods.
10. Add cryptographically secure random generator helpers matching the `Random` module capabilities with clearer names to the service interface.
11. Derive service `randomUUIDv4` from `randomBytes(16)`.
12. Derive service `randomUUIDv7` from `Clock.currentTimeMillis` and `randomBytes(16)`.
13. Keep the core module platform-agnostic; it must not import `node:crypto` or rely directly on `globalThis.crypto`.
14. The `make` helper should accept the primitive implementation and derive random helper methods, similar to `ChildProcessSpawner.make`.

### Random Generator Requirements

1. `random` must use `Crypto.nextDoubleUnsafe`.
2. `randomBoolean` must use `Crypto.nextDoubleUnsafe() > 0.5`.
3. `randomInt` must use `Crypto.nextIntUnsafe`.
4. `randomBetween` must follow `Random.nextBetween` semantics.
5. `randomIntBetween` must follow `Random.nextIntBetween` semantics, including `halfOpen`.
6. `randomShuffle` must follow `Random.shuffle` semantics.
7. The random generator helper names must be more descriptive than the base `Random` names.

### UUIDv4 Requirements

1. `randomUUIDv4` must return a lowercase UUIDv4 string.
2. It must satisfy the standard UUIDv4 shape: `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`, where `y` is one of `8`, `9`, `a`, or `b`.
3. It must call `randomBytes(16)` and format those bytes according to UUIDv4 rules.
4. It must set the version bits to `0100` in byte 6.
5. It must set the variant bits to `10` in byte 8.
6. It must not use `Random`, `Math.random`, `Date.now`, `new Date`, or platform `crypto.randomUUID`.

### UUIDv7 Requirements

1. `randomUUIDv7` must return a lowercase UUIDv7 string.
2. It must satisfy the standard UUIDv7 shape: `xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx`, where `y` is one of `8`, `9`, `a`, or `b`.
3. Bytes 0 through 5 must encode the current Unix timestamp in milliseconds from `Clock.currentTimeMillis` as a big-endian 48-bit integer.
4. Remaining UUID bits must come from `randomBytes(16)` except for overwritten timestamp, version, and variant bits.
5. It must set the version bits to `0111` in byte 6.
6. It must set the variant bits to `10` in byte 8.
7. It must not use `Random`, `Math.random`, `Date.now`, `new Date`, or platform `crypto.randomUUID`.

### Random Bytes Requirements

1. `randomBytes(size)` must generate cryptographically secure random bytes.
2. `size` must be a safe non-negative integer.
3. Invalid sizes must fail with `PlatformError.badArgument`.
4. `randomBytes(0)` should succeed with an empty `Uint8Array`.
5. Browser implementations must respect the `crypto.getRandomValues` per-call limit by chunking large requests, typically at `65_536` bytes.
6. Returned byte arrays should be fresh arrays owned by the caller.

### Digest Requirements

1. `digest(algorithm, data)` must compute a cryptographic digest of `data`.
2. The returned value must be a `Uint8Array`.
3. The input `data` must not be mutated.
4. Platform failures must be represented as `PlatformError` values.
5. SHA-1 is included for compatibility with Web Crypto and existing protocols, but documentation must state that SHA-1 should not be used for new security-sensitive designs.

## Platform Implementation Plan

### Node and Bun Shared Implementation

Add `packages/platform-node-shared/src/NodeCrypto.ts`.

Requirements:

1. Import `node:crypto`.
2. Implement `randomBytes` with `crypto.randomBytes`.
3. Implement `nextIntUnsafe` and `nextDoubleUnsafe` with synchronous cryptographically secure random bytes.
4. Implement `digest` with `crypto.webcrypto.subtle.digest` or equivalent Node crypto APIs.
5. Convert backend exceptions and promise rejections to `PlatformError`.
6. Export `layer: Layer.Layer<Crypto.Crypto>`.

Add thin runtime wrappers:

- `packages/platform-node/src/NodeCrypto.ts` re-exports `NodeCrypto.layer`.
- `packages/platform-bun/src/BunCrypto.ts` re-exports the shared layer if Bun compatibility is sufficient.

### Browser Implementation

Add `packages/platform-browser/src/BrowserCrypto.ts`.

Requirements:

1. Use `globalThis.crypto` as the backend.
2. Implement `randomBytes` with `crypto.getRandomValues`, chunking large requests.
3. Implement `nextIntUnsafe` and `nextDoubleUnsafe` with synchronous `crypto.getRandomValues`.
4. Implement `digest` with `crypto.subtle.digest`.
5. Fail with a clear `PlatformError.systemError({ _tag: "Unknown" })` when required crypto capabilities are unavailable.
6. Do not require Node types or Node imports.

## Service Aggregation

Update Node service aggregation:

- Add `Crypto` to `packages/platform-node/src/NodeServices.ts` imports and `NodeServices` union.
- Merge `NodeCrypto.layer` into `NodeServices.layer`.

Update Bun service aggregation:

- Add `Crypto` to `packages/platform-bun/src/BunServices.ts` imports and `BunServices` union.
- Merge `BunCrypto.layer` into `BunServices.layer`.

No browser aggregate service module currently exists. Do not introduce one solely for this task unless maintainers request it.

## Random Migration Plan

1. Remove `Random.nextUUIDv4`.
2. Update `Random` module documentation to remove UUID examples.
3. Update `packages/effect/test/Random.test.ts` to remove UUID-specific tests.
4. Add tests and documentation showing `Crypto.Crypto` service `randomUUIDv4` as the replacement.
5. Document that the base `Random` service is not cryptographically secure and should not be used for security-sensitive values.

## Documentation Requirements

Add detailed JSDoc to `packages/effect/src/Crypto.ts` and update `packages/effect/src/Random.ts`.

The documentation must explain:

1. `Crypto` is for cryptographic randomness and cryptographic operations.
2. The base `Random` service is not cryptographically secure.
3. `Random.withSeed` provides deterministic replacement for repeatability; predictable seeds are not cryptographically secure.
4. UUID generation should use the `Crypto` service's `randomUUIDv4` or `randomUUIDv7`, not `Random.nextUUIDv4`.
5. Platform implementations must be provided through layers.
6. SHA-1 is available only for compatibility and should be avoided for new security-sensitive designs.

## Testing Requirements

### Core Tests

Add `packages/effect/test/Crypto.test.ts`.

Test cases:

1. `DigestAlgorithm` supports the expected string literal values.
2. `randomBytes` delegates to the provided service.
3. Random generator methods derive from the `Random` methods on the provided `Crypto` service.
4. `randomUUIDv4` formats bytes from the provided service's `randomBytes` method.
5. `randomUUIDv7` formats bytes from the provided service's `randomBytes` method and the `Clock` timestamp.
6. `digest` delegates to the service.
7. A custom `Crypto` service can be provided via `Effect.provideService`.

### Node Tests

Add `packages/platform-node/test/NodeCrypto.test.ts`.

Test cases:

1. `randomBytes(0)` returns an empty `Uint8Array`.
2. `randomBytes(32)` returns 32 bytes.
3. Invalid sizes fail with `PlatformError`.
4. Service `randomUUIDv4` returns a valid UUIDv4 string when provided with the Node layer.
5. Service `randomUUIDv7` returns a valid UUIDv7 string with the current `Clock` timestamp when provided with the Node layer.
6. Two UUIDs generated from Node cryptographic random bytes are not equal in a basic smoke test.
7. SHA-256 digest of a known input matches the known vector.

### Browser Tests

Add `packages/platform-browser/test/BrowserCrypto.test.ts`.

Test cases:

1. `randomBytes` delegates to `getRandomValues` and handles chunking.
2. Service `randomUUIDv4` formats bytes from browser `getRandomValues`.
3. Service `randomUUIDv7` formats bytes from browser `getRandomValues` and the `Clock` timestamp.
4. Missing crypto capabilities fail with `PlatformError`.
5. SHA-256 digest matches a known vector if `crypto.subtle` is available.

## Generated Files

After adding modules, run `pnpm codegen`.

Expected generated barrel updates:

- `packages/effect/src/index.ts`.
- `packages/platform-node/src/index.ts`.
- `packages/platform-bun/src/index.ts`.
- `packages/platform-browser/src/index.ts`.

Do not manually edit generated barrel files.

## Changeset Requirements

Add a changeset covering at least:

- `effect`.
- `@effect/platform-node`.
- `@effect/platform-node-shared`.
- `@effect/platform-bun`.
- `@effect/platform-browser`.

The changeset must state:

- A new platform-agnostic `Crypto` service was added.
- `Crypto` extends `Random` and exposes cryptographically secure random generator helpers.
- `Crypto` service `randomUUIDv4` formats bytes from the platform `Crypto` service.
- `Crypto` service `randomUUIDv7` formats bytes from the platform `Crypto` service and uses the `Clock` service timestamp.
- `DigestAlgorithm` is represented as a string literal union.
- Users should migrate away from `Random.nextUUIDv4` for UUID generation.

## Validation Plan

Run validation in this order:

1. `pnpm lint-fix`.
2. `pnpm codegen`.
3. `pnpm test packages/effect/test/Crypto.test.ts`.
4. `pnpm test packages/platform-node/test/NodeCrypto.test.ts`.
5. `pnpm test packages/platform-browser/test/BrowserCrypto.test.ts`.
6. `pnpm test packages/effect/test/Random.test.ts`.
7. `pnpm check:tsgo`.
8. If `pnpm check:tsgo` repeatedly fails due to stale caches, run `pnpm clean` and rerun `pnpm check:tsgo`.
9. For localized `effect` package documentation changes, run `cd packages/effect && pnpm docgen`.

## Acceptance Criteria

1. `Crypto` is available from `effect/Crypto`.
2. `DigestAlgorithm` is a top-level string literal union.
3. `Crypto` extends the base `Random` service type.
4. Service `randomUUIDv4` derives UUIDs from service `randomBytes(16)` and formats UUIDv4 version/variant bits correctly.
5. The service interface contains `randomUUIDv4` and `randomUUIDv7` as derived methods.
6. `randomBytes` validates sizes and returns cryptographically secure random bytes.
7. `digest` supports SHA-1, SHA-256, SHA-384, and SHA-512 through `DigestAlgorithm` values.
8. The `Crypto` service exposes `random`, `randomBoolean`, `randomInt`, `randomBetween`, `randomIntBetween`, `randomShuffle`, `randomUUIDv4`, and `randomUUIDv7`.
9. Platform failures are represented as `PlatformError` values.
10. Core and platform tests pass.
11. JSDoc examples compile with docgen.
12. Generated barrel files are regenerated with `pnpm codegen`.
13. A changeset documents the new service and UUID migration guidance.

## Risks and Mitigations

1. Risk: Formatting UUIDv4 in the core module could set version or variant bits incorrectly.
   - Mitigation: Add tests with deterministic bytes and validate the UUIDv4 shape.
2. Risk: Browser `getRandomValues` is unavailable in some environments.
   - Mitigation: Fail with a structured `PlatformError` for effectful operations.
3. Risk: `DigestAlgorithm` string inputs invite typos or inconsistent algorithm spelling.
   - Mitigation: Use a top-level string literal union with Web Crypto algorithm names and centralize platform mapping.
4. Risk: Existing users rely on deterministic UUIDs from `Random.nextUUIDv4` in tests.
   - Mitigation: Document that deterministic IDs should be provided through a fake `Crypto` service or an explicit test service.

## Open Questions

None. The user clarified that `Random.nextUUIDv4` should be removed and the initial crypto surface should remain limited. PR review clarified that `DigestAlgorithm` should be a string literal union and that random helpers should live on the service interface.
