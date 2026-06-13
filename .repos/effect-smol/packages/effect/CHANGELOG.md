# effect

## 4.0.0-beta.73

### Patch Changes

- [#2291](https://github.com/Effect-TS/effect-smol/pull/2291) [`361ca30`](https://github.com/Effect-TS/effect-smol/commit/361ca30eb6e134feece547d6e00f82be4cb23f75) Thanks @tim-smart! - Add HttpApiSecurity.http for passing custom schemes

- [#2289](https://github.com/Effect-TS/effect-smol/pull/2289) [`b9598c6`](https://github.com/Effect-TS/effect-smol/commit/b9598c6a209e75bfdb87ee3b024ecd1e3923ff6e) Thanks @tim-smart! - make EntityResource lazy by default

## 4.0.0-beta.72

### Patch Changes

- [#2287](https://github.com/Effect-TS/effect-smol/pull/2287) [`73e67d1`](https://github.com/Effect-TS/effect-smol/commit/73e67d119a84d697773eaecb4865c6a71eb1a9cb) Thanks @tim-smart! - Ensure ClusterWorkflowEngine routes durable clock wakeups and registered workflow deferred completions through the owning workflow's shard group.

- [#2286](https://github.com/Effect-TS/effect-smol/pull/2286) [`01d71ec`](https://github.com/Effect-TS/effect-smol/commit/01d71ec5a75f3c2747a8d3b1ad9701d1e27b7ce5) Thanks @tim-smart! - Add default value support to `Prompt.file`.

- [#2285](https://github.com/Effect-TS/effect-smol/pull/2285) [`fcd707e`](https://github.com/Effect-TS/effect-smol/commit/fcd707e091a16e1b35343c901cc4052274e32239) Thanks @tim-smart! - Add default value support to CLI integer prompts.

## 4.0.0-beta.71

### Patch Changes

- [#2252](https://github.com/Effect-TS/effect-smol/pull/2252) [`d8ac76b`](https://github.com/Effect-TS/effect-smol/commit/d8ac76b5bad458c42cebe8a0c1b3843f955ac293) Thanks @tim-smart! - Added `Schedule.tap`, which allows observing full schedule metadata without altering schedule inputs or outputs.

- [#2261](https://github.com/Effect-TS/effect-smol/pull/2261) [`2c3c00a`](https://github.com/Effect-TS/effect-smol/commit/2c3c00af6faba7b7d422af26a7a2bbc35636d230) Thanks @gcanti! - Add JSON Schema custom annotation passthrough option, closes [#2260](https://github.com/Effect-TS/effect-smol/issues/2260)

- [#2269](https://github.com/Effect-TS/effect-smol/pull/2269) [`3751e7c`](https://github.com/Effect-TS/effect-smol/commit/3751e7cf353e7a54cd692c37401207d9afba1e63) Thanks @gcanti! - Schema: reintroduce `.value` on `Schema.Array` and `Schema.NonEmptyArray` for consistency with other collection wrappers (`Chunk`, `HashSet`, etc.), closes [#2268](https://github.com/Effect-TS/effect-smol/issues/2268).

- [#2272](https://github.com/Effect-TS/effect-smol/pull/2272) [`fc5f25b`](https://github.com/Effect-TS/effect-smol/commit/fc5f25b03ada5fc2431987768a74d3d3e75ca485) Thanks @gcanti! - Clarify that `Data.$is(tag)` only checks the `_tag` field, not the full structure, closes [#2271](https://github.com/Effect-TS/effect-smol/issues/2271).

- [#2257](https://github.com/Effect-TS/effect-smol/pull/2257) [`7ccced4`](https://github.com/Effect-TS/effect-smol/commit/7ccced42867c14c013b01160b3d292f14c05bd04) Thanks @bwbuchanan! - Fixed the `catch*` combinators silently dropping unhandled error types

- [#2263](https://github.com/Effect-TS/effect-smol/pull/2263) [`a2e1fe5`](https://github.com/Effect-TS/effect-smol/commit/a2e1fe5835c98c8ee4393a091b1d11b75126e349) Thanks @patroza! - Use `WeakMap` for `pendingBatches` instead of `Map`, to allow GC to collect resolvers

- [#2266](https://github.com/Effect-TS/effect-smol/pull/2266) [`4a4a36b`](https://github.com/Effect-TS/effect-smol/commit/4a4a36b10e6e616cad07584a43908f6a7e07e618) Thanks @gcanti! - Fix schema arbitrary constraints for exclusive BigInt, Date, and integer number bounds.

- [#2249](https://github.com/Effect-TS/effect-smol/pull/2249) [`d350292`](https://github.com/Effect-TS/effect-smol/commit/d3502922b4740fa9d745797cbc3775cb67839b6d) Thanks @tim-smart! - allow encoding Redacted by default, and add option to disallow encoding

- [#2276](https://github.com/Effect-TS/effect-smol/pull/2276) [`730afb6`](https://github.com/Effect-TS/effect-smol/commit/730afb66696adf9bd5a328cbca29df9c05968771) Thanks @tim-smart! - Fix AtomRef notifications when a listener re-subscribes itself during notification.

- [#2250](https://github.com/Effect-TS/effect-smol/pull/2250) [`df1b008`](https://github.com/Effect-TS/effect-smol/commit/df1b008f370f414c2a67a7b8139ef747af8e5fba) Thanks @tim-smart! - Fix `Argument.variadic(argument)` so it supports direct calls without options.

- [#2277](https://github.com/Effect-TS/effect-smol/pull/2277) [`6d469d5`](https://github.com/Effect-TS/effect-smol/commit/6d469d567a7c41d7e5343bdee21d45b07b0e8190) Thanks @tim-smart! - Fix string messages and annotations being double-quoted by simple and logfmt loggers.

## 4.0.0-beta.70

### Patch Changes

- [#2228](https://github.com/Effect-TS/effect-smol/pull/2228) [`af7782d`](https://github.com/Effect-TS/effect-smol/commit/af7782d3008d08b043f3a3f261516001514b2b4e) Thanks @avallete! - Add `Command.withHidden` to hide subcommands from `--help` output, shell completions, and "did you mean?" suggestions, while keeping them fully invocable by exact name.

  Useful for experimental or internal subcommands that should be accepted but not advertised on the public CLI surface.

  ```ts
  import { Command } from "effect/unstable/cli";

  const experimental = Command.make("experimental").pipe(Command.withHidden);

  const root = Command.make("mycli").pipe(
    Command.withSubcommands([experimental]),
  );
  ```

- [#2244](https://github.com/Effect-TS/effect-smol/pull/2244) [`7212d70`](https://github.com/Effect-TS/effect-smol/commit/7212d701a3eee7b3553ff502e2c066126e52e839) Thanks @tim-smart! - Fix TestClock adjustment when its layer is provided to programs run without an ambient Scope.

## 4.0.0-beta.69

### Patch Changes

- [#2227](https://github.com/Effect-TS/effect-smol/pull/2227) [`70ea04a`](https://github.com/Effect-TS/effect-smol/commit/70ea04aa96a2a7859d738d414e1f0e3ed081a27a) Thanks @avallete! - Add `Flag.withHidden` (and `Param.withHidden`) to hide flags from `--help` output and shell completions while keeping them fully parseable on the command line.

  Useful for experimental, internal, or deprecated flags that should be accepted but not advertised, e.g. `--experimental-foo`, debug toggles, or escape hatches that are not yet committed to the public CLI surface.

  ```ts
  import { Flag } from "effect/unstable/cli";

  const experimental = Flag.boolean("experimental-foo").pipe(Flag.withHidden);
  ```

- [#2240](https://github.com/Effect-TS/effect-smol/pull/2240) [`d0ea8b0`](https://github.com/Effect-TS/effect-smol/commit/d0ea8b03f7d73ae076c1db12666141e480d11178) Thanks @tim-smart! - pass workflow parent on discard

- [#2237](https://github.com/Effect-TS/effect-smol/pull/2237) [`a57674b`](https://github.com/Effect-TS/effect-smol/commit/a57674b64845e9e75a456cf907bfdcb858859118) Thanks @notkadez! - Fix `Stream.scoped` and `Channel.scoped` so pull effects run with the scoped resource scope.

- [#2239](https://github.com/Effect-TS/effect-smol/pull/2239) [`59aa334`](https://github.com/Effect-TS/effect-smol/commit/59aa334fbd0a504dda3c36f6d2ef1be7449b4b8b) Thanks @tim-smart! - fix RpcWorker Protocol service key

- [#2242](https://github.com/Effect-TS/effect-smol/pull/2242) [`8f4208e`](https://github.com/Effect-TS/effect-smol/commit/8f4208ee83bc7bdaa6793b5429847b45aab72470) Thanks @tim-smart! - Accept `.mjs` and `.mts` migration files in SQL migrator loaders.

## 4.0.0-beta.68

### Patch Changes

- [#2210](https://github.com/Effect-TS/effect-smol/pull/2210) [`af8267f`](https://github.com/Effect-TS/effect-smol/commit/af8267f2f3588c3fb611e9286f6f933f29ce1217) Thanks @tim-smart! - Add Stream.broadcastN for fixed-size stream broadcasts.

- [#2180](https://github.com/Effect-TS/effect-smol/pull/2180) [`0176eaf`](https://github.com/Effect-TS/effect-smol/commit/0176eaf3ecd7c1b99a10268f2af02d7e8ce161e5) Thanks @IMax153! - update Model uuid helpers

- [#2180](https://github.com/Effect-TS/effect-smol/pull/2180) [`0176eaf`](https://github.com/Effect-TS/effect-smol/commit/0176eaf3ecd7c1b99a10268f2af02d7e8ce161e5) Thanks @IMax153! - Add a platform-agnostic `Crypto` service for cryptographic random bytes, secure random generators, UUIDv4 / UUIDv7 generation, and digest operations. UUID generation should now use the `Crypto` service's `randomUUIDv4` or `randomUUIDv7`, which format bytes from the platform `Crypto` service; UUIDv7 also uses the `Clock` service timestamp. `Random.nextUUIDv4` has been removed because the base `Random` service is not cryptographically secure.

- [#2221](https://github.com/Effect-TS/effect-smol/pull/2221) [`f136bb7`](https://github.com/Effect-TS/effect-smol/commit/f136bb763048cbc6b17edd26496dba3e2415b9fa) Thanks @gcanti! - Change `Schema.asserts` and `SchemaParser.asserts` to assert a value directly with `asserts(schema, input)` and remove `Schema.Codec.ToAsserts`.

- [#2209](https://github.com/Effect-TS/effect-smol/pull/2209) [`6f38f07`](https://github.com/Effect-TS/effect-smol/commit/6f38f07d5941a211b251383aaab0f4f55e8a6557) Thanks @tim-smart! - Fix Channel.decodeText corrupting UTF-8 characters split across chunk boundaries.

- [#2207](https://github.com/Effect-TS/effect-smol/pull/2207) [`aec9c40`](https://github.com/Effect-TS/effect-smol/commit/aec9c401a53db227f18bf5e0c84db7130ad862d6) Thanks @tim-smart! - rename Model.Generated to Model.GeneratedByDb

## 4.0.0-beta.67

### Patch Changes

- [#2185](https://github.com/Effect-TS/effect-smol/pull/2185) [`a42ef66`](https://github.com/Effect-TS/effect-smol/commit/a42ef6632abbddfa820995ae310ccc84ae8d9b6f) Thanks @lloydrichards! - add rows to Terminal

- [#2111](https://github.com/Effect-TS/effect-smol/pull/2111) [`35594f8`](https://github.com/Effect-TS/effect-smol/commit/35594f811cafe471acd490114b103a1f8392c8d8) Thanks @thiagofelix! - Fix `EntityProxyServer.layerHttpApi` using `path.entityId` instead of `params.entityId`

- [#2201](https://github.com/Effect-TS/effect-smol/pull/2201) [`8bddd62`](https://github.com/Effect-TS/effect-smol/commit/8bddd628cb623f9533d345082583ff51cead6836) Thanks @sjh9714! - Fix `MutableList.filter` and `MutableList.remove` length updates.

- [#2181](https://github.com/Effect-TS/effect-smol/pull/2181) [`4be4c8d`](https://github.com/Effect-TS/effect-smol/commit/4be4c8d60862aa963869ee2ed9ffa048ffac0527) Thanks @zeyuri! - Fix workflow proxy RPC handlers to provide the context expected by RpcServer.

- [#2177](https://github.com/Effect-TS/effect-smol/pull/2177) [`0c9d3ab`](https://github.com/Effect-TS/effect-smol/commit/0c9d3ab43eb721a370ed8306260cbac218c27e87) Thanks @mikearnaldi! - Add forked memo maps so nested layer scopes can reuse parent allocations without leaking sibling-local layers. Update `@effect/vitest` to fork memo maps for nested `it.layer` suites, isolating sibling setup while preserving parent sharing.

- [#2206](https://github.com/Effect-TS/effect-smol/pull/2206) [`b156acc`](https://github.com/Effect-TS/effect-smol/commit/b156accd2691b4a051f823affdece7c39923ce85) Thanks @tim-smart! - add `availableShardGroups` to ShardingConfig, to ensure advisory locks do not conflict

- [#2184](https://github.com/Effect-TS/effect-smol/pull/2184) [`d16c034`](https://github.com/Effect-TS/effect-smol/commit/d16c03434ee3e6dcd3bfc82b65d99e881d89025b) Thanks @gcanti! - Restore support for passing schema parse options when creating decode and encode helpers, closes [#2174](https://github.com/Effect-TS/effect-smol/issues/2174).

- [#2176](https://github.com/Effect-TS/effect-smol/pull/2176) [`b559d68`](https://github.com/Effect-TS/effect-smol/commit/b559d68845f848a10153395778f035682d399075) Thanks @patroza! - Allow Schema decoding defaults to require Effect services.

  The `Effect` passed to `Schema.withDecodingDefault`, `Schema.withDecodingDefaultKey`, `Schema.withDecodingDefaultType`, and `Schema.withDecodingDefaultTypeKey` now accepts a context `R` in its third type parameter. The required services are propagated into the resulting schema's `DecodingServices`. `SchemaGetter.withDefault` is widened in the same way.

- [#2113](https://github.com/Effect-TS/effect-smol/pull/2113) [`a3de5d9`](https://github.com/Effect-TS/effect-smol/commit/a3de5d9215e5cc4a62e2666efbd7c1bf595eb84f) Thanks @patroza! - Allow Schema constructor and decoding defaults to fail with `SchemaError`.

  The `Effect` passed to `Schema.withConstructorDefault`, `Schema.withDecodingDefault`, `Schema.withDecodingDefaultKey`, `Schema.withDecodingDefaultType`, and `Schema.withDecodingDefaultTypeKey` now accepts `SchemaError` in its error channel. When a default fails, the parser unwraps the underlying `SchemaIssue.Issue` and propagates it as a parse failure with the surrounding path attached. This makes it easy to use another schema's `makeEffect` / `decode*` as the default value.

- [#2172](https://github.com/Effect-TS/effect-smol/pull/2172) [`7e6c12e`](https://github.com/Effect-TS/effect-smol/commit/7e6c12ec9b3a5945f6c26e272cc8f6390541ad3e) Thanks @gcanti! - Rename `SchemaParser.makeUnsafe` to `SchemaParser.make`.

- [#2167](https://github.com/Effect-TS/effect-smol/pull/2167) [`098167a`](https://github.com/Effect-TS/effect-smol/commit/098167a220fe07da6f14455818733ab1b269c9dd) Thanks @tim-smart! - update dependencies

## 4.0.0-beta.66

### Patch Changes

- [#2163](https://github.com/Effect-TS/effect-smol/pull/2163) [`ca2498e`](https://github.com/Effect-TS/effect-smol/commit/ca2498e702ac2d83fb7187707b7eb069bdb261a2) Thanks @tim-smart! - remove Effect.Yieldable

- [#2161](https://github.com/Effect-TS/effect-smol/pull/2161) [`cd7d1fb`](https://github.com/Effect-TS/effect-smol/commit/cd7d1fba7e2e2c5ac3ad64e1be433440a5bda436) Thanks @wking-io! - Fix request ID tracking in the RPC server HTTP protocol finalizer.

- [#2158](https://github.com/Effect-TS/effect-smol/pull/2158) [`19a7033`](https://github.com/Effect-TS/effect-smol/commit/19a703367ec817cffc41d152da9b594827408e2b) Thanks @ColaFanta! - Change `Type_<>` implementation, from using `Exclude<F, O | M>` type util to `keyof F as xx`, this implementation keeps IDE provenance link. This enables clicking "Go to definition (F12)" in VSCode on an object made from Schema Struct jumps to the correct Struct field definition.

- [#2153](https://github.com/Effect-TS/effect-smol/pull/2153) [`33d26b4`](https://github.com/Effect-TS/effect-smol/commit/33d26b4210b2e974f146a71e7eed962f8ce00900) Thanks @Gabrola! - Allow `HttpApiTest.groups` to accept an optional `baseUrl` override while preserving the existing default of `"http://localhost:3000"`.

- [#2160](https://github.com/Effect-TS/effect-smol/pull/2160) [`856766b`](https://github.com/Effect-TS/effect-smol/commit/856766b2c506aaed6d2df1d63bf3a5b1b062e1d4) Thanks @tim-smart! - Remove the auto-incrementing suffix from HTTP server logger log span names.

- [#2164](https://github.com/Effect-TS/effect-smol/pull/2164) [`079c7df`](https://github.com/Effect-TS/effect-smol/commit/079c7df82559bb9ce10a86dffb85d25e6ce07dc3) Thanks @tim-smart! - Add the unstable workflow DurableQueue module.

## 4.0.0-beta.65

### Patch Changes

- [#2148](https://github.com/Effect-TS/effect-smol/pull/2148) [`6f11454`](https://github.com/Effect-TS/effect-smol/commit/6f11454a9b6c3bd00f6b35fd7af14a2f2d63a0a2) Thanks @tim-smart! - Add `UniqueViolation` as a new SQL error reason. Supported unique constraint violations now classify as `UniqueViolation` instead of the broader `ConstraintError` reason.

  This covers PostgreSQL, PGlite, MySQL, MSSQL, and the shared SQLite classification used by the SQLite-family clients. `UniqueViolation.constraint` contains the best available constraint, index, or key identifier and falls back to exactly `"unknown"` when no reliable identifier is available.

## 4.0.0-beta.64

### Patch Changes

- [#2137](https://github.com/Effect-TS/effect-smol/pull/2137) [`7d4877a`](https://github.com/Effect-TS/effect-smol/commit/7d4877a1929cdb690280ea254326c04f2ec97ea5) Thanks @tim-smart! - Add optional soft delete column support to SqlModel repositories and resolvers.

## 4.0.0-beta.63

### Patch Changes

- [#2136](https://github.com/Effect-TS/effect-smol/pull/2136) [`7f927ff`](https://github.com/Effect-TS/effect-smol/commit/7f927ffb7a9801dcfc4096c29e369d13d65cd0ac) Thanks @tim-smart! - add HttpApiTest module

- [#2123](https://github.com/Effect-TS/effect-smol/pull/2123) [`a696b3e`](https://github.com/Effect-TS/effect-smol/commit/a696b3e83a8504cdbe261a18c10a1cc0619ae102) Thanks @lewxdev! - add `Effect.acquireDisposable`

## 4.0.0-beta.62

### Patch Changes

- [#2131](https://github.com/Effect-TS/effect-smol/pull/2131) [`4ab4b90`](https://github.com/Effect-TS/effect-smol/commit/4ab4b9007dc27a52ffabc6fcb37c96eeec795bf7) Thanks @tim-smart! - Allow Kubernetes pod condition `lastTransitionTime` values to be null in K8sHttpClient schemas.

## 4.0.0-beta.61

### Patch Changes

- [#2130](https://github.com/Effect-TS/effect-smol/pull/2130) [`50790af`](https://github.com/Effect-TS/effect-smol/commit/50790af9b190c38d10fb0723837d49b66432638f) Thanks @tim-smart! - Record fiber runtime start metrics when fibers are constructed so yielded fibers are only counted once.

- [#2120](https://github.com/Effect-TS/effect-smol/pull/2120) [`71f7c3d`](https://github.com/Effect-TS/effect-smol/commit/71f7c3df997deda92c84146d569696dab3bd645c) Thanks @tim-smart! - Port `Effect.firstSuccessOf` from Effect v3.

- [#2122](https://github.com/Effect-TS/effect-smol/pull/2122) [`aae8797`](https://github.com/Effect-TS/effect-smol/commit/aae8797b9cb383be0c182dd58d03d787c354238b) Thanks @tim-smart! - fix empty body decoding in HttpApiBuilder

## 4.0.0-beta.60

### Patch Changes

- [#2115](https://github.com/Effect-TS/effect-smol/pull/2115) [`f69d567`](https://github.com/Effect-TS/effect-smol/commit/f69d5675dcff9f4137295752baf066b7153fdc09) Thanks @tim-smart! - add Rpc.custom

- [#2119](https://github.com/Effect-TS/effect-smol/pull/2119) [`7909c95`](https://github.com/Effect-TS/effect-smol/commit/7909c954b8f6244a35a4b429f8dd0dff45dad620) Thanks @gcanti! - Remove `Inspectable.stringifyCircular` and fix `Formatter.formatJson` so shared object references are preserved while only circular references are omitted.

- [`bbb4dcc`](https://github.com/Effect-TS/effect-smol/commit/bbb4dcc6c406b83a416b4ad3541cc02037c420e4) Thanks @tim-smart! - allow using Duration.Input with accessors

- [#2117](https://github.com/Effect-TS/effect-smol/pull/2117) [`7af2207`](https://github.com/Effect-TS/effect-smol/commit/7af2207901eabf3132c1b7010a69b3899c06fbbe) Thanks @gcanti! - Add `Schema.DurationFromString` and `SchemaTransformation.durationFromString`, support `"Infinity"` and `"-Infinity"` in `Duration.fromInput`, and simplify config duration parsing around the shared schema codec, closes [#2092](https://github.com/Effect-TS/effect-smol/issues/2092).

- [#2116](https://github.com/Effect-TS/effect-smol/pull/2116) [`848b40a`](https://github.com/Effect-TS/effect-smol/commit/848b40a4bd4bf54a5098617d50c33c88eee8270a) Thanks @gcanti! - Add a `Config.literals` convenience constructor for `Schema.Literals`, closes [#2091](https://github.com/Effect-TS/effect-smol/issues/2091).

## 4.0.0-beta.59

### Patch Changes

- [#2106](https://github.com/Effect-TS/effect-smol/pull/2106) [`56837ea`](https://github.com/Effect-TS/effect-smol/commit/56837ea2a338395b35550641374e9e589bd8b71d) Thanks @IMax153! - Fix entity proxy RPC handlers to provide the context expected by RpcServer.

## 4.0.0-beta.58

### Patch Changes

- [#2097](https://github.com/Effect-TS/effect-smol/pull/2097) [`11993d4`](https://github.com/Effect-TS/effect-smol/commit/11993d4934c66f5dc611b8bbf553f01d501ef8f7) Thanks @Leka74! - Add an exhaustive finalizer to the AsyncResult builder.

- [#2098](https://github.com/Effect-TS/effect-smol/pull/2098) [`96c8b22`](https://github.com/Effect-TS/effect-smol/commit/96c8b22c2057ccddbf10ed269d7697f22119b3ec) Thanks @tim-smart! - generate binary arrays from streams with less copying

- [#2098](https://github.com/Effect-TS/effect-smol/pull/2098) [`96c8b22`](https://github.com/Effect-TS/effect-smol/commit/96c8b22c2057ccddbf10ed269d7697f22119b3ec) Thanks @tim-smart! - improve http body consumption

## 4.0.0-beta.57

### Patch Changes

- [#2085](https://github.com/Effect-TS/effect-smol/pull/2085) [`a971f5c`](https://github.com/Effect-TS/effect-smol/commit/a971f5cbd92dfe4274420bf0966595eb35531060) Thanks @tim-smart! - add Effect.abortSignal

- [#2088](https://github.com/Effect-TS/effect-smol/pull/2088) [`8e110c5`](https://github.com/Effect-TS/effect-smol/commit/8e110c5f02a429ccc43a91df8678e402138c0851) Thanks @tim-smart! - ensure each sql client gets a unique transaction service

## 4.0.0-beta.56

## 4.0.0-beta.55

### Patch Changes

- [#2081](https://github.com/Effect-TS/effect-smol/pull/2081) [`42cc744`](https://github.com/Effect-TS/effect-smol/commit/42cc744570968deb365fb46d47b53d3277050c93) Thanks @gcanti! - Export the `Schema.encodeKeys` interface, closes [#2070](https://github.com/Effect-TS/effect-smol/issues/2070).

  Previously the interface was internal, so exporting a value whose inferred type referenced it triggered TypeScript error `TS4023: Exported variable has or is using name 'encodeKeys' from external module ... but cannot be named`, e.g.:

- [#2067](https://github.com/Effect-TS/effect-smol/pull/2067) [`04855ce`](https://github.com/Effect-TS/effect-smol/commit/04855ceeca4d40c55a5750dd9893b691f8ea741a) Thanks @mrazauskas! - fix `isNullish()` type predicate

## 4.0.0-beta.54

### Patch Changes

- [#2078](https://github.com/Effect-TS/effect-smol/pull/2078) [`e4b74f9`](https://github.com/Effect-TS/effect-smol/commit/e4b74f9c01a0e9b6cd58416de4af3a26d51da7c8) Thanks @tim-smart! - add Socket.make

- [#2075](https://github.com/Effect-TS/effect-smol/pull/2075) [`4c72808`](https://github.com/Effect-TS/effect-smol/commit/4c728081851c66dacf889a816535671bc841ae96) Thanks @tim-smart! - ensure workflow failures are not squashed by suspension interrupts

## 4.0.0-beta.53

### Patch Changes

- [#2068](https://github.com/Effect-TS/effect-smol/pull/2068) [`0768509`](https://github.com/Effect-TS/effect-smol/commit/07685094e931af07d104165195826a535b55fa7e) Thanks @tim-smart! - Fix `AtomHttpApi` query and mutation error inference to include endpoint middleware and client middleware errors, matching `HttpApiClient` behavior (including response-only mutation mode).

- [#2062](https://github.com/Effect-TS/effect-smol/pull/2062) [`476aede`](https://github.com/Effect-TS/effect-smol/commit/476aede69c6efa06b5781ca5eb3e3b128ca29141) Thanks @aldotestino! - Fix `HttpIncomingMessage.schemaBodyJson` to forward parse options via the `parseOptions` annotation key.

- [#2074](https://github.com/Effect-TS/effect-smol/pull/2074) [`4f79c54`](https://github.com/Effect-TS/effect-smol/commit/4f79c542e7b508c235ff485d862cc8b29a8260c5) Thanks @tim-smart! - fix Latch.release

- [#2069](https://github.com/Effect-TS/effect-smol/pull/2069) [`4be6a7c`](https://github.com/Effect-TS/effect-smol/commit/4be6a7cf35dab2a01d652f56dd35f0358c5a7e88) Thanks @mikearnaldi! - Fix `TestClock.currentTimeNanosUnsafe()` to floor fractional millisecond instants before converting them to `BigInt`.

- [#2065](https://github.com/Effect-TS/effect-smol/pull/2065) [`88927eb`](https://github.com/Effect-TS/effect-smol/commit/88927ebb896162cdba103b36553280b58e0facac) Thanks @tim-smart! - add Effectable module

## 4.0.0-beta.52

### Patch Changes

- [#2057](https://github.com/Effect-TS/effect-smol/pull/2057) [`8e04bfc`](https://github.com/Effect-TS/effect-smol/commit/8e04bfc95554b74eac205d67a20388e056b21499) Thanks @tim-smart! - add HttpApiSchemaError for determining where a schema error originates from

- [#2055](https://github.com/Effect-TS/effect-smol/pull/2055) [`cf3a311`](https://github.com/Effect-TS/effect-smol/commit/cf3a311d863a8abb818840c3b80f847e621c43c1) Thanks @tim-smart! - ensure tagged enum \_tag is correctly set

- [#2057](https://github.com/Effect-TS/effect-smol/pull/2057) [`8e04bfc`](https://github.com/Effect-TS/effect-smol/commit/8e04bfc95554b74eac205d67a20388e056b21499) Thanks @tim-smart! - make HttpApi schema errors defects unless transformed

- [#2058](https://github.com/Effect-TS/effect-smol/pull/2058) [`131fdd5`](https://github.com/Effect-TS/effect-smol/commit/131fdd5b1f26531e265fe1a08f002002f47c276e) Thanks @tim-smart! - mcp http request with no session header is 404 response

## 4.0.0-beta.51

### Patch Changes

- [#2049](https://github.com/Effect-TS/effect-smol/pull/2049) [`778d2af`](https://github.com/Effect-TS/effect-smol/commit/778d2afe9b5154bc1f9abae46d93ea7e54c87344) Thanks @bohdanbirdie! - Add `RpcSerialization.makeMsgPack` for creating MessagePack serialization with custom msgpackr options. On Cloudflare Workers with `allow_eval_during_startup` (default for `compatibility_date >= 2025-06-01`), pass `{ useRecords: false }` to prevent msgpackr's JIT code generation via `new Function()`, which is blocked during request handling. Also fixes silent error swallowing in the `msgPack` decode path — non-incomplete errors are now rethrown instead of returning `[]`.

- [#2010](https://github.com/Effect-TS/effect-smol/pull/2010) [`4e24dcf`](https://github.com/Effect-TS/effect-smol/commit/4e24dcf75037f65eebc1eb68623bc7cbf9d5512a) Thanks @tim-smart! - process schema properties / elements concurrently

- [#2052](https://github.com/Effect-TS/effect-smol/pull/2052) [`4b1c015`](https://github.com/Effect-TS/effect-smol/commit/4b1c0150e9bdb5559ed32d250deb66e17b4240c7) Thanks @gcanti! - Schema: expand `FilterOutput` and add `FilterIssue` for richer filter failures.

  The return type of a `Schema.makeFilter` predicate now supports two additional shapes:
  - `{ path, issue }` where `issue` is `string | SchemaIssue.Issue` (previously only `{ path, message: string }` was accepted). The `issue` arm lets you attach a fully-formed `Issue` at a nested path without manually constructing a `Pointer`.
  - `ReadonlyArray<Schema.FilterIssue>` to report several failures at once. An empty array is success, a single-element array is equivalent to returning that element, and multi-entry arrays are grouped into an `Issue.Composite`. This removes the need to import `SchemaIssue` and hand-build a `Composite` for multi-field validators.

  The single-failure shapes (`undefined`, `true`, `false`, `string`, `SchemaIssue.Issue`) are unchanged.

  **Breaking**: the object shape renamed from `{ path, message }` to `{ path, issue }`. Call sites that used the old shape must rename the field; the migration is mechanical.

  ```ts
  // before
  Schema.makeFilter((o) => ({ path: ["a"], message: "bad" }));

  // after
  Schema.makeFilter((o) => ({ path: ["a"], issue: "bad" }));
  ```

  Also renamed `{ path, message }` to `{ path, issue }` in the accepted return type of `SchemaGetter.checkEffect`.

- [#2047](https://github.com/Effect-TS/effect-smol/pull/2047) [`454f8ad`](https://github.com/Effect-TS/effect-smol/commit/454f8adad822929c3ef60f8280d0987226b049fd) Thanks @gcanti! - Fix `SchemaAST.isJson` rejecting DAGs as cycles, closes [#2021](https://github.com/Effect-TS/effect-smol/issues/2021).

  The previous implementation marked every visited object in a single `seen` set and never removed it, so any value that referenced the same object through two different paths (a DAG, e.g. `{ x: shared, y: shared }`) was treated as a cycle and returned `false`. Cycle detection now tracks only the current recursion path (popping on exit) and memoizes fully validated subtrees, so DAGs are accepted while true cycles are still rejected.

- [#2051](https://github.com/Effect-TS/effect-smol/pull/2051) [`6754a0c`](https://github.com/Effect-TS/effect-smol/commit/6754a0cd18626b06805a079cc5265525a5eb7d27) Thanks @tim-smart! - disable sql traces for EventLog, RunnerStorage

- [#2053](https://github.com/Effect-TS/effect-smol/pull/2053) [`90f7fd5`](https://github.com/Effect-TS/effect-smol/commit/90f7fd5243871b30980964135db4512b8119fa82) Thanks @tim-smart! - remove use of bigint literals

- [#2046](https://github.com/Effect-TS/effect-smol/pull/2046) [`d7e1519`](https://github.com/Effect-TS/effect-smol/commit/d7e151974934201fd93fa4c8a1192ee9a5d965a0) Thanks @gcanti! - Remove the `options` parameter from `OpenApi.fromApi`.

  The parameter only carried `additionalProperties`, but the function caches results in a `WeakMap` keyed solely on the `api` instance. Passing different options across calls for the same api was silently ignored, making the parameter order-dependent and effectively single-shot. No call sites were using it, so the signature is now simply `fromApi(api)`.

- [#2044](https://github.com/Effect-TS/effect-smol/pull/2044) [`72a8122`](https://github.com/Effect-TS/effect-smol/commit/72a81228e09782bae512f7d041bbfbc78bc668d0) Thanks @tim-smart! - ensure envelope payloads are correctly encoded for notify path

## 4.0.0-beta.50

### Patch Changes

- [#2038](https://github.com/Effect-TS/effect-smol/pull/2038) [`07be594`](https://github.com/Effect-TS/effect-smol/commit/07be594825de60f8e1b2102d21dbb9b8fc63b414) Thanks @tim-smart! - add support for deferred responses in rpc

- [#2040](https://github.com/Effect-TS/effect-smol/pull/2040) [`ae02433`](https://github.com/Effect-TS/effect-smol/commit/ae02433103ce28f53a0c9bfb4a44e75773289b7b) Thanks @tim-smart! - require a option to make AtomRpc.query atoms serializatable

## 4.0.0-beta.49

### Patch Changes

- [#2035](https://github.com/Effect-TS/effect-smol/pull/2035) [`7d87873`](https://github.com/Effect-TS/effect-smol/commit/7d8787340ff549370f6f2a88b612e9ebbfd6ba45) Thanks @tim-smart! - Add support for common HTTP status string literals in `HttpApiSchema.status` (for example, `HttpApiSchema.status("Created")` resolves to status code `201`).

- [#2036](https://github.com/Effect-TS/effect-smol/pull/2036) [`c2f6f90`](https://github.com/Effect-TS/effect-smol/commit/c2f6f901b200a6e515b4f02c93ce8005b7bbf1c5) Thanks @tim-smart! - add RpcGroup.omit

- [#2034](https://github.com/Effect-TS/effect-smol/pull/2034) [`216f13c`](https://github.com/Effect-TS/effect-smol/commit/216f13c1fce454a21b489bb915714a17e791a1ac) Thanks @IMax153! - Fix issue with exported CLI `Completions` types

## 4.0.0-beta.48

### Patch Changes

- [#2025](https://github.com/Effect-TS/effect-smol/pull/2025) [`4da56ec`](https://github.com/Effect-TS/effect-smol/commit/4da56ecff129b2da40137ffede23a73cc4e532d8) Thanks @tim-smart! - update dependencies

- [#2029](https://github.com/Effect-TS/effect-smol/pull/2029) [`a5e6f77`](https://github.com/Effect-TS/effect-smol/commit/a5e6f774bab195cf50ecdc818240765f69a3bf4a) Thanks @tim-smart! - omit scope from HttpApi handlers

- [#2023](https://github.com/Effect-TS/effect-smol/pull/2023) [`f1ba5b8`](https://github.com/Effect-TS/effect-smol/commit/f1ba5b8584d325a541156928cecf041b37fd5070) Thanks @tim-smart! - EventLog Identity string encodes to base 64

- [#2023](https://github.com/Effect-TS/effect-smol/pull/2023) [`f1ba5b8`](https://github.com/Effect-TS/effect-smol/commit/f1ba5b8584d325a541156928cecf041b37fd5070) Thanks @tim-smart! - disable tracer propagation for otlp exporter

## 4.0.0-beta.47

### Patch Changes

- [#2017](https://github.com/Effect-TS/effect-smol/pull/2017) [`c584726`](https://github.com/Effect-TS/effect-smol/commit/c58472674e750e6938df955044eab88feda95e45) Thanks @gcanti! - Schema: add `annotateEncoded` function for annotating the encoded side of a schema.

- [#2013](https://github.com/Effect-TS/effect-smol/pull/2013) [`86a91a4`](https://github.com/Effect-TS/effect-smol/commit/86a91a4f0c59286dfa9393232d8020dea70ed4db) Thanks @gcanti! - Schema: add withDecodingDefaultTypeKey / withDecodingDefaultType, closes #2012

- [#2018](https://github.com/Effect-TS/effect-smol/pull/2018) [`131caf9`](https://github.com/Effect-TS/effect-smol/commit/131caf9525151a0cb29803a8f1dffa0f4f479d12) Thanks @gcanti! - Schema: allow `Class` constructors to accept `void` when all fields are optional, closes #2015.

- [#2016](https://github.com/Effect-TS/effect-smol/pull/2016) [`c3615c8`](https://github.com/Effect-TS/effect-smol/commit/c3615c88379b9daf252df0db72c6ac5a20326406) Thanks @gcanti! - Schema: rename `"~rebuild.out"` to `"Rebuild"`

## 4.0.0-beta.46

### Patch Changes

- [#2008](https://github.com/Effect-TS/effect-smol/pull/2008) [`3a30b9e`](https://github.com/Effect-TS/effect-smol/commit/3a30b9e2ec2bd8b8193e1aa139f6878a07e3f5ee) Thanks @tim-smart! - fix eventlog skipping entries

## 4.0.0-beta.45

### Patch Changes

- [#1883](https://github.com/Effect-TS/effect-smol/pull/1883) [`5c3af6d`](https://github.com/Effect-TS/effect-smol/commit/5c3af6d554f60be34f8fc21d598d9a298ae11beb) Thanks @tim-smart! - Add EventLogServerUnencrypted module

## 4.0.0-beta.44

### Patch Changes

- [#1943](https://github.com/Effect-TS/effect-smol/pull/1943) [`e3f0621`](https://github.com/Effect-TS/effect-smol/commit/e3f0621454c3f5d11070d30619da27c9232cadc1) Thanks @gcanti! - Add `DateFromString`, `BigIntFromString`, `BigDecimalFromString`, `TimeZoneNamedFromString`, `TimeZoneFromString`, and `DateTimeZonedFromString` schemas, closes #1941.

- [#1996](https://github.com/Effect-TS/effect-smol/pull/1996) [`5b476ab`](https://github.com/Effect-TS/effect-smol/commit/5b476abc0bd7e9bb59135ea1bcad2e4936227ced) Thanks @gcanti! - Schema: add `StringFromBase64`, `StringFromBase64Url`, `StringFromHex`, and `StringFromUriComponent` schemas for decoding encoded strings into UTF-8 strings, closes #1995.

- [#1952](https://github.com/Effect-TS/effect-smol/pull/1952) [`6b40e5a`](https://github.com/Effect-TS/effect-smol/commit/6b40e5a4a6bd2087c15a3d7374d25057fdedfa16) Thanks @tim-smart! - Effect.repeat now uses effect return value when using options

- [#1961](https://github.com/Effect-TS/effect-smol/pull/1961) [`7bb5dce`](https://github.com/Effect-TS/effect-smol/commit/7bb5dce60e1d904ef049a0287dec2b2e6113c970) Thanks @IMax153! - Rename Atom's `Context` type to `AtomContext`

- [#1975](https://github.com/Effect-TS/effect-smol/pull/1975) [`3b09fb3`](https://github.com/Effect-TS/effect-smol/commit/3b09fb31c40c2802b01f21c23bcdd1fe7fb0aa82) Thanks @tim-smart! - catch defects when building Entity handlers

- [#2000](https://github.com/Effect-TS/effect-smol/pull/2000) [`2370410`](https://github.com/Effect-TS/effect-smol/commit/237041062e5af4594d32db91597e34e70a632877) Thanks @tim-smart! - fix cache constructor inference by moving the lookup option

- [#1928](https://github.com/Effect-TS/effect-smol/pull/1928) [`dabc272`](https://github.com/Effect-TS/effect-smol/commit/dabc272444a700eb629c07ba3e77671a841ca86e) Thanks @tim-smart! - Add `schema.makeEffect(input, options?)` to `Schema.Bottom` and schema-backed classes, matching the existing constructor behavior exposed by `makeUnsafe` / `makeOption` while returning an `Effect` failure with `Schema.SchemaError`.

- [#1949](https://github.com/Effect-TS/effect-smol/pull/1949) [`08b63c3`](https://github.com/Effect-TS/effect-smol/commit/08b63c3df11bd35c9fd6090dbd166287fdc40664) Thanks @tim-smart! - Update the unstable HTTP middleware logger to annotate only the request path in `http.url` instead of including the full URL (query / fragment), and add a regression test.

- [#1962](https://github.com/Effect-TS/effect-smol/pull/1962) [`dfff04c`](https://github.com/Effect-TS/effect-smol/commit/dfff04c4c2b1d352dfad83992a6dce1280c85cf9) Thanks @tim-smart! - Add `KeyValueStore.layerSql` to back key-value storage with a SQL database via `SqlClient`.

- [#1963](https://github.com/Effect-TS/effect-smol/pull/1963) [`9baed9e`](https://github.com/Effect-TS/effect-smol/commit/9baed9e17e84702e6e480fcef6f86404f9e24be9) Thanks @tim-smart! - Fix `Unify.unify` so Layer unions merge correctly, and add type tests covering Layer unification.

- [#2004](https://github.com/Effect-TS/effect-smol/pull/2004) [`7846792`](https://github.com/Effect-TS/effect-smol/commit/7846792adc7e1631d62d26d657bd7ba6139f369b) Thanks @tim-smart! - Fix `Stream.toQueue` types and implementation to return a `Queue.Dequeue` in both overloads and delegate to `Channel.toQueueArray`.

- [#1974](https://github.com/Effect-TS/effect-smol/pull/1974) [`1556a24`](https://github.com/Effect-TS/effect-smol/commit/1556a247623636b7ebe438fb56d77f1a7bf957bb) Thanks @juliusmarminge! - Fix unstable CLI boolean flags so `Flag.optional(Flag.boolean(...))` returns `Option.none()` when omitted, and support canonical `--no-<flag>` negation for boolean flags.

- [#1980](https://github.com/Effect-TS/effect-smol/pull/1980) [`7c11bc2`](https://github.com/Effect-TS/effect-smol/commit/7c11bc292ab8e46252fe8f7576fb685917bfb8b5) Thanks @tim-smart! - fix Entity.keepAlive

- [#1929](https://github.com/Effect-TS/effect-smol/pull/1929) [`b5ea591`](https://github.com/Effect-TS/effect-smol/commit/b5ea5913ec1d45d0dd12a327b9dd966bda2f6d02) Thanks @gcanti! - Simplify and align the default-value APIs.

  `Schema.withConstructorDefault` now accepts an `Effect<T>` instead of `(o: Option<undefined>) => Option<T> | Effect<Option<T>>`.

  `Schema.withDecodingDefault` / `Schema.withDecodingDefaultKey` now accept an `Effect<T>` instead of `() => T`, enabling effectful defaults.

  `SchemaGetter.withDefault` follows the same change, accepting `Effect<T>` instead of `() => T`.

- [#1966](https://github.com/Effect-TS/effect-smol/pull/1966) [`0853afa`](https://github.com/Effect-TS/effect-smol/commit/0853afaeb1633b2d7f8b66893bd01c3aa1ef2c22) Thanks @gcanti! - Reuse existing references when duplicate identifiers have the same representation, closes #1927.

- [#1942](https://github.com/Effect-TS/effect-smol/pull/1942) [`ac845f3`](https://github.com/Effect-TS/effect-smol/commit/ac845f3ab40e0b8719576e7f9bc16ea2e0e02cd4) Thanks @gcanti! - Fix `ErrorClass` and `TaggedErrorClass` `toString` to match native `Error` output format (e.g. `E: my message` instead of `E({"message":"my message"})`), closes #1940.

  Also fix prototype properties (e.g. `name`) being lost after `.extend()`.

- [#1956](https://github.com/Effect-TS/effect-smol/pull/1956) [`b80c462`](https://github.com/Effect-TS/effect-smol/commit/b80c46247480f47bb64fc480fab48a3f37bc8888) Thanks @gcanti! - Add `Schema.resolveAnnotationsKey` API to retrieve the context (key-level) annotations from a schema, closes #1947.

  Also rename `Schema.resolveInto` to `Schema.resolveAnnotations`.

- [#2005](https://github.com/Effect-TS/effect-smol/pull/2005) [`b3f535d`](https://github.com/Effect-TS/effect-smol/commit/b3f535d9a7ac13b5fb984c29f93561c57a081ff0) Thanks @gcanti! - Fix `Stream.splitLines` to correctly handle standalone `\r` as a line terminator and flush the final unterminated line when the stream ends, closes #2002.

- [#1936](https://github.com/Effect-TS/effect-smol/pull/1936) [`6fe2e93`](https://github.com/Effect-TS/effect-smol/commit/6fe2e93cc2f1b173ef89651d74b6a5d2626b3226) Thanks @IMax153! - Fix `Stream.groupedWithin` dropping partial batches when the upstream ends or goes idle.

- [#1981](https://github.com/Effect-TS/effect-smol/pull/1981) [`cda8004`](https://github.com/Effect-TS/effect-smol/commit/cda800451c1ffbdddfc08415aed7b2d91e0412ee) Thanks @tim-smart! - add rpc ConnectionHooks

- [#1965](https://github.com/Effect-TS/effect-smol/pull/1965) [`8335477`](https://github.com/Effect-TS/effect-smol/commit/8335477a8a936a24b5f3ee6203c1b268bd1bfc3c) Thanks @tim-smart! - return resolvers directly from SqlModel.makeResolvers

- [#1960](https://github.com/Effect-TS/effect-smol/pull/1960) [`8c836f9`](https://github.com/Effect-TS/effect-smol/commit/8c836f99ab1e896b9580a71d67773625baff2eaf) Thanks @IMax153! - Add `ChildProcessHandle.unref`, returning an `Effect` that restores the child process reference when run.

- [#1984](https://github.com/Effect-TS/effect-smol/pull/1984) [`718ff6f`](https://github.com/Effect-TS/effect-smol/commit/718ff6fe3e3d3820cefd67d2bff1b2224fe08060) Thanks @jannabiforever! - Make `Effect.retry` with `times` argument to propagate the original error.

- [#1930](https://github.com/Effect-TS/effect-smol/pull/1930) [`7eed84f`](https://github.com/Effect-TS/effect-smol/commit/7eed84fc33c5781a6fb11bf4fd189d424902ebd4) Thanks @mikearnaldi! - Add `Stream.service` and `Stream.serviceOption` for accessing services as single-element streams.

- [#1935](https://github.com/Effect-TS/effect-smol/pull/1935) [`5df46fe`](https://github.com/Effect-TS/effect-smol/commit/5df46fe2f654d59ab5fc1578f4fc27fa40368ef9) Thanks @gcanti! - Schema: add `asClass` API to turn any schema into a class with static method support.

  **Example**

  ```ts
  import { Schema } from "effect";

  class MyString extends Schema.asClass(Schema.String) {
    static readonly decodeUnknownSync = Schema.decodeUnknownSync(this);
  }

  MyString.decodeUnknownSync("a"); // "a"
  ```

- [#1958](https://github.com/Effect-TS/effect-smol/pull/1958) [`82dd0f2`](https://github.com/Effect-TS/effect-smol/commit/82dd0f26c6442b07143762ef7bc33742d3978dd6) Thanks @gcanti! - Schema: add `MissingSelfGeneric` compile-time error for `Class`, `TaggedClass`, `ErrorClass`, and `TaggedErrorClass` when the `Self` type parameter is omitted.

- [#1957](https://github.com/Effect-TS/effect-smol/pull/1957) [`03ae41e`](https://github.com/Effect-TS/effect-smol/commit/03ae41e7304cffac9f18feea22b73468feafc43a) Thanks @gcanti! - Schema: remove `"~annotate.in"` type from `Bottom` interface, inlining it where needed

- [#1951](https://github.com/Effect-TS/effect-smol/pull/1951) [`4677a0a`](https://github.com/Effect-TS/effect-smol/commit/4677a0a58f95eea38a211efcd3f345f237a9e44a) Thanks @gcanti! - Rename `Schema.makeUnsafe` instance method back to `Schema.make` on all schemas and schema-backed classes.

  Also remove the `static readonly make` override from `ShardId` to avoid conflicting with the inherited schema `make` method. The module-level `ShardId.make(group, id)` function is still available.

- [#1999](https://github.com/Effect-TS/effect-smol/pull/1999) [`87e1fc8`](https://github.com/Effect-TS/effect-smol/commit/87e1fc8b67e4901d75f567b2fecc3841ab762cc4) Thanks @tim-smart! - use NoInfer in Layer constructors to prevent type erasure

- [#1971](https://github.com/Effect-TS/effect-smol/pull/1971) [`c1af1b7`](https://github.com/Effect-TS/effect-smol/commit/c1af1b756f63291e9c0298cf95c98a6920a0c2a0) Thanks @joepjoosten! - Allow unstable CLI fallback prompts to be created dynamically from an `Effect`.

- [#1961](https://github.com/Effect-TS/effect-smol/pull/1961) [`7bb5dce`](https://github.com/Effect-TS/effect-smol/commit/7bb5dce60e1d904ef049a0287dec2b2e6113c970) Thanks @IMax153! - Rename the `ServiceMap` module to `Context` across exports, docs, and tests.

- [#1973](https://github.com/Effect-TS/effect-smol/pull/1973) [`c8a877b`](https://github.com/Effect-TS/effect-smol/commit/c8a877b53e8f29616335719e5dd1c3992dddf780) Thanks @joepjoosten! - Underline the active label in CLI multi-select prompts and add a scratchpad example for manual verification.

- [#1967](https://github.com/Effect-TS/effect-smol/pull/1967) [`7da961a`](https://github.com/Effect-TS/effect-smol/commit/7da961ae4916229d2246699a5d3b20e5b2dd2020) Thanks @tim-smart! - clean up ShardId

## 4.0.0-beta.43

### Patch Changes

- [#1904](https://github.com/Effect-TS/effect-smol/pull/1904) [`2ae33d0`](https://github.com/Effect-TS/effect-smol/commit/2ae33d050914915f7cb9c25ab0a020901e08d596) Thanks @juliusmarminge! - Fix JSON-RPC serialization for `id` values that are falsey but valid, including `0` and `""`, while still mapping `null` to Effect's internal notification sentinel.

- [#1900](https://github.com/Effect-TS/effect-smol/pull/1900) [`979811a`](https://github.com/Effect-TS/effect-smol/commit/979811a4c3f7ed21ed18ef560c49fb7f5569e80e) Thanks @tim-smart! - Fix AI structured output schema generation for `Schema.Class` and `Schema.ErrorClass` by resolving top-level `$ref` entries before passing JSON Schema to providers and default codec transformers.

- [#1908](https://github.com/Effect-TS/effect-smol/pull/1908) [`eb7dbef`](https://github.com/Effect-TS/effect-smol/commit/eb7dbeffa883386ad912815e62c0820cac1fdf8e) Thanks @tim-smart! - Fix stream requests in Entity.toLayerQueue

- [#1907](https://github.com/Effect-TS/effect-smol/pull/1907) [`cf50eb4`](https://github.com/Effect-TS/effect-smol/commit/cf50eb49cb04706dae5185f624708117c413dee8) Thanks @tim-smart! - add WorkflowEngine interruptUnsafe

- [#1903](https://github.com/Effect-TS/effect-smol/pull/1903) [`1d046fe`](https://github.com/Effect-TS/effect-smol/commit/1d046fe484560e23f3e22cb23eec6433f8f1fa02) Thanks @kitlangton! - Add `Layer.suspend` as a lazy constructor for dynamically choosing a layer while preserving normal layer sharing.

## 4.0.0-beta.42

### Patch Changes

- [#1897](https://github.com/Effect-TS/effect-smol/pull/1897) [`924e216`](https://github.com/Effect-TS/effect-smol/commit/924e216caa7e0bbf22e994a0cd2ce8b1f0f0b3ee) Thanks @IMax153! - Append concrete choice values to CLI flag help descriptions so generated help shows valid command-line inputs.

- [#1894](https://github.com/Effect-TS/effect-smol/pull/1894) [`80e7f0c`](https://github.com/Effect-TS/effect-smol/commit/80e7f0cd9116e811e97b0ce30a77a8d1ecd072aa) Thanks @tim-smart! - Fix `MutableList.appendAll` / `appendAllUnsafe` so empty arrays are treated as a no-op instead of leaving behind an empty internal bucket.

- [#1895](https://github.com/Effect-TS/effect-smol/pull/1895) [`f8328bf`](https://github.com/Effect-TS/effect-smol/commit/f8328bf0314da3dc7f31d314f94a5840e8d5217f) Thanks @tim-smart! - Changed socket close handling so all close codes are treated as errors by default unless `closeCodeIsError` is overridden.

- [#1899](https://github.com/Effect-TS/effect-smol/pull/1899) [`66d1c06`](https://github.com/Effect-TS/effect-smol/commit/66d1c06039079129707a230f7ad8c676439d7133) Thanks @gcanti! - SchemaRepresentation: support `anyOf`/`oneOf` with sibling keywords in `fromJsonSchemaMultiDocument`

- [#1893](https://github.com/Effect-TS/effect-smol/pull/1893) [`bee800b`](https://github.com/Effect-TS/effect-smol/commit/bee800bf285192a01bec72a7b7b51bc1159434e6) Thanks @gcanti! - `Number.remainder`: fix incorrect results for small floats in scientific notation (e.g. `1e-7`).

- [#1898](https://github.com/Effect-TS/effect-smol/pull/1898) [`8930441`](https://github.com/Effect-TS/effect-smol/commit/8930441dee6f94c59c583d18d3ebd677cf1f2623) Thanks @mikearnaldi! - Rename `Effect.transaction` to `Effect.tx` and `Effect.retryTransaction` to `Effect.txRetry`, remove `Effect.transactionWith` / `Effect.withTxState`, make nested `Effect.tx` calls compose into the active transaction, and make the public `Tx*` APIs establish atomic transactions without requiring `Transaction` in common usage.

## 4.0.0-beta.41

### Patch Changes

- [#1881](https://github.com/Effect-TS/effect-smol/pull/1881) [`36f5c21`](https://github.com/Effect-TS/effect-smol/commit/36f5c2174d31ab42c4598bf81f178f40d0802283) Thanks @gcanti! - Added `BigDecimal.sumAll` and `BigDecimal.multiplyAll` for feature parity with `Number` and `BigInt`, closes #1880.

- [#1869](https://github.com/Effect-TS/effect-smol/pull/1869) [`d8ce758`](https://github.com/Effect-TS/effect-smol/commit/d8ce758669d6297ae932ac3251d83e7b49b22f30) Thanks @gcanti! - Schema: collapse same-type literal branches in JSON Schema output into a single `enum` array, closes #1868.

  Before:

  ```json
  {
    "anyOf": [
      { "type": "string", "enum": ["A"] },
      { "type": "string", "enum": ["B"] }
    ]
  }
  ```

  After:

  ```json
  {
    "type": "string",
    "enum": ["A", "B"]
  }
  ```

- [#1879](https://github.com/Effect-TS/effect-smol/pull/1879) [`11aab4c`](https://github.com/Effect-TS/effect-smol/commit/11aab4c6d37d5691adafc2d33da1a631b28ce814) Thanks @tim-smart! - Highlight active option labels in `Prompt.select` and `Prompt.multiSelect` using cyan text so selection state is visible beyond the pointer / checkbox icon.

- [#1884](https://github.com/Effect-TS/effect-smol/pull/1884) [`3bc1efb`](https://github.com/Effect-TS/effect-smol/commit/3bc1efb53dd75b4a40de46f1f80c7f8a7d50af86) Thanks @tim-smart! - Fail RpcClient HTTP requests when the server response contains no RPC messages instead of leaving requests pending.

- [#1875](https://github.com/Effect-TS/effect-smol/pull/1875) [`70e724e`](https://github.com/Effect-TS/effect-smol/commit/70e724e604604d4be1061cd8da0d360494998c84) Thanks @IMax153! - Fix AI text method toolkit typing to support generic handler toolkits, preserve toolkit union inference, and keep response part narrowing by tool name.

- [#1876](https://github.com/Effect-TS/effect-smol/pull/1876) [`738dee7`](https://github.com/Effect-TS/effect-smol/commit/738dee7edfd70af82dc4d2376db3a8ebe603eb48) Thanks @tim-smart! - Track ManagedRuntime fibers in a scope

- [#1886](https://github.com/Effect-TS/effect-smol/pull/1886) [`2111963`](https://github.com/Effect-TS/effect-smol/commit/2111963f19b4c28c800664a8fac9590c1321885f) Thanks @tim-smart! - add ClusterSchema.WithTransaction annotation

- [#1877](https://github.com/Effect-TS/effect-smol/pull/1877) [`198a553`](https://github.com/Effect-TS/effect-smol/commit/198a553d9ce45f6a00bfc4d65ed0640669602d95) Thanks @tim-smart! - allow Context.Key to be covariant

## 4.0.0-beta.40

### Patch Changes

- [#1863](https://github.com/Effect-TS/effect-smol/pull/1863) [`f62860f`](https://github.com/Effect-TS/effect-smol/commit/f62860f0e5e45978fabf7256ae620a13152a772a) Thanks @tim-smart! - fix issues with metro bundler

- [#1866](https://github.com/Effect-TS/effect-smol/pull/1866) [`973f281`](https://github.com/Effect-TS/effect-smol/commit/973f2812529aadc1cc54598b2039799fa72b80f8) Thanks @tim-smart! - add Stream.timeoutOrElse

## 4.0.0-beta.39

### Patch Changes

- [#1844](https://github.com/Effect-TS/effect-smol/pull/1844) [`f91fd3d`](https://github.com/Effect-TS/effect-smol/commit/f91fd3db39fe5628439fd175fba201a65a1aa9d0) Thanks @tim-smart! - Relax `HttpApiClient.urlBuilder` to accept `HttpApi.Any` instead of requiring `HttpApi.AnyWithProps`.
  This allows use in helpers generic over `HttpApi.Any` while preserving inferred URL builder types.

- [#1851](https://github.com/Effect-TS/effect-smol/pull/1851) [`edaae9d`](https://github.com/Effect-TS/effect-smol/commit/edaae9d65f464f941d7eddd723cd33d324f4b071) Thanks @tim-smart! - Re-export additional core runtime references from `effect/References`, including logger and error reporter references.

- [#1856](https://github.com/Effect-TS/effect-smol/pull/1856) [`b47db0b`](https://github.com/Effect-TS/effect-smol/commit/b47db0bd5802064b6a24b3ea27c6ff2e0520d513) Thanks @gcanti! - Fix `Struct` utility return types (for example `pick`) to preserve the previous simplified shape instead of exposing raw utility types like `Pick<T, K>`, closes #1855.

- [#1849](https://github.com/Effect-TS/effect-smol/pull/1849) [`82d3c8e`](https://github.com/Effect-TS/effect-smol/commit/82d3c8e4f3f49b00df611b25aa6f8f74ec21b59b) Thanks @tim-smart! - Fix the `Queue.takeN` documentation example to end the queue before showing a partial batch.

- [#1848](https://github.com/Effect-TS/effect-smol/pull/1848) [`7c22b31`](https://github.com/Effect-TS/effect-smol/commit/7c22b315d198dcbf44ae8cdb8b37879e1c9e3996) Thanks @tim-smart! - Remove `Schedule.compose` in favor of `Schedule.both`, and update schedule examples to use `Schedule.both`.

## 4.0.0-beta.38

### Patch Changes

- [#1842](https://github.com/Effect-TS/effect-smol/pull/1842) [`f4dbe5b`](https://github.com/Effect-TS/effect-smol/commit/f4dbe5b26b9c2d33fae024bf44afbdf8541792cd) Thanks @gcanti! - Schema: rename `MakeOptions.disableValidation` to `disableChecks`. Apply constructor defaults when `disableChecks` is true, closes #1841.

- [#1837](https://github.com/Effect-TS/effect-smol/pull/1837) [`a71a607`](https://github.com/Effect-TS/effect-smol/commit/a71a607c89fb6669a12a562c2c23be81dfbe1adb) Thanks @kitlangton! - Fix `HttpApiBuilder` security middleware caching so separate handler builds do not reuse the first provided middleware implementation.

- [#1840](https://github.com/Effect-TS/effect-smol/pull/1840) [`66a0494`](https://github.com/Effect-TS/effect-smol/commit/66a0494ed75cd12f2721dcbb1d8a072e3d9e14b6) Thanks @tim-smart! - Rename HttpApiClient request option `withResponse` to `responseMode` and add support for `responseMode: "response-only"` to return the raw `HttpClientResponse` without decoding.

- [#1838](https://github.com/Effect-TS/effect-smol/pull/1838) [`5ef7218`](https://github.com/Effect-TS/effect-smol/commit/5ef7218fc559d57301fe929b8a0cab4033f4f1fd) Thanks @tim-smart! - Update `HttpApiClient.urlBuilder` to mirror client shape, and encode params/query via endpoint schemas before building URLs.

- [#1700](https://github.com/Effect-TS/effect-smol/pull/1700) [`472d260`](https://github.com/Effect-TS/effect-smol/commit/472d260655bc311fba5c2c6e23bb77d8f7e36ba0) Thanks @tim-smart! - add `useCodecs` option to HttpClientEndpoint constructors

## 4.0.0-beta.37

### Patch Changes

- [#1812](https://github.com/Effect-TS/effect-smol/pull/1812) [`f7a0b71`](https://github.com/Effect-TS/effect-smol/commit/f7a0b711da8fdd645597dee29cacc5619c6afcf2) Thanks @tim-smart! - Consolidate the SqlError changes to the new reason-based shape across effect and the SQL drivers, classifying native failures into structured reasons with Unknown fallback where native codes are unavailable.

- [#1816](https://github.com/Effect-TS/effect-smol/pull/1816) [`1e223c3`](https://github.com/Effect-TS/effect-smol/commit/1e223c30ccf835dfbb21284535d78549efaeca80) Thanks @tim-smart! - unstable/http HttpClientRequest: add toWeb and fromWeb conversions for web Request objects

- [#1829](https://github.com/Effect-TS/effect-smol/pull/1829) [`53740f4`](https://github.com/Effect-TS/effect-smol/commit/53740f47aa76d114b7d535649fb50efc54a09608) Thanks @tim-smart! - Fix sql migrator lock handling to only treat duplicate migration-row inserts as a concurrent migration lock.

- [#1831](https://github.com/Effect-TS/effect-smol/pull/1831) [`8c7cf89`](https://github.com/Effect-TS/effect-smol/commit/8c7cf89f719e580cbce1bf6c24e6996f1992a0a6) Thanks @tim-smart! - Fix `Schedule.fixed` to run the next iteration immediately when the previous action takes longer than the configured interval.

- [#1833](https://github.com/Effect-TS/effect-smol/pull/1833) [`b6b81a9`](https://github.com/Effect-TS/effect-smol/commit/b6b81a940eaafcbc792d25413d6c02c707de31b2) Thanks @tim-smart! - Fix `Unify.unify` so unions of `Effect` values collapse to a single unified `Effect` type again.

- [#1825](https://github.com/Effect-TS/effect-smol/pull/1825) [`8f4c1f9`](https://github.com/Effect-TS/effect-smol/commit/8f4c1f97ed60f8810b0b327b50117ffb2d8260d4) Thanks @skoshx! - Fix DevToolsClient not flushing final span events on teardown.

  The stream consumer was `forkScoped`, causing it to be interrupted before
  it could drain remaining queue items. Replaced with `forkChild` and
  `Fiber.await` in the finalizer so the stream drains naturally after the
  queue is failed.

- [#1824](https://github.com/Effect-TS/effect-smol/pull/1824) [`f2479f9`](https://github.com/Effect-TS/effect-smol/commit/f2479f9d3113b1f012db17a3852b4e28f478cf9c) Thanks @tim-smart! - Ignore unsupported Ctrl key combinations in interactive CLI prompts to avoid rendering control characters such as Ctrl+L form feed into prompt input.

- [#1819](https://github.com/Effect-TS/effect-smol/pull/1819) [`c919921`](https://github.com/Effect-TS/effect-smol/commit/c9199217fad65529421d2cf95ecfff41257090fd) Thanks @j! - HttpServerResponse: fix `fromWeb` to preserve Content-Type header when response has a body

  Previously, when converting a web `Response` to an `HttpServerResponse` via `fromWeb`, the `Content-Type` header was not passed to `Body.stream()`, causing it to default to `application/octet-stream`. This affected any code using `HttpApp.fromWebHandler` to wrap web handlers, as JSON responses would incorrectly have their Content-Type set to `application/octet-stream` instead of `application/json`.

- [#1821](https://github.com/Effect-TS/effect-smol/pull/1821) [`7af90c2`](https://github.com/Effect-TS/effect-smol/commit/7af90c2e3c99038eafa39650433839523790e2fe) Thanks @gcanti! - Schema: relax `asserts` and `is` constraints.

- [#1822](https://github.com/Effect-TS/effect-smol/pull/1822) [`f3be185`](https://github.com/Effect-TS/effect-smol/commit/f3be18569e5ca57c25eabf00df3ca601ebab43c7) Thanks @tim-smart! - improve runSync error when executing async effects

## 4.0.0-beta.36

### Patch Changes

- [#1793](https://github.com/Effect-TS/effect-smol/pull/1793) [`60fcbcc`](https://github.com/Effect-TS/effect-smol/commit/60fcbcc43d09471e8f7e0969955d99dcefc5be81) Thanks @tim-smart! - Ensure streamed tool results are emitted before the finish part so chat history includes tool outputs before stream termination.

- [#1762](https://github.com/Effect-TS/effect-smol/pull/1762) [`0a60837`](https://github.com/Effect-TS/effect-smol/commit/0a6083713124440e630030375bab367e8d7df24e) Thanks @kitlangton! - Allow unstable HttpApi middleware to declare multiple error schemas with arrays.

  Middleware errors now follow endpoint error behavior for response status resolution, client decoding, and generated API schemas.

- [#1805](https://github.com/Effect-TS/effect-smol/pull/1805) [`49164d2`](https://github.com/Effect-TS/effect-smol/commit/49164d2c20a8d21b66514992c4a15d8521f6b36e) Thanks @tim-smart! - Fix `Effect.cachedWithTTL` and `Effect.cachedInvalidateWithTTL` to start TTL expiration when the cached value is produced instead of when computation starts.

- [#1808](https://github.com/Effect-TS/effect-smol/pull/1808) [`334b6e4`](https://github.com/Effect-TS/effect-smol/commit/334b6e4f76fe11941b516d61f57e268bc31f0ca6) Thanks @tim-smart! - Backport `Cron.prev` with reverse lookup tables and cron stepping logic, including DST-aware reverse traversal.

- [#1789](https://github.com/Effect-TS/effect-smol/pull/1789) [`5700695`](https://github.com/Effect-TS/effect-smol/commit/5700695f76ae6da6b94c9c87d4dd2b8054fb829b) Thanks @mikearnaldi! - Fix `Stream.scanEffect` hanging and repeatedly emitting the initial state.

- [#1810](https://github.com/Effect-TS/effect-smol/pull/1810) [`f8f4456`](https://github.com/Effect-TS/effect-smol/commit/f8f445644f3aa7ec093cab7445198a62ba18a480) Thanks @tim-smart! - Support key-derived `idleTimeToLive` in `LayerMap` options (`make`, `fromRecord`, and `LayerMap.Service`) and add `LayerMap` tests for dynamic TTL behavior.

- [#1802](https://github.com/Effect-TS/effect-smol/pull/1802) [`969d24f`](https://github.com/Effect-TS/effect-smol/commit/969d24fdfa48c4838e811983848d9cb4e9b3b12c) Thanks @kitlangton! - PubSub.publish and PubSub.publishAll now return false on shutdown instead of interrupting, matching Queue.offer semantics.

- [#1796](https://github.com/Effect-TS/effect-smol/pull/1796) [`851eda0`](https://github.com/Effect-TS/effect-smol/commit/851eda0533946e39bacaaf581896320d7a4f3e8c) Thanks @tim-smart! - Improve `Prompt.file` to support incremental filtering while typing, including backspace and ctrl-u handling.

- [#1806](https://github.com/Effect-TS/effect-smol/pull/1806) [`8059c1c`](https://github.com/Effect-TS/effect-smol/commit/8059c1c3eba9a90af7cd889ea261bcb8fff0c185) Thanks @tim-smart! - Fix a regression in `PubSub.shutdown` so shutting down a pubsub interrupts suspended subscribers (including `takeAll`) by ensuring subscriptions are scoped under the pubsub shutdown scope.

- [#1797](https://github.com/Effect-TS/effect-smol/pull/1797) [`6f83295`](https://github.com/Effect-TS/effect-smol/commit/6f8329546a73eaddc7cb5e85ea8e37e73fbfb611) Thanks @tim-smart! - Add \`Ctrl-A\` and \`Ctrl-E\` key handling for editable CLI text prompts to move the cursor to the beginning or end of the current input line.

- [#1633](https://github.com/Effect-TS/effect-smol/pull/1633) [`65f7f57`](https://github.com/Effect-TS/effect-smol/commit/65f7f5737575fed668987462c96d29a446707c32) Thanks @kitlangton! - Schema: add `decodeUnknownResult` / `decodeResult` and `encodeUnknownResult` / `encodeResult` helpers for synchronous `Result`-based parsing.

- [#1798](https://github.com/Effect-TS/effect-smol/pull/1798) [`e7fabd2`](https://github.com/Effect-TS/effect-smol/commit/e7fabd2265db690eae5cfc9b83730c84699aef61) Thanks @gcanti! - Schema: allow using `Struct` type helpers directly, e.g. `Schema.Struct.Type<F>` instead of `Schema.Schema.Type<Schema.Struct<F>>`.

- [#1794](https://github.com/Effect-TS/effect-smol/pull/1794) [`89c3e98`](https://github.com/Effect-TS/effect-smol/commit/89c3e985401eb38f33a3ae21a94ad27de3c1d28b) Thanks @tim-smart! - Fix ai LanguageModel streaming finish parts so finish events are always emitted when a toolkit is provided.

- [#1785](https://github.com/Effect-TS/effect-smol/pull/1785) [`53794ab`](https://github.com/Effect-TS/effect-smol/commit/53794ab7af30aa5c5004ecf53659fafbe4b10542) Thanks @KhraksMamtsov! - add missing Equivalence.Date

## 4.0.0-beta.35

### Patch Changes

- [#1782](https://github.com/Effect-TS/effect-smol/pull/1782) [`9252b43`](https://github.com/Effect-TS/effect-smol/commit/9252b43560f507709c2985abcf52a7837b23ddf8) Thanks @gcanti! - Add `Schema.ArrayEnsure`.

- [#1784](https://github.com/Effect-TS/effect-smol/pull/1784) [`7daf387`](https://github.com/Effect-TS/effect-smol/commit/7daf3870a656882a488a60f67881e6808c8f4d04) Thanks @gcanti! - Add `Config.Success` type utility, closes #1783.

- [#1778](https://github.com/Effect-TS/effect-smol/pull/1778) [`e1664a3`](https://github.com/Effect-TS/effect-smol/commit/e1664a38bc31ef4ceb4e9324c7226e1e99bf9c07) Thanks @tim-smart! - Allow `Effect.acquireRelease` release finalizers to depend on the surrounding environment.

- [#1777](https://github.com/Effect-TS/effect-smol/pull/1777) [`fdaa6e0`](https://github.com/Effect-TS/effect-smol/commit/fdaa6e0a41b6b6605438fa8557441792135380a2) Thanks @tim-smart! - Remove an unreachable array branch in `decodeJsonRpcRaw` to simplify JSON-RPC decode logic without changing behavior.

- [#1774](https://github.com/Effect-TS/effect-smol/pull/1774) [`19aa47e`](https://github.com/Effect-TS/effect-smol/commit/19aa47ef7b470e427620edca8970dd9cdd551216) Thanks @tim-smart! - Align CLI help flag and global flag descriptions to a single column even when some flag names are very long.

- [#1780](https://github.com/Effect-TS/effect-smol/pull/1780) [`c667dad`](https://github.com/Effect-TS/effect-smol/commit/c667dad07777b860e4764a3ba9a6cc41c236cd98) Thanks @tim-smart! - Fix `LanguageModel` incremental prompt fallback to reliably retry with the full prompt when an incremental request fails with `InvalidRequestError`.

- [#1781](https://github.com/Effect-TS/effect-smol/pull/1781) [`764d150`](https://github.com/Effect-TS/effect-smol/commit/764d1501bc5026b60fc8aef6cb02a5a87c762801) Thanks @gcanti! - Fix `DateTime.makeUnsafe` incorrectly appending "Z" to date strings containing "GMT"

- [#1772](https://github.com/Effect-TS/effect-smol/pull/1772) [`3c27098`](https://github.com/Effect-TS/effect-smol/commit/3c27098b5685a63db2c2eff654a250c94d3fcfa7) Thanks @tim-smart! - make Layer.mock work with Stream and Channel

## 4.0.0-beta.34

### Patch Changes

- [#1758](https://github.com/Effect-TS/effect-smol/pull/1758) [`f2f75ee`](https://github.com/Effect-TS/effect-smol/commit/f2f75ee564bce1cd95f5189c7bdeeed4f92dacb1) Thanks @tim-smart! - Use a normal Map in ResponseIdTracker and clear it on divergence / reset instead of reallocating a WeakMap.

- [#1764](https://github.com/Effect-TS/effect-smol/pull/1764) [`342fc4b`](https://github.com/Effect-TS/effect-smol/commit/342fc4b051739e32e7977159f26ff9541eda664f) Thanks @tim-smart! - Add unstable EmbeddingModel support across core and OpenAI providers.
  - Add the unstable EmbeddingModel module API surface in `effect`, including service, request, response, and provider types.
  - Implement the unstable EmbeddingModel runtime constructor in `effect`, with `RequestResolver` batching, `embed` / `embedMany` spans, provider error propagation, deterministic ordering, and empty-input `embedMany` fast-path behavior.
  - Add and align EmbeddingModel behavior tests in `effect` for embedding usage, batching, ordering, and error handling.
  - Add `OpenAiEmbeddingModel` in `@effect/ai-openai`, including model / make / layer constructors, config overrides, and provider output index validation with deterministic reordering.
  - Add OpenAI-compatible EmbeddingModel provider support in `@effect/ai-openai-compat`, including config overrides, layer constructors, and output index validation.

- [#1766](https://github.com/Effect-TS/effect-smol/pull/1766) [`5d704ee`](https://github.com/Effect-TS/effect-smol/commit/5d704ee10d20e8eb107e34bb8a21feb5aa4a7685) Thanks @tim-smart! - Fix JSDoc wording for `Effect.catch` to consistently reference the current API name.

- [#1771](https://github.com/Effect-TS/effect-smol/pull/1771) [`00add69`](https://github.com/Effect-TS/effect-smol/commit/00add69b59551e9df34772eb927638b093f6d71e) Thanks @tim-smart! - Add `EmbeddingModel.ModelDimensions` and require dimensions in embedding provider `model` constructors.

- [#1767](https://github.com/Effect-TS/effect-smol/pull/1767) [`58217d3`](https://github.com/Effect-TS/effect-smol/commit/58217d318a7d716ccd707cce0f41573946939c28) Thanks @gcanti! - Add `isMutableHashMap` and `isMutableHashSet`, and align nominal guard implementations and tests across collections and transactional data types.

- [#1765](https://github.com/Effect-TS/effect-smol/pull/1765) [`f4e2aba`](https://github.com/Effect-TS/effect-smol/commit/f4e2aba01b76d1e3059b297e3cc942284dfeafb2) Thanks @tim-smart! - retry incremental prompt on invalid request

- [#1756](https://github.com/Effect-TS/effect-smol/pull/1756) [`e3b44b6`](https://github.com/Effect-TS/effect-smol/commit/e3b44b6a2af9ee21dc5c1e928f0c20af857fa7a9) Thanks @tim-smart! - add HttpApiMiddleware.layerSchemaErrorTransform

- [#1732](https://github.com/Effect-TS/effect-smol/pull/1732) [`e1472b7`](https://github.com/Effect-TS/effect-smol/commit/e1472b7525c5d57a48bdec2353c3b742f7f916c0) Thanks @KhraksMamtsov! - port Url module from v3

- [#1761](https://github.com/Effect-TS/effect-smol/pull/1761) [`7686320`](https://github.com/Effect-TS/effect-smol/commit/7686320cd123fa352b5c3d076fb18a3cac0a9bba) Thanks @gcanti! - Fix `Tool.make` type and runtime behavior when `parameters` is not provided.

## 4.0.0-beta.33

### Patch Changes

- [#1754](https://github.com/Effect-TS/effect-smol/pull/1754) [`571447d`](https://github.com/Effect-TS/effect-smol/commit/571447da67334449f8ae3d6ecb3d77ea4e0c4295) Thanks @tim-smart! - narrow types for Effect.retry/repeat while option

## 4.0.0-beta.32

### Patch Changes

- [#1717](https://github.com/Effect-TS/effect-smol/pull/1717) [`bf8fff8`](https://github.com/Effect-TS/effect-smol/commit/bf8fff8a5f54b6df74cb7bbb42346fe9ba52435a) Thanks @gcanti! - Schema: add `OptionFromOptionalNullOr` schema, closes #1707.

- [#1722](https://github.com/Effect-TS/effect-smol/pull/1722) [`1af3ef3`](https://github.com/Effect-TS/effect-smol/commit/1af3ef3e3ca7fd417d0fc15f8ca8fe207eba4f74) Thanks @tim-smart! - Fix `RpcSerialization.json` decode so JSON array payloads are not wrapped in an extra outer array.

- [#1725](https://github.com/Effect-TS/effect-smol/pull/1725) [`27fea0f`](https://github.com/Effect-TS/effect-smol/commit/27fea0f66910de5905f40fd63f8ddbb6f7ac5aba) Thanks @tim-smart! - Improve unstable HttpApi runtime failures for missing server middleware and missing group implementations.
  - HttpApiBuilder.applyMiddleware now resolves middleware services via Context.getUnsafe, so missing middleware fails with a clear "Service not found: <middleware>" error instead of an opaque is not a function TypeError.
  - HttpApiBuilder.layer now reports missing groups with actionable context (group identifier, service key, suggested HttpApiBuilder.group(...) call, and available group keys).
  - Added regression tests in packages/platform-node/test/HttpApi.test.ts covering:
    - addHttpApi + API-level middleware applied across merged groups
    - missing middleware service diagnostics
    - missing addHttpApi group layer diagnostics

- [#1727](https://github.com/Effect-TS/effect-smol/pull/1727) [`2ad6c1b`](https://github.com/Effect-TS/effect-smol/commit/2ad6c1b2c85a3a0fe351e3d56636a75eb76b4b4e) Thanks @tim-smart! - Make all built-in `HttpApiError` classes implement `HttpServerRespondable`, so they can be returned directly from plain HTTP server handlers outside of `HttpApi`.

- [#1739](https://github.com/Effect-TS/effect-smol/pull/1739) [`398ac3e`](https://github.com/Effect-TS/effect-smol/commit/398ac3e01cb75efce0e4e2913d1450cf65866732) Thanks @tim-smart! - Use predicate-based `dual` dispatch for `Stream.merge` so data-last calls with optional `options` are handled correctly.

- [#1741](https://github.com/Effect-TS/effect-smol/pull/1741) [`51fe22f`](https://github.com/Effect-TS/effect-smol/commit/51fe22f3266e417b6c541aaed4b75d246fac91e7) Thanks @tim-smart! - Add `Layer.tap`, `Layer.tapError`, and `Layer.tapCause` APIs for effectful observation of layer success and failure without changing layer outputs.

- [#1740](https://github.com/Effect-TS/effect-smol/pull/1740) [`4605db6`](https://github.com/Effect-TS/effect-smol/commit/4605db69cfacddbdbf1525865ddfde135158090c) Thanks @tim-smart! - Refactor call sites with multiple `Context` mutations to use `Context.mutate` for batched updates.

- [#1750](https://github.com/Effect-TS/effect-smol/pull/1750) [`f4de1b0`](https://github.com/Effect-TS/effect-smol/commit/f4de1b087c998d0bad1d9468f70b7d16c13b9f6f) Thanks @gcanti! - Improve unstable AI structured output handling for empty tool params and add `Tool.EmptyParams`, closes #1749.

- [#1525](https://github.com/Effect-TS/effect-smol/pull/1525) [`60214f2`](https://github.com/Effect-TS/effect-smol/commit/60214f2080b2aeb091f691140eb20acb741691c3) Thanks @tim-smart! - use Option<A> instead of undefined | A

- [#1747](https://github.com/Effect-TS/effect-smol/pull/1747) [`c4b8b0f`](https://github.com/Effect-TS/effect-smol/commit/c4b8b0ffa8efb47c4cd7578a8943d6868509373f) Thanks @tim-smart! - seperate scheduler dispatch from yield decisions

- [#1729](https://github.com/Effect-TS/effect-smol/pull/1729) [`6d9393a`](https://github.com/Effect-TS/effect-smol/commit/6d9393a0770a18722d23340e77f15455de341245) Thanks @tim-smart! - add Context.mutate

- [#1753](https://github.com/Effect-TS/effect-smol/pull/1753) [`6de4efe`](https://github.com/Effect-TS/effect-smol/commit/6de4efe463c783614ceb0c094d77a336a899cbe0) Thanks @tim-smart! - Add dtslint coverage for `Stream.catchIf` to lock in predicate and refinement inference behavior in both data-first and data-last forms.

- [#1716](https://github.com/Effect-TS/effect-smol/pull/1716) [`4f969d1`](https://github.com/Effect-TS/effect-smol/commit/4f969d1563ba755ffa116c8ae409bb3436bd881d) Thanks @gcanti! - Remove unused `effect/NullOr` module.

- [#1721](https://github.com/Effect-TS/effect-smol/pull/1721) [`6cc67c8`](https://github.com/Effect-TS/effect-smol/commit/6cc67c855e054ee3f3ac3485dca5f7805e79e8fb) Thanks @IMax153! - Correct the type of the schema parameter accepted by the `fileSchema` methods in the CLI to be `Schema.Decoder<A>`

- [#1709](https://github.com/Effect-TS/effect-smol/pull/1709) [`8531a22`](https://github.com/Effect-TS/effect-smol/commit/8531a22ffbb52e11a030b09f358cafbfdf5edff7) Thanks @mikearnaldi! - Add module-level helpers for `Semaphore`, `Latch`, and extracted `PartitionedSemaphore` operations.

- [#1752](https://github.com/Effect-TS/effect-smol/pull/1752) [`b226760`](https://github.com/Effect-TS/effect-smol/commit/b22676067617f15c00722a3a63fd7c2c172c3d45) Thanks @tim-smart! - simplify SubscriptionRef

- [#1743](https://github.com/Effect-TS/effect-smol/pull/1743) [`47a51ab`](https://github.com/Effect-TS/effect-smol/commit/47a51aba0ecdf3ef478bfa28a498bca188399bd4) Thanks @tim-smart! - default ws close codes to 1001 in case they are undefined

- [#1728](https://github.com/Effect-TS/effect-smol/pull/1728) [`1521d02`](https://github.com/Effect-TS/effect-smol/commit/1521d02e1f19f1d795edaaf862c1a1031d9c755e) Thanks @tim-smart! - add graceful shutdown to http servers

## 4.0.0-beta.31

### Patch Changes

- [#1696](https://github.com/Effect-TS/effect-smol/pull/1696) [`5a84853`](https://github.com/Effect-TS/effect-smol/commit/5a8485397b7f321ae021640c1999821143659462) Thanks @krzkaczor! - Add `DurationObject` to `Duration.Input` to support Temporal-style object input.

  Durations can now be created from objects with named unit properties like `{ hours: 1, minutes: 30 }`, similar to `Temporal.Duration.from()`. Supported fields: `weeks`, `days`, `hours`, `minutes`, `seconds`, `millis`, `micros`, `nanos`.

- [#1705](https://github.com/Effect-TS/effect-smol/pull/1705) [`6f23f0e`](https://github.com/Effect-TS/effect-smol/commit/6f23f0ed4cba573cd9395c2e582f582fe7271544) Thanks @tim-smart! - Preserve message item ordering in the default logger when logging a `Cause` with message values.

- [#1711](https://github.com/Effect-TS/effect-smol/pull/1711) [`654aaec`](https://github.com/Effect-TS/effect-smol/commit/654aaec593305521b65dd042c204d761cc6e8c28) Thanks @tim-smart! - Fix `RpcGroup.toLayer` and `RpcGroup.toLayerHandler` service requirement inference so handler dependencies are preserved for non-stream RPC handlers.

- [#1712](https://github.com/Effect-TS/effect-smol/pull/1712) [`2958a42`](https://github.com/Effect-TS/effect-smol/commit/2958a42078966a8713a98f00485ab36484d5eccf) Thanks @tim-smart! - Expose CLI completions as a public unstable module at `effect/unstable/cli/Completions`.

- [#1713](https://github.com/Effect-TS/effect-smol/pull/1713) [`95d27a2`](https://github.com/Effect-TS/effect-smol/commit/95d27a239ed5147302605ab0b3147a056541b0c7) Thanks @tim-smart! - Make `Layer.mock` a dual API so it supports both `Layer.mock(Service)(impl)` and `Layer.mock(Service, impl)`.

- [#1704](https://github.com/Effect-TS/effect-smol/pull/1704) [`0fbaea8`](https://github.com/Effect-TS/effect-smol/commit/0fbaea8f9555a8044cec31a770394db613fc78e2) Thanks @tim-smart! - Support toolkit unions in `LanguageModel` options.

- [#1701](https://github.com/Effect-TS/effect-smol/pull/1701) [`21d5d5e`](https://github.com/Effect-TS/effect-smol/commit/21d5d5e0439fd4d9bb6e508377215b1087555d45) Thanks @tim-smart! - wrap httpapi request context with HttpRouter.Request

- [#1696](https://github.com/Effect-TS/effect-smol/pull/1696) [`5a84853`](https://github.com/Effect-TS/effect-smol/commit/5a8485397b7f321ae021640c1999821143659462) Thanks @krzkaczor! - allow assigning Temporal types to DateTime & Duration input

- [#1698](https://github.com/Effect-TS/effect-smol/pull/1698) [`6e49959`](https://github.com/Effect-TS/effect-smol/commit/6e499590357a104c81779b3176cd3f84e4f91064) Thanks @tim-smart! - Include toolkit tool handler requirements in AI generation API environment inference.

- [#1703](https://github.com/Effect-TS/effect-smol/pull/1703) [`8f5805d`](https://github.com/Effect-TS/effect-smol/commit/8f5805dbdd0d1bc0ff0727cc398c8d80e544edee) Thanks @tim-smart! - Relax `Ndjson` byte-stream channel signatures to accept plain `Uint8Array`.

- [#1710](https://github.com/Effect-TS/effect-smol/pull/1710) [`990df2c`](https://github.com/Effect-TS/effect-smol/commit/990df2c3ceeb32e659acc10cc9485617f7b3c423) Thanks @gcanti! - Schema: `toCodecJson` now returns `Codec<T, Json, RD, RE>` instead of `Codec<T, unknown, RD, RE>`.

  Http: the `json` property on `HttpIncomingMessage`, `HttpClientResponse`, `HttpServerRequest`, and `HttpServerResponse` now returns `Effect<Schema.Json, E>` instead of `Effect<unknown, E>`.

## 4.0.0-beta.30

### Patch Changes

- [#1675](https://github.com/Effect-TS/effect-smol/pull/1675) [`c88e5b7`](https://github.com/Effect-TS/effect-smol/commit/c88e5b723ff09da4edaef6ce14d927ca01104a32) Thanks @gijsbartman! - Fix consolePretty ignoring explicit colors option in non-TTY environments.

  When colors is explicitly set to true, prettyLoggerTty was still gating it with processStdoutIsTTY check, making it impossible to enable colors in non-TTY environments like Vite dev server.

- [#1690](https://github.com/Effect-TS/effect-smol/pull/1690) [`947d0e4`](https://github.com/Effect-TS/effect-smol/commit/947d0e4268ba5c4020ead380aa80812c7342408f) Thanks @gcanti! - Fix `Cause.hasInterruptsOnly` to return `false` for empty causes.

- [#1620](https://github.com/Effect-TS/effect-smol/pull/1620) [`7517908`](https://github.com/Effect-TS/effect-smol/commit/75179085d159b88a1ab0bce70669d76dcf0d79a4) Thanks @kitlangton! - Fix `TaggedUnion.match` to use `Unify` for return types, allowing
  branches to return distinct Effect types that are properly merged.

- [#1680](https://github.com/Effect-TS/effect-smol/pull/1680) [`a49ecd5`](https://github.com/Effect-TS/effect-smol/commit/a49ecd5a183d7e7d33f47ff95e9d2dea5a12ead5) Thanks @KhraksMamtsov! - make HttpClientResponse pipeable

- [#1681](https://github.com/Effect-TS/effect-smol/pull/1681) [`6993e33`](https://github.com/Effect-TS/effect-smol/commit/6993e3329122c834c20bacea72d8678232f4f103) Thanks @mikearnaldi! - Add an optional `message` field to `Effect.ignore` and `Effect.ignoreCause` for custom log output.

- [#1695](https://github.com/Effect-TS/effect-smol/pull/1695) [`514f2a2`](https://github.com/Effect-TS/effect-smol/commit/514f2a2ae54580fcacdbe2ea2196a83a852d0748) Thanks @gcanti! - Remove unused APIs from the `Utils` module.

- [#1644](https://github.com/Effect-TS/effect-smol/pull/1644) [`3214b47`](https://github.com/Effect-TS/effect-smol/commit/3214b47676de2d33fddc5fecfc2d226e6e83cc7b) Thanks @patroza! - fix: update Service interface to use 'this: void' in 'of' method signatures

- [#1693](https://github.com/Effect-TS/effect-smol/pull/1693) [`95ec5ed`](https://github.com/Effect-TS/effect-smol/commit/95ec5ed345de77c893049e182d37a37cf164a268) Thanks @tim-smart! - fix cli subcommand context

## 4.0.0-beta.29

### Patch Changes

- [#1672](https://github.com/Effect-TS/effect-smol/pull/1672) [`9d93adb`](https://github.com/Effect-TS/effect-smol/commit/9d93adb1c1795d1978391b30d7d2972c88052662) Thanks @gcanti! - Add `Newtype` module.

- [#1677](https://github.com/Effect-TS/effect-smol/pull/1677) [`b52721c`](https://github.com/Effect-TS/effect-smol/commit/b52721cf0d11a567722b060c8536e3bdd4161f07) Thanks @gcanti! - Fix `Schema.isUUID` so the `version` parameter is optional in its public signature.

- [#1667](https://github.com/Effect-TS/effect-smol/pull/1667) [`a891c7b`](https://github.com/Effect-TS/effect-smol/commit/a891c7b12f415b2287613dd4b91a09dfd38ef30d) Thanks @tim-smart! - Preserve `Atom.withReactivity(...)` refresh behavior when registry initial values seed the wrapped atom.

- [#1678](https://github.com/Effect-TS/effect-smol/pull/1678) [`ef26cdf`](https://github.com/Effect-TS/effect-smol/commit/ef26cdfb65d9955fc7e161629191930c2cc2c63f) Thanks @tim-smart! - Abort HTTP client requests when response streams are consumed only partially.

- [#1665](https://github.com/Effect-TS/effect-smol/pull/1665) [`82fd3ed`](https://github.com/Effect-TS/effect-smol/commit/82fd3ed922063ee5a34f96f3993c15c7515e4f67) Thanks @tim-smart! - Remove placeholder fallback behavior from CLI prompt inputs now that default values are prefilled.

## 4.0.0-beta.28

### Minor Changes

- [#1637](https://github.com/Effect-TS/effect-smol/pull/1637) [`42bc7ce`](https://github.com/Effect-TS/effect-smol/commit/42bc7ce5480f6f2953c39f8cb5c850d61df6f5a2) Thanks @tim-smart! - Add a new `effect/unstable/http/HttpStaticServer` module for static file serving with MIME resolution, directory index fallback, SPA fallback, and safe path resolution.

### Patch Changes

- [#1659](https://github.com/Effect-TS/effect-smol/pull/1659) [`ff533f2`](https://github.com/Effect-TS/effect-smol/commit/ff533f203cd06302ad08032a27e01269b4a2d4c6) Thanks @tim-smart! - Persist MCP HTTP session and protocol headers after initialize so follow-up JSON-RPC requests include `MCP-Protocol-Version`.

- [#1663](https://github.com/Effect-TS/effect-smol/pull/1663) [`dc803ee`](https://github.com/Effect-TS/effect-smol/commit/dc803ee52ebd3e9f931118f0dfcb804542847556) Thanks @tim-smart! - Add `HttpServerResponse.fromClientResponse` for directly converting client responses into server responses.

- [#1657](https://github.com/Effect-TS/effect-smol/pull/1657) [`d660b1c`](https://github.com/Effect-TS/effect-smol/commit/d660b1c99cb93d4f79715e91c7a4486801c0eefa) Thanks @tim-smart! - Add `Ctrl-U` line clearing support to editable CLI prompts.

- [#1645](https://github.com/Effect-TS/effect-smol/pull/1645) [`93a05e3`](https://github.com/Effect-TS/effect-smol/commit/93a05e3eaa624058b162aedd66aad70102837270) Thanks @gijsbartman! - ensure transformed Atom's don't extend idle ttl

- [#1655](https://github.com/Effect-TS/effect-smol/pull/1655) [`2a65cf6`](https://github.com/Effect-TS/effect-smol/commit/2a65cf6fd81ef63d944e6fb51f058d439bf4a834) Thanks @tim-smart! - Make `AtomRpc.query` and `AtomHttpApi.query` return serializable atoms by default when query results are schema-backed.

  The atom serialization key now uses each API's built-in request schemas so dehydrated state can be keyed consistently across server and client.

- [#1662](https://github.com/Effect-TS/effect-smol/pull/1662) [`a561a40`](https://github.com/Effect-TS/effect-smol/commit/a561a40cc41c548c2cf3153aca065ee92ee8aa57) Thanks @tim-smart! - Add `HttpServerRequest.toClientRequest` for direct server-to-client request conversion.

- [#1648](https://github.com/Effect-TS/effect-smol/pull/1648) [`29cd24d`](https://github.com/Effect-TS/effect-smol/commit/29cd24d1fe78480a72eeb38a90281ffddc0530bc) Thanks @gcanti! - Fix `Types.VoidIfEmpty` to correctly detect empty object types. Remove deprecated `Types.MatchRecord` in favor of the simplified implementation, closes #1647.

- [#1664](https://github.com/Effect-TS/effect-smol/pull/1664) [`662a8e6`](https://github.com/Effect-TS/effect-smol/commit/662a8e6857dac64a7cd13bd8df4b0674654622f8) Thanks @tim-smart! - Add `HttpServerRequest.fromClientRequest` for direct client-request-backed server request conversion.

- [#1656](https://github.com/Effect-TS/effect-smol/pull/1656) [`d2b52ba`](https://github.com/Effect-TS/effect-smol/commit/d2b52bae5b9336cf59729fbdcc4d7f09512b0cbf) Thanks @tim-smart! - Persist MCP client capability context across HTTP requests by resolving initialized payloads through the standard `Mcp-Session-Id` HTTP header in `McpServer`.

  Adds a regression test that initializes an MCP HTTP client, verifies the MCP server echoes `Mcp-Session-Id`, and then checks a later tool call can still read `McpServer.clientCapabilities`.

- [#1639](https://github.com/Effect-TS/effect-smol/pull/1639) [`407c3b4`](https://github.com/Effect-TS/effect-smol/commit/407c3b43a5d1414558e0e33b6f1fc0e6a6d489cc) Thanks @tim-smart! - Add `Scheduler.PreventSchedulerYield` and expose it via `References` so fibers can skip scheduler `shouldYield` checks when needed.

- [#1649](https://github.com/Effect-TS/effect-smol/pull/1649) [`e741322`](https://github.com/Effect-TS/effect-smol/commit/e74132226cbfee24234311c7c1c13e6b7391384e) Thanks @tim-smart! - Set `Schema.TaggedErrorClass` instance `name` to the tag value, matching `Data.TaggedError` behavior.

- [#1646](https://github.com/Effect-TS/effect-smol/pull/1646) [`5c75fa8`](https://github.com/Effect-TS/effect-smol/commit/5c75fa8fb71163bc4c035ba1a215574dfd4badfc) Thanks @tim-smart! - Simplify internal and documented request usage by passing request resolvers directly to `Effect.request` instead of wrapping them with `Effect.succeed`.

- [#1641](https://github.com/Effect-TS/effect-smol/pull/1641) [`747177b`](https://github.com/Effect-TS/effect-smol/commit/747177b0602f12d4461a843e953dfdffbeb0a429) Thanks @tim-smart! - Don't transform Tool result schemas, as they aren't sent to the providers as
  json schemas

- [#1636](https://github.com/Effect-TS/effect-smol/pull/1636) [`326cd48`](https://github.com/Effect-TS/effect-smol/commit/326cd4828bce573fe985f35152155464bf4c5a70) Thanks @tim-smart! - Add `Cookies.expireCookie` / `expireCookieUnsafe` and `HttpServerResponse.expireCookie` / `expireCookieUnsafe` for emitting expired cookies.

- [#1653](https://github.com/Effect-TS/effect-smol/pull/1653) [`627e922`](https://github.com/Effect-TS/effect-smol/commit/627e922b8d1e9521eae5e1caa5d667ad00b1619a) Thanks @tim-smart! - expose mcp client capabilities

- [#1660](https://github.com/Effect-TS/effect-smol/pull/1660) [`662287e`](https://github.com/Effect-TS/effect-smol/commit/662287e9abc76c941ccc2ee330aa07904d571341) Thanks @tim-smart! - Add `HttpServerResponse.toClientResponse` for converting server responses into `HttpClientResponse` values.

## 4.0.0-beta.27

### Patch Changes

- [#1621](https://github.com/Effect-TS/effect-smol/pull/1621) [`903a839`](https://github.com/Effect-TS/effect-smol/commit/903a839e94239e6ec4568315af28e405bcad95f4) Thanks @kitlangton! - unstable/http Headers: add `removeMany` combinator for removing multiple headers at once

- [#1622](https://github.com/Effect-TS/effect-smol/pull/1622) [`91a0168`](https://github.com/Effect-TS/effect-smol/commit/91a016836680a6669308ecf464d3584bcc4ae1b7) Thanks @tim-smart! - Add `Model.BooleanSqlite`, a model field schema that uses `0 | 1` encoding for database variants and plain `boolean` encoding for JSON variants.

- [#1631](https://github.com/Effect-TS/effect-smol/pull/1631) [`c890f9a`](https://github.com/Effect-TS/effect-smol/commit/c890f9a1b3a989ed22528bd5a43326342e05b142) Thanks @gcanti! - unstable/httpapi HttpApiBuilder: fix void responses producing a non-empty body instead of `Response.empty`, closes #1628.

- [#1618](https://github.com/Effect-TS/effect-smol/pull/1618) [`1e985f2`](https://github.com/Effect-TS/effect-smol/commit/1e985f237d250b51b91de22dde77160c1e778ce7) Thanks @tim-smart! - Default `Effect.context()` to `Effect.context<never>()` when no type parameter is provided.

## 4.0.0-beta.26

### Patch Changes

- [#1603](https://github.com/Effect-TS/effect-smol/pull/1603) [`fb21462`](https://github.com/Effect-TS/effect-smol/commit/fb21462642cdd5b1bada92f3eba18ae20445be42) Thanks @tim-smart! - Add `responseText` to `AiError.StructuredOutputError` and populate it from `LanguageModel.generateObject` so failed structured output decodes include the full LLM text.

- [#1613](https://github.com/Effect-TS/effect-smol/pull/1613) [`2ed26b1`](https://github.com/Effect-TS/effect-smol/commit/2ed26b139805700e3df39efaa768ff01565e5c86) Thanks @lucas-barake! - Add `disableFatalDefects` to `RpcServer.layerHttp`, `RpcServer.toHttpEffect`, and `RpcServer.toHttpEffectWebsocket` option types to match existing runtime support.

- [#1599](https://github.com/Effect-TS/effect-smol/pull/1599) [`e832a57`](https://github.com/Effect-TS/effect-smol/commit/e832a57b570fe38f010c1fd99bceac5a325a9e07) Thanks @tim-smart! - add trait for customizing exit codes

- [#1611](https://github.com/Effect-TS/effect-smol/pull/1611) [`7f01be7`](https://github.com/Effect-TS/effect-smol/commit/7f01be7f8db363d4b2e88e6b5571e96bb815786f) Thanks @WebWalks! - Fixed the Error Type on AtomHttpApiClient (Server errors were being incorrectly reported, and we could not determine \_tag to handle)

- [#1612](https://github.com/Effect-TS/effect-smol/pull/1612) [`e965143`](https://github.com/Effect-TS/effect-smol/commit/e9651431e114479e6becf8ca7b1ed99ac7e91ccc) Thanks @tim-smart! - Expose the optional `orElse` fallback parameter in `Effect.catchTags`.

- [#1606](https://github.com/Effect-TS/effect-smol/pull/1606) [`b9b80f1`](https://github.com/Effect-TS/effect-smol/commit/b9b80f1f15e152ceef0a727d150b7dc230abae99) Thanks @gcanti! - Schema: `toJsonSchemaDocument` now emits JSON Schema `false` for unannotated
  `Never` index signatures (including `additionalProperties`) instead of `{ not: {} }`.
  Annotated `Never` still emits a schema object so metadata like `description` is preserved.

- [#1607](https://github.com/Effect-TS/effect-smol/pull/1607) [`98252aa`](https://github.com/Effect-TS/effect-smol/commit/98252aa0c0b17fc73fbdad65d0a1104965f9fc0f) Thanks @gcanti! - Schema: improve `Schema.Unknown` / `Schema.ObjectKeyword` handling in `toCodecJson` and `toCodecStringTree`

- [#1616](https://github.com/Effect-TS/effect-smol/pull/1616) [`56fbd94`](https://github.com/Effect-TS/effect-smol/commit/56fbd94311ad19a05001ad649d9e34ab00c74541) Thanks @lucas-barake! - Add `Atom.swr` to `effect/unstable/reactivity` for staleTime-gated stale-while-revalidate reads, optional mount and window-focus revalidation, and forceful manual refresh.

- [#1600](https://github.com/Effect-TS/effect-smol/pull/1600) [`3faa109`](https://github.com/Effect-TS/effect-smol/commit/3faa109b7d093fbf14ad410d3e11d663f16e28f1) Thanks @tim-smart! - add args to Stdio service

- [#1610](https://github.com/Effect-TS/effect-smol/pull/1610) [`692ecfe`](https://github.com/Effect-TS/effect-smol/commit/692ecfed99fe58056b7a5afe001f4fcd1a61c446) Thanks @kitlangton! - Refine unstable CLI parent/subcommand flag composition.
  - Add `Command.withSharedFlags` conflict validation against existing subcommands, including the `withSubcommands(...).withSharedFlags(...)` composition order.
  - Reorder `Command` type parameters to `Command<Name, Input, ContextInput, E, R>` for clearer parent-context modeling.
  - Make `Command.withSubcommands` input typing sound for downstream input-based combinators by reflecting that subcommand paths only carry parent context input.

- [#1604](https://github.com/Effect-TS/effect-smol/pull/1604) [`1e70b72`](https://github.com/Effect-TS/effect-smol/commit/1e70b72d0b210474d0e96a15a5cfc279eae37e0c) Thanks @lucas-barake! - Fix `unstable/sql/SqlSchema` request input typing so `findAll` and `findNonEmpty` accept `Request["Type"]` instead of `Request["Encoded"]`.

- [#1602](https://github.com/Effect-TS/effect-smol/pull/1602) [`ecf0782`](https://github.com/Effect-TS/effect-smol/commit/ecf07829ef2dfc01d8943c96c4fe9c1b44b97926) Thanks @tim-smart! - Replace the default HttpApi schema-validation error with `HttpApiError.BadRequestNoContent`.

## 4.0.0-beta.25

### Patch Changes

- [#1597](https://github.com/Effect-TS/effect-smol/pull/1597) [`fa17bb5`](https://github.com/Effect-TS/effect-smol/commit/fa17bb5be9f2533d01e11322b14804c7dec43714) Thanks @tim-smart! - Fix `Effect.forkScoped` data-first typings to include `Scope` in requirements.

- [#1598](https://github.com/Effect-TS/effect-smol/pull/1598) [`f46e5b5`](https://github.com/Effect-TS/effect-smol/commit/f46e5b5ca2a918ee4d9270167e79db223077c96f) Thanks @tim-smart! - compare transaction connections by reference

- [#1596](https://github.com/Effect-TS/effect-smol/pull/1596) [`ce4767c`](https://github.com/Effect-TS/effect-smol/commit/ce4767cadcacc6ce8ff4c3a0d0fbc82ede655f63) Thanks @tim-smart! - improve HttpClient.withRateLimiter initial state tracking

- [#1594](https://github.com/Effect-TS/effect-smol/pull/1594) [`c830a8b`](https://github.com/Effect-TS/effect-smol/commit/c830a8b6c292a6528d7f9318759d34800b00372d) Thanks @tim-smart! - HttpClient.withRateLimiter adds delay from retry-after headers

## 4.0.0-beta.24

### Patch Changes

- [#1586](https://github.com/Effect-TS/effect-smol/pull/1586) [`a909e1c`](https://github.com/Effect-TS/effect-smol/commit/a909e1c1ac2bc707527f5073776e3e7d239688d9) Thanks @gcanti! - Schema: add `Chunk` schema, closes #1585.

- [#1588](https://github.com/Effect-TS/effect-smol/pull/1588) [`8814a4e`](https://github.com/Effect-TS/effect-smol/commit/8814a4ef78d67144d27689370af10099ea210399) Thanks @gcanti! - Fix `Schema.toTaggedUnion` discriminant detection for class-based schemas, including unique symbol tags, closes #1584.

- [#1591](https://github.com/Effect-TS/effect-smol/pull/1591) [`3f942c5`](https://github.com/Effect-TS/effect-smol/commit/3f942c51cefa7b2ffa7c49e8c8a2c887570ba4c0) Thanks @tim-smart! - Add `HttpClient.withRateLimiter` for integrating the `RateLimiter` service with HTTP clients, including optional response-header driven limit updates and automatic 429 retry behavior.

- [#1583](https://github.com/Effect-TS/effect-smol/pull/1583) [`774ed59`](https://github.com/Effect-TS/effect-smol/commit/774ed59c52b2ab578bbb897c4f551f812231e1d2) Thanks @patroza! - feat: Support Reference classes

- [#1592](https://github.com/Effect-TS/effect-smol/pull/1592) [`f54b8d3`](https://github.com/Effect-TS/effect-smol/commit/f54b8d398fedad1815fd1f4c49814ab938cfc385) Thanks @tim-smart! - Fix `HttpApi.prefix` so it updates endpoint path types the same way `HttpApiGroup.prefix` does.

## 4.0.0-beta.23

### Patch Changes

- [#1561](https://github.com/Effect-TS/effect-smol/pull/1561) [`5c73c41`](https://github.com/Effect-TS/effect-smol/commit/5c73c41b69eaeab80fcd62c9bfda490b446d1966) Thanks @gcanti! - SchemaRepresentation: only create references for recursive/mutually recursive schemas and schemas with an `identifier` annotation, closes #1560.

## 4.0.0-beta.22

### Patch Changes

- [#1578](https://github.com/Effect-TS/effect-smol/pull/1578) [`0874332`](https://github.com/Effect-TS/effect-smol/commit/0874332f7c81118b06ac2eb105e0710211631479) Thanks @tim-smart! - Proxy function arity from `Effect.fn` APIs so wrapped functions preserve the original `length` value.

- [#1580](https://github.com/Effect-TS/effect-smol/pull/1580) [`c592dcd`](https://github.com/Effect-TS/effect-smol/commit/c592dcde0697e322065c8f418c0480ef910cb183) Thanks @tim-smart! - simplify Filter by removing Args type parameter

- [#1575](https://github.com/Effect-TS/effect-smol/pull/1575) [`1dbe28d`](https://github.com/Effect-TS/effect-smol/commit/1dbe28dac8299cd3e218c9768450cfd173b5e294) Thanks @tim-smart! - fix Chat constructor types

- [#1581](https://github.com/Effect-TS/effect-smol/pull/1581) [`564d730`](https://github.com/Effect-TS/effect-smol/commit/564d730b6bbf38dd8548a3b046e7a693b28699a4) Thanks @tim-smart! - fix Duration.toMillis regression

- [#1579](https://github.com/Effect-TS/effect-smol/pull/1579) [`3cfadc4`](https://github.com/Effect-TS/effect-smol/commit/3cfadc458b070c6cba6c5674b72a059f1e49118b) Thanks @tim-smart! - Remove fiber-level keep-alive intervals and keep the process alive from `Runtime.makeRunMain` instead.

- [#1571](https://github.com/Effect-TS/effect-smol/pull/1571) [`6634fd0`](https://github.com/Effect-TS/effect-smol/commit/6634fd07da067d80b8261fb2959d1a952b9e412e) Thanks @tim-smart! - Add `HttpApiClient.urlBuilder` for type-safe endpoint URL construction from group + method/path keys.

- [#1573](https://github.com/Effect-TS/effect-smol/pull/1573) [`d10dabe`](https://github.com/Effect-TS/effect-smol/commit/d10dabeb7af9a368f995829cd36ad08167cd8f95) Thanks @tim-smart! - Expose a `chunkSize` option on `Stream.fromIterable` to control emitted chunk boundaries when constructing streams from iterables.

- [#1574](https://github.com/Effect-TS/effect-smol/pull/1574) [`f82f549`](https://github.com/Effect-TS/effect-smol/commit/f82f549a09e950e9d4987f279a800f4d953f0939) Thanks @tim-smart! - Fix AI tool handler error typing so `LanguageModel.generateText` with a toolkit exposes wrapped `AiError` values rather than leaking raw `AiErrorReason` in the error channel.

- [#1577](https://github.com/Effect-TS/effect-smol/pull/1577) [`78a3382`](https://github.com/Effect-TS/effect-smol/commit/78a3382ddfbe034408f7480fa794733d9e82147b) Thanks @tim-smart! - fix VariantSchema.Union

## 4.0.0-beta.21

### Patch Changes

- [#1555](https://github.com/Effect-TS/effect-smol/pull/1555) [`e691909`](https://github.com/Effect-TS/effect-smol/commit/e691909495ccb162ea7bfa351dd74632b99997cb) Thanks @tim-smart! - fix Stream.withSpan options

- [#1548](https://github.com/Effect-TS/effect-smol/pull/1548) [`d5f413f`](https://github.com/Effect-TS/effect-smol/commit/d5f413f3c8fc57f2413cc5649c2003d6d4e5a6d7) Thanks @effect-bot! - Fix `TxPubSub.publish` and `TxPubSub.publishAll` overloads to require `Effect.Transaction` in their return environment.

- [#1557](https://github.com/Effect-TS/effect-smol/pull/1557) [`139d152`](https://github.com/Effect-TS/effect-smol/commit/139d152941e562a073b5be12e8d66c8a4d4a8a57) Thanks @A386official! - Fix MCP resource template parameter names resolving as `param0`, `param1` instead of actual names by checking `isParam` on the original schema before `toCodecStringTree` transformation.

- [#1547](https://github.com/Effect-TS/effect-smol/pull/1547) [`947e3d4`](https://github.com/Effect-TS/effect-smol/commit/947e3d436ab8a017efda9b29be523efd1ca8df28) Thanks @effect-bot! - Fix `Schedule.reduce` to persist state updates when the combine function returns a synchronous value.

- [#1545](https://github.com/Effect-TS/effect-smol/pull/1545) [`84b2cce`](https://github.com/Effect-TS/effect-smol/commit/84b2ccefe2aa3a7413b86738a4dc33cdb311ca55) Thanks @effect-bot! - Fix TupleWithRest post-rest validation to check each tail index sequentially.

- [#1552](https://github.com/Effect-TS/effect-smol/pull/1552) [`7f5305e`](https://github.com/Effect-TS/effect-smol/commit/7f5305e69f5a33309e77b08a576edb25d7daaee2) Thanks @tim-smart! - Constrain `HttpServerRequest.source` to `object` and key server-side request weak caches by `request.source` so middleware request wrappers share the same cache entries.

- [#1556](https://github.com/Effect-TS/effect-smol/pull/1556) [`9e6fd84`](https://github.com/Effect-TS/effect-smol/commit/9e6fd8471c93a3c643929151a3bdb62cb9c0ca0e) Thanks @tim-smart! - rename WorkflowEngine.layer

- [#1558](https://github.com/Effect-TS/effect-smol/pull/1558) [`fdb8a4b`](https://github.com/Effect-TS/effect-smol/commit/fdb8a4b172721fbefe98bd5aa6fe4f0efd1da3eb) Thanks @tim-smart! - Fix `Workflow.executionId` to use schema `makeUnsafe` instead of the removed `.make` API.

- [#1553](https://github.com/Effect-TS/effect-smol/pull/1553) [`0f986ef`](https://github.com/Effect-TS/effect-smol/commit/0f986ef22f196fe091a7afdbd179485a7d888882) Thanks @kaylynb! - Fix spans never having parent span

- [#1541](https://github.com/Effect-TS/effect-smol/pull/1541) [`9355fc0`](https://github.com/Effect-TS/effect-smol/commit/9355fc0ffb5b7382146a5aed9eea83974b10d007) Thanks @tim-smart! - Add `Effect.findFirst` and `Effect.findFirstFilter` for short-circuiting effectful searches over iterables.

## 4.0.0-beta.20

### Patch Changes

- [#1533](https://github.com/Effect-TS/effect-smol/pull/1533) [`842a624`](https://github.com/Effect-TS/effect-smol/commit/842a624f79d5e1407460b0ef3ab27d14d48ccf74) Thanks @tim-smart! - move ChildProcess apis into spawner service

- [#1536](https://github.com/Effect-TS/effect-smol/pull/1536) [`4785eef`](https://github.com/Effect-TS/effect-smol/commit/4785eef5d7cf1edb96ef2509aed2ba4d1edf3862) Thanks @tim-smart! - add Context.Key type, used a base for Context.Service and Context.Reference

- [#1531](https://github.com/Effect-TS/effect-smol/pull/1531) [`8fac95b`](https://github.com/Effect-TS/effect-smol/commit/8fac95bd9e0338b7a82da8da579c1ac22afa045c) Thanks @gcanti! - Revert `Config.withDefault` to v3 behavior, closes #1530.

  Make `Config.withDefault` accept an eager value instead of `LazyArg`, aligning with CLI module conventions.

- [#1535](https://github.com/Effect-TS/effect-smol/pull/1535) [`12ee8e2`](https://github.com/Effect-TS/effect-smol/commit/12ee8e27df7eb393d83a5e403390d0cfc82ca732) Thanks @tim-smart! - change default ErrorReporter severity to Info

- [#1529](https://github.com/Effect-TS/effect-smol/pull/1529) [`e542c94`](https://github.com/Effect-TS/effect-smol/commit/e542c942bee4729138b02222f4421220a90a57d8) Thanks @tim-smart! - Add dedicated AiError metadata interfaces per reason so provider packages can safely augment metadata without conflicting module declarations.

- [#1531](https://github.com/Effect-TS/effect-smol/pull/1531) [`8fac95b`](https://github.com/Effect-TS/effect-smol/commit/8fac95bd9e0338b7a82da8da579c1ac22afa045c) Thanks @gcanti! - Fix `Config.withDefault` type inference, closes #1530.

- [#1528](https://github.com/Effect-TS/effect-smol/pull/1528) [`6f4ebd1`](https://github.com/Effect-TS/effect-smol/commit/6f4ebd193c2595983394127dd808601b75430d34) Thanks @tim-smart! - Add `Model.ModelName` and provide it from AI model constructors.

- [#1537](https://github.com/Effect-TS/effect-smol/pull/1537) [`989d1cc`](https://github.com/Effect-TS/effect-smol/commit/989d1cca936fce0cc459057825ba40e3f5ef3827) Thanks @tim-smart! - Revert `Effect.partition` to Effect v3 behavior by accumulating failures from the effect error channel and never failing.

## 4.0.0-beta.19

## 4.0.0-beta.18

### Minor Changes

- [#1515](https://github.com/Effect-TS/effect-smol/pull/1515) [`01e31fd`](https://github.com/Effect-TS/effect-smol/commit/01e31fdf8e5206849d23cbafd23a346f2f177ab8) Thanks @mikearnaldi! - Add transactional STM modules: TxDeferred, TxPriorityQueue, TxPubSub, TxReentrantLock, TxSubscriptionRef.

  Refactor transaction model: remove `Effect.atomic`/`Effect.atomicWith`, add `Effect.withTxState`. All Tx operations now return `Effect<A, E, Transaction>` requiring explicit `Effect.transaction(...)` at boundaries.

  Expose `TxPubSub.acquireSubscriber`/`releaseSubscriber` for composable transaction boundaries. Fix `TxSubscriptionRef.changes` race condition ensuring current value is delivered first.

  Remove `TxRandom` module.

### Patch Changes

- [#1518](https://github.com/Effect-TS/effect-smol/pull/1518) [`0890aab`](https://github.com/Effect-TS/effect-smol/commit/0890aab15ed9c5ba52c383a72fdc6a444d7504d5) Thanks @IMax153! - Fix `Command.withGlobalFlags` type inference when mixing `GlobalFlag.action` and `GlobalFlag.setting`.

  `Setting` service identifiers are now correctly removed from command requirements in mixed global flag arrays.

- [#1520](https://github.com/Effect-TS/effect-smol/pull/1520) [`725260b`](https://github.com/Effect-TS/effect-smol/commit/725260b53f5142d6af7a93a2f9f464f974eda92d) Thanks @IMax153! - Ensure that OpenAI JSON schemas for tool calls and structured outputs are properly transformed

## 4.0.0-beta.17

### Patch Changes

- [#1516](https://github.com/Effect-TS/effect-smol/pull/1516) [`8f59c32`](https://github.com/Effect-TS/effect-smol/commit/8f59c32922597a48392744f7203e284866747781) Thanks @gcanti! - Fix `Schema.encodeKeys` to encode non-remapped struct fields during encoding.

## 4.0.0-beta.16

### Patch Changes

- [#1513](https://github.com/Effect-TS/effect-smol/pull/1513) [`bf9096c`](https://github.com/Effect-TS/effect-smol/commit/bf9096c52a7d8791d93d232739e523eb84f6625a) Thanks @gcanti! - Add `SchemaParser.makeOption` and `Schema.makeOption` for constructing schema values as `Option`.

- [#1508](https://github.com/Effect-TS/effect-smol/pull/1508) [`29f81ca`](https://github.com/Effect-TS/effect-smol/commit/29f81ca07c67dba265804b140a7487fb15a5fc6b) Thanks @gcanti! - Schema: add `OptionFromUndefinedOr` and `OptionFromNullishOr` schemas.

- [#1498](https://github.com/Effect-TS/effect-smol/pull/1498) [`68eb28c`](https://github.com/Effect-TS/effect-smol/commit/68eb28c2b0fc67a9f6204ade9bd16c5b37803bfb) Thanks @kaylynb! - Fix OpenApi Multipart file upload schema generation

## 4.0.0-beta.15

### Patch Changes

- [#1500](https://github.com/Effect-TS/effect-smol/pull/1500) [`24ae609`](https://github.com/Effect-TS/effect-smol/commit/24ae60995d2fd7d621be356cdfdfd328c79639ba) Thanks @qadama831! - Unwrap `_Success` schema to enable field access.

- [#1486](https://github.com/Effect-TS/effect-smol/pull/1486) [`0e3c059`](https://github.com/Effect-TS/effect-smol/commit/0e3c059987caa55ebd0c134f7c7b147c639c328e) Thanks @tim-smart! - Fix `Stream.groupedWithin` to stop emitting empty arrays when schedule ticks fire while upstream is idle.

- [#1503](https://github.com/Effect-TS/effect-smol/pull/1503) [`e843b0a`](https://github.com/Effect-TS/effect-smol/commit/e843b0a7d7e7b600a0b3bd477f24e2e4cd26bc8b) Thanks @tim-smart! - allow creating standalone http handlers from HttpApiEndpoints

- [#1499](https://github.com/Effect-TS/effect-smol/pull/1499) [`f4389a2`](https://github.com/Effect-TS/effect-smol/commit/f4389a2cca3c5bbf00d69779f52ce41255f15a28) Thanks @tim-smart! - fix atom node timeout cleanup

- [#1494](https://github.com/Effect-TS/effect-smol/pull/1494) [`5b73de0`](https://github.com/Effect-TS/effect-smol/commit/5b73de095b3402d0c5c74092ace6ce18ebfad566) - Refine `ExtractServices` to omit tool handler requirements when automatic tool resolution is explicitly disabled through the `disableToolCallResolution` option.

- [#1496](https://github.com/Effect-TS/effect-smol/pull/1496) [`595d2d6`](https://github.com/Effect-TS/effect-smol/commit/595d2d6e7d50419f3532bd39266191532ace38f2) Thanks @IMax153! - Refactor unstable CLI global flags to command-scoped declarations.

  ### Breaking changes
  - Remove `GlobalFlag.add`, `GlobalFlag.remove`, and `GlobalFlag.clear`
  - Add `Command.withGlobalFlags(...)` as the declaration API for command/subcommand scope
  - Change `GlobalFlag.setting` constructor to curried form which carries type-level identifier:
    - before: `GlobalFlag.setting({ flag, ... })`
    - after: `GlobalFlag.setting("id")({ flag })`
  - Change setting context identity to a stable type-level string:
    - `effect/unstable/cli/GlobalFlag/${id}`

  ### Behavior changes
  - Global flags are now scoped by command path (root-to-leaf declarations)
  - Out-of-scope global flags are rejected for the selected subcommand path
  - Help now renders only global flags active for the requested command path
  - Setting defaults are sourced from `Flag` combinators (`optional`, `withDefault`) rather than setting constructor defaults

## 4.0.0-beta.14

### Patch Changes

- [#1471](https://github.com/Effect-TS/effect-smol/pull/1471) [`c414700`](https://github.com/Effect-TS/effect-smol/commit/c414700ef1932e4b67d0102856de417336912350) Thanks @IMax153! - Make CLI global settings directly yieldable and simplify built-in names.

  `GlobalFlag.setting` now takes `{ flag, defaultValue }` and returns a setting that is a `Context.Reference`, so handlers and `Command.provide*` effects can `yield*` global setting values directly.

  Built-in settings keep internal behavior in `runWith` (for example, `--log-level` still configures `References.MinimumLogLevel`) while also being readable as values.

  Also renamed built-in globals:
  - `GlobalFlag.CompletionsFlag` -> `GlobalFlag.Completions`
  - `GlobalFlag.LogLevelFlag` -> `GlobalFlag.LogLevel`

- [#1490](https://github.com/Effect-TS/effect-smol/pull/1490) [`a30c969`](https://github.com/Effect-TS/effect-smol/commit/a30c9699c0d736cf3952041e45d508b7d58907a9) Thanks @gcanti! - Fix `OpenApi.fromApi` preserving multiple response content types for one status code, closes #1485.

## 4.0.0-beta.13

### Patch Changes

- [#1454](https://github.com/Effect-TS/effect-smol/pull/1454) [`368f4c3`](https://github.com/Effect-TS/effect-smol/commit/368f4c363dd117e6f5a19ad77b161176cfd29fdd) Thanks @lucas-barake! - Expose `NoSuchElementError` in the error type of stream-based `Atom.make` overloads.

- [#1469](https://github.com/Effect-TS/effect-smol/pull/1469) [`db8a579`](https://github.com/Effect-TS/effect-smol/commit/db8a579e93e93ff73b1e60712732e03b597b916b) Thanks @tim-smart! - Update unstable schema variant helpers to use array-based arguments for `FieldOnly`, `FieldExcept`, and `Union`, aligning `VariantSchema` and `Model` with other v4 API shapes.

- [#1457](https://github.com/Effect-TS/effect-smol/pull/1457) [`668b703`](https://github.com/Effect-TS/effect-smol/commit/668b70337e9ddbb0d1ae2282a95c282ce404e562) Thanks @tim-smart! - Run request resolver batch fibers with request services by using `Effect.runForkWith`, so resolver delay effects and `runAll` execution see the request service map.

- [#1461](https://github.com/Effect-TS/effect-smol/pull/1461) [`d40e76b`](https://github.com/Effect-TS/effect-smol/commit/d40e76b973543979e60e04a6baca04a8c65bdfc2) Thanks @mikearnaldi! - Fix `Schedule.fixed` double-executing the effect due to clock jitter.

  The `elapsedSincePrevious > window` check included sleep time from the
  previous step, so any timer imprecision (e.g. 1001ms for a 1000ms sleep)
  triggered an immediate zero-delay re-execution.

- [#1464](https://github.com/Effect-TS/effect-smol/pull/1464) [`6e18cf8`](https://github.com/Effect-TS/effect-smol/commit/6e18cf883e9905ca718a6697b6a2a4bbd42739aa) Thanks @gcanti! - Use the `identifier` annotation as the expected message when available, closes #1458.

- [#1475](https://github.com/Effect-TS/effect-smol/pull/1475) [`86062e8`](https://github.com/Effect-TS/effect-smol/commit/86062e8a0c61bca5412fc40d2cf151d676901f08) Thanks @tim-smart! - Add a CI check job that runs `pnpm ai-docgen` and fails if it produces uncommitted changes.

- [#1448](https://github.com/Effect-TS/effect-smol/pull/1448) [`c27ce75`](https://github.com/Effect-TS/effect-smol/commit/c27ce75d34c74dcfc6dba1bf77f1ce88f410a0de) Thanks @IMax153! - Refactor CLI built-in options to use Effect services with `GlobalFlag`

  Built-in CLI flags (`--help`, `--version`, `--completions`, `--log-level`) are now implemented as Effect services using `Context.Reference`. This provides:
  - **Visibility**: Built-in flags now appear in help output's "GLOBAL FLAGS" section
  - **Extensibility**: Users can register custom global flags via `GlobalFlag.add`
  - **Override capability**: Built-in flag behavior can be replaced or disabled
  - **Composability**: Flags compose via Effect's service system

  New `GlobalFlag` module exports:
  - `Action<A>` and `Setting<A>` types for different flag behaviors
  - `Help`, `Version`, `Completions`, `LogLevel` references for built-in flags
  - `add`, `remove`, `clear` functions for managing global flags

  Example:

  ```typescript
  const app = Command.make("myapp");
  Command.run(app, { version: "1.0.0" }).pipe(
    GlobalFlag.add(CustomFlag, customFlagValue),
  );
  ```

- [#1468](https://github.com/Effect-TS/effect-smol/pull/1468) [`e2d4fbf`](https://github.com/Effect-TS/effect-smol/commit/e2d4fbfeeda6a5d2a4c5aeb0501d8240c248b9eb) Thanks @lucas-barake! - Fix `Rpc.ExtractProvides` to use middleware service ID instead of constructor type.

- [#1465](https://github.com/Effect-TS/effect-smol/pull/1465) [`114ab42`](https://github.com/Effect-TS/effect-smol/commit/114ab42ad0edc590d29169675a493e0e915aa58f) Thanks @lloydrichards! - tighten Schema on \_meta fields in McpSchema; closes #1463

- [#1470](https://github.com/Effect-TS/effect-smol/pull/1470) [`484caec`](https://github.com/Effect-TS/effect-smol/commit/484caec47cccac8b86db2910742e406dfc7173ab) Thanks @tim-smart! - Add `Command.withAlias` for unstable CLI commands, including subcommand parsing by alias and help output that renders aliases as `name, alias` in subcommand listings.

## 4.0.0-beta.12

### Patch Changes

- [#1439](https://github.com/Effect-TS/effect-smol/pull/1439) [`70a74e8`](https://github.com/Effect-TS/effect-smol/commit/70a74e88a8767c9d4acdb9e5f25aec9a33588d07) Thanks @gcanti! - Add `Config.nested` combinator to scope a config under a named prefix, closes #1437.

- [#1452](https://github.com/Effect-TS/effect-smol/pull/1452) [`b5b6e10`](https://github.com/Effect-TS/effect-smol/commit/b5b6e10621d54bf8c9857fec0d647ced78ecd857) Thanks @tim-smart! - make fiber keepAlive setInterval evaluation lazy

- [#1431](https://github.com/Effect-TS/effect-smol/pull/1431) [`f5ce5a9`](https://github.com/Effect-TS/effect-smol/commit/f5ce5a915359c6ebf254079e1da23cab6cde34fb) Thanks @tim-smart! - Add `Random.nextBoolean` for generating random boolean values.

- [#1450](https://github.com/Effect-TS/effect-smol/pull/1450) [`a29eb70`](https://github.com/Effect-TS/effect-smol/commit/a29eb702ffe3fc58bd28c4d7857298cd65d73668) Thanks @tim-smart! - use cause annotations for detecting client aborts

- [#1445](https://github.com/Effect-TS/effect-smol/pull/1445) [`c7b36e5`](https://github.com/Effect-TS/effect-smol/commit/c7b36e541a23e9a00f64e25b23851e51a37dfce5) Thanks @mattiamanzati! - Fix `Graph.toMermaid` to escape special characters using HTML entity codes per the Mermaid specification.

- [#1443](https://github.com/Effect-TS/effect-smol/pull/1443) [`9381d6d`](https://github.com/Effect-TS/effect-smol/commit/9381d6d4d9d819a81a46e56d0364c76e92a4fbca) Thanks @mikearnaldi! - Fix `HttpClient.retryTransient` autocomplete leaking `Schedule` internals by splitting the `{...} | Schedule` union into separate overloads.

- [#1444](https://github.com/Effect-TS/effect-smol/pull/1444) [`88439f1`](https://github.com/Effect-TS/effect-smol/commit/88439f13ca13549f3e4822c48c4f019c14fc2bcc) Thanks @gcanti! - Schema.encodeKeys: relax input constraint from Struct to schemas with fields so Schema.Class works, closes #1412.

- [#1438](https://github.com/Effect-TS/effect-smol/pull/1438) [`e35307d`](https://github.com/Effect-TS/effect-smol/commit/e35307dbeb8eb26a9923f958b894a8eaaf259bf2) Thanks @mikearnaldi! - Atom.searchParam: decode initial URL values correctly when a schema is provided

- [#1425](https://github.com/Effect-TS/effect-smol/pull/1425) [`c7df4bc`](https://github.com/Effect-TS/effect-smol/commit/c7df4bce34009474c63d62a807abfdafb76971eb) Thanks @candrewlee14! - Fix LanguageModel stripping of resolved approval artifacts across multi-round conversations.

  Previously, `stripResolvedApprovals` only ran when there were pending approvals
  in the current round. Stale artifacts from earlier rounds would leak to the
  provider, causing errors. The stripping now runs unconditionally.

  In streaming mode, pre-resolved tool results are also emitted as stream parts
  so `Chat.streamText` persists them to history, preventing re-resolution on
  subsequent rounds.

- [#1453](https://github.com/Effect-TS/effect-smol/pull/1453) [`accaf3b`](https://github.com/Effect-TS/effect-smol/commit/accaf3be7ac8da36e2334c509c23b8c9e88ea160) Thanks @tim-smart! - allow mcp errors to be encoded correctly

- [#1440](https://github.com/Effect-TS/effect-smol/pull/1440) [`3e1c270`](https://github.com/Effect-TS/effect-smol/commit/3e1c2707bbdf67720af1509642b8ced195790882) Thanks @lloydrichards! - extend McpSchema to work with extensions

- [#1447](https://github.com/Effect-TS/effect-smol/pull/1447) [`6cd81f7`](https://github.com/Effect-TS/effect-smol/commit/6cd81f73baad86f5bbfa455a55d75cde71e9611a) Thanks @tim-smart! - remove all non-regional service usage

- [#1451](https://github.com/Effect-TS/effect-smol/pull/1451) [`f222da3`](https://github.com/Effect-TS/effect-smol/commit/f222da3cdb44554f3324c2c52d0d005ee575053e) Thanks @tim-smart! - Add `Effect.annotateLogsScoped` to apply log annotations for the current scope and automatically restore previous annotations when the scope closes.

- [#1434](https://github.com/Effect-TS/effect-smol/pull/1434) [`61f901d`](https://github.com/Effect-TS/effect-smol/commit/61f901d830005b66e22d1de889fda132aeea97cd) Thanks @tim-smart! - Fix JSON-RPC serialization to return an object for non-batched requests while preserving array responses for true batch requests.

## 4.0.0-beta.11

### Patch Changes

- [#1429](https://github.com/Effect-TS/effect-smol/pull/1429) [`88659ed`](https://github.com/Effect-TS/effect-smol/commit/88659edb26e3623d557dccfe914c2c949672da16) Thanks @tim-smart! - Add grouped subcommand support to `Command.withSubcommands`, including help output sections for named groups while keeping ungrouped commands under `SUBCOMMANDS`.

- [#1426](https://github.com/Effect-TS/effect-smol/pull/1426) [`f2915e8`](https://github.com/Effect-TS/effect-smol/commit/f2915e8e2efe80d50c281e53f297b9701d6dc199) Thanks @tim-smart! - Add `Effect.validate` for validating collections while accumulating all failures, equivalent to the v3 `Effect.validateAll` behavior.

- [#1430](https://github.com/Effect-TS/effect-smol/pull/1430) [`eb71ace`](https://github.com/Effect-TS/effect-smol/commit/eb71acebbe0f228e4920278013beee3b67d62310) Thanks @tim-smart! - Add `Command.withExamples` to attach concrete usage examples to CLI commands, expose them through `HelpDoc.examples`, and render them in the default help formatter.

- [#1415](https://github.com/Effect-TS/effect-smol/pull/1415) [`2a16999`](https://github.com/Effect-TS/effect-smol/commit/2a169996c7513d377ac47adbfd68e1490457135c) Thanks @mikearnaldi! - HashMap: compare HAMT bit positions as unsigned to preserve entry lookup when bit 31 is set

- [#1417](https://github.com/Effect-TS/effect-smol/pull/1417) [`d42dd52`](https://github.com/Effect-TS/effect-smol/commit/d42dd52f11203f8e749fb5d3ecf7153e4a5a6814) Thanks @mikearnaldi! - unstable/http Headers: hide inspectable prototype methods from for..in iteration to avoid invalid header names in runtime fetch polyfills

- [#1418](https://github.com/Effect-TS/effect-smol/pull/1418) [`339adaf`](https://github.com/Effect-TS/effect-smol/commit/339adaf850a62a892adebcb208c2d9dddf3b97b3) Thanks @mikearnaldi! - runtime: guard keepAlive setInterval / clearInterval so Effect.runPromise works in runtimes that block timer APIs

- [#1416](https://github.com/Effect-TS/effect-smol/pull/1416) [`de19645`](https://github.com/Effect-TS/effect-smol/commit/de1964526d01102dd1cb99c8cfdd3e8df1f49ef1) Thanks @mikearnaldi! - Queue.collect: stop duplicating drained messages by appending each batch once

- [#1413](https://github.com/Effect-TS/effect-smol/pull/1413) [`9b1dc3b`](https://github.com/Effect-TS/effect-smol/commit/9b1dc3bcf2a1b68d0a67e3465db5ad01a1a56997) Thanks @gcanti! - Fix `Schema.TupleWithRest` incorrectly accepting inputs with missing post-rest elements, closes #1410.

- [#1409](https://github.com/Effect-TS/effect-smol/pull/1409) [`e4cb2f5`](https://github.com/Effect-TS/effect-smol/commit/e4cb2f55b30f4771ec1bf613ced36d6d96464dd5) Thanks @tim-smart! - add ErrorReporter module

- [#1427](https://github.com/Effect-TS/effect-smol/pull/1427) [`8bced95`](https://github.com/Effect-TS/effect-smol/commit/8bced954ecb35d4489197a57b0efe927e7d75f49) Thanks @tim-smart! - Add `Command.annotate` and `Command.annotateMerge` to unstable CLI commands, and include command annotations in `HelpDoc` so custom help formatters can access command metadata.

- [#1401](https://github.com/Effect-TS/effect-smol/pull/1401) [`9431420`](https://github.com/Effect-TS/effect-smol/commit/94314207c8019918200fbcb97aec992219f801f0) Thanks @tim-smart! - Add `WorkflowEngine.layer`, an in-memory layer for the unstable workflow engine.

- [#1428](https://github.com/Effect-TS/effect-smol/pull/1428) [`948dca2`](https://github.com/Effect-TS/effect-smol/commit/948dca22e4f672ba7a6db57f9899272bec7c08b8) Thanks @tim-smart! - Add `Command.withShortDescription` and use short descriptions for CLI subcommand listings, with fallback to the full command description.

- [#1405](https://github.com/Effect-TS/effect-smol/pull/1405) [`d18e327`](https://github.com/Effect-TS/effect-smol/commit/d18e32765a2665e31ffb31e746bf983fcfac34c5) Thanks @candrewlee14! - Strip resolved tool approval artifacts from prompt before sending to provider, preventing errors when providers reject pre-resolved approval requests.

- [#1424](https://github.com/Effect-TS/effect-smol/pull/1424) [`ab512f7`](https://github.com/Effect-TS/effect-smol/commit/ab512f7be1c0e6b359da921e22cd4944e4c57d3e) Thanks @tim-smart! - expose more atom Node properties

## 4.0.0-beta.10

### Patch Changes

- [#1396](https://github.com/Effect-TS/effect-smol/pull/1396) [`371acab`](https://github.com/Effect-TS/effect-smol/commit/371acabb58d56f3a7a5e3e33d3d5fdc9f5573c74) Thanks @gcanti! - Add `unstable/encoding` subpath export.

- [#1392](https://github.com/Effect-TS/effect-smol/pull/1392) [`856d774`](https://github.com/Effect-TS/effect-smol/commit/856d7741f1e296dd5048c6ff2b44b95d023e6ae4) Thanks @tim-smart! - Fix a race in `Semaphore.take` where interruption could leak permits after a waiter was resumed.

- [#1388](https://github.com/Effect-TS/effect-smol/pull/1388) [`b9e9202`](https://github.com/Effect-TS/effect-smol/commit/b9e92023c38caa322975d77cfe83e2d34ac9305a) Thanks @tim-smart! - Export `Effect` do notation APIs (`Do`, `bindTo`, `bind`, and `let`) from `effect/Effect` and add runtime and type-level coverage.

- [#1387](https://github.com/Effect-TS/effect-smol/pull/1387) [`1d1a974`](https://github.com/Effect-TS/effect-smol/commit/1d1a974bd280c81bff5d4505491cda03ba7a3f36) Thanks @tim-smart! - short circuit when Fiber.joinAll is called with an empty iterable

- [#1386](https://github.com/Effect-TS/effect-smol/pull/1386) [`6bfe2a6`](https://github.com/Effect-TS/effect-smol/commit/6bfe2a659bc6335db75709931f405da45301cba2) Thanks @tim-smart! - simplify http logger disabling

- [#1381](https://github.com/Effect-TS/effect-smol/pull/1381) [`b12c811`](https://github.com/Effect-TS/effect-smol/commit/b12c81157be287b1649c210616a244b50ec094d2) Thanks @tim-smart! - Fix `UrlParams.Input` usage to accept interface-typed records in HTTP client and server helpers while keeping coercion constraints for url parameter values.

- [#1383](https://github.com/Effect-TS/effect-smol/pull/1383) [`d17d98a`](https://github.com/Effect-TS/effect-smol/commit/d17d98ad78e2b44d95ef434adab79ac3c35e75ab) Thanks @tim-smart! - Rename `HttpClient.retryTransient` option `mode` to `retryOn` and rename `"both"` to `"errors-and-responses"`.

- [#1399](https://github.com/Effect-TS/effect-smol/pull/1399) [`68c3c7c`](https://github.com/Effect-TS/effect-smol/commit/68c3c7cb1e06ed94fa5c4c123a234b4ccbfdecd8) Thanks @tim-smart! - Add `Random.shuffle` to shuffle iterables with seeded randomness support.

## 4.0.0-beta.9

### Patch Changes

- [#1376](https://github.com/Effect-TS/effect-smol/pull/1376) [`3386557`](https://github.com/Effect-TS/effect-smol/commit/338655731564a7be9f8859dedbf4d5bcac6eb350) Thanks @gcanti! - HttpApiEndpoint: relax `params`, `query`, and `headers` constraints to accept a full schema in addition to a record of fields.

- [#1379](https://github.com/Effect-TS/effect-smol/pull/1379) [`b6666e3`](https://github.com/Effect-TS/effect-smol/commit/b6666e3cf6bd44ba1a8704e65c256c30359cb422) Thanks @tim-smart! - Fix `AtomHttpApi.query` to forward v4 `params` / `query` request fields to `HttpApiClient` at runtime.
  Also align `AtomHttpApi` endpoint type inference with v4 `HttpApiEndpoint` params/query naming and add a regression test.

## 4.0.0-beta.8

### Patch Changes

- [#1371](https://github.com/Effect-TS/effect-smol/pull/1371) [`246e672`](https://github.com/Effect-TS/effect-smol/commit/246e672dbbd7848d60e0c78fd66671b2f10b3752) Thanks @IMax153! - Fix `ChildProcess` options type and implement `PgMigrator`

- [#1372](https://github.com/Effect-TS/effect-smol/pull/1372) [`807dec0`](https://github.com/Effect-TS/effect-smol/commit/807dec03801b4c58a6d00c237b6d98d6386911df) Thanks @pawelblaszczyk5! - Remove superfluous error from SqlSchema.findAll signature

## 4.0.0-beta.7

### Patch Changes

- [#1366](https://github.com/Effect-TS/effect-smol/pull/1366) [`a2bda6d`](https://github.com/Effect-TS/effect-smol/commit/a2bda6d4ef6de9d9b0c53ae2df5434f778d6161a) Thanks @tim-smart! - rename SqlSchema.findOne\* apis

- [#1360](https://github.com/Effect-TS/effect-smol/pull/1360) [`1f95a2b`](https://github.com/Effect-TS/effect-smol/commit/1f95a2b5aa9524bb38f4437f4691a664bf463ca1) Thanks @tim-smart! - Add `Schedule.jittered` to randomize schedule delays between 80% and 120% of the original delay.

- [#1364](https://github.com/Effect-TS/effect-smol/pull/1364) [`a8d5e79`](https://github.com/Effect-TS/effect-smol/commit/a8d5e792fec201a83af0eb92fc79928d055125fd) Thanks @gcanti! - Schema: avoid eager resolution for type-level helpers, closes #1332

- [#1369](https://github.com/Effect-TS/effect-smol/pull/1369) [`a5386ba`](https://github.com/Effect-TS/effect-smol/commit/a5386ba67005dff697d45a45398f398773f58dcf) Thanks @tim-smart! - align HttpClientRequest constructors with http method names

- [#1369](https://github.com/Effect-TS/effect-smol/pull/1369) [`a5386ba`](https://github.com/Effect-TS/effect-smol/commit/a5386ba67005dff697d45a45398f398773f58dcf) Thanks @tim-smart! - remove body restriction for HttpClientRequest's

- [#1358](https://github.com/Effect-TS/effect-smol/pull/1358) [`06d8a03`](https://github.com/Effect-TS/effect-smol/commit/06d8a0391631e6130e3ab25227e59817852e227f) Thanks @tim-smart! - Add `LogLevel.isEnabled` for checking a log level against `References.MinimumLogLevel`.

- [#1363](https://github.com/Effect-TS/effect-smol/pull/1363) [`8caac76`](https://github.com/Effect-TS/effect-smol/commit/8caac76a35821edfe03c75dab5eb056e8fc05430) Thanks @tim-smart! - rename DurationInput to Duration.Input

- [#1363](https://github.com/Effect-TS/effect-smol/pull/1363) [`8caac76`](https://github.com/Effect-TS/effect-smol/commit/8caac76a35821edfe03c75dab5eb056e8fc05430) Thanks @tim-smart! - DateTime.distance now returns a Duration

- [#1367](https://github.com/Effect-TS/effect-smol/pull/1367) [`f9e883e`](https://github.com/Effect-TS/effect-smol/commit/f9e883e266fbda870336ee62f46b7ac85ba3de6e) Thanks @tim-smart! - refactor SqlSchema apis

- [#1363](https://github.com/Effect-TS/effect-smol/pull/1363) [`8caac76`](https://github.com/Effect-TS/effect-smol/commit/8caac76a35821edfe03c75dab5eb056e8fc05430) Thanks @tim-smart! - remove rpc client nesting to improve type performance

## 4.0.0-beta.6

### Patch Changes

- [#1338](https://github.com/Effect-TS/effect-smol/pull/1338) [`3247da2`](https://github.com/Effect-TS/effect-smol/commit/3247da28331f345f68be5dbd2974a7e03d300fe1) Thanks @Leka74! - Add `showOperationId` to `HttpApiScalar.ScalarConfig`.

- [#1326](https://github.com/Effect-TS/effect-smol/pull/1326) [`f205705`](https://github.com/Effect-TS/effect-smol/commit/f2057050dbd034b8c186be2d40c3d03ee63a5a3b) Thanks @gcanti! - Schema: add `BigDecimal` schema with comparison checks (`isGreaterThanBigDecimal`, `isGreaterThanOrEqualToBigDecimal`, `isLessThanBigDecimal`, `isLessThanOrEqualToBigDecimal`, `isBetweenBigDecimal`).

- [#1328](https://github.com/Effect-TS/effect-smol/pull/1328) [`f35022c`](https://github.com/Effect-TS/effect-smol/commit/f35022c212e4111527e1bb43f360a67b2b49fa85) Thanks @gcanti! - Schema: add `DateTimeZoned`, `TimeZoneOffset`, `TimeZoneNamed`, and `TimeZone` schemas.

- [#1325](https://github.com/Effect-TS/effect-smol/pull/1325) [`8622721`](https://github.com/Effect-TS/effect-smol/commit/86227217b02d43680a3c6f3c21731b1d852c91f5) Thanks @KhraksMamtsov! - Make `Data.Class`, `Data.TaggedClass`, and `Cause.YieldableError` pipeable.

- [#1323](https://github.com/Effect-TS/effect-smol/pull/1323) [`fc660ab`](https://github.com/Effect-TS/effect-smol/commit/fc660ab8b5ebae38b8d6b96cbf2f9b880cc09253) Thanks @KhraksMamtsov! - Port `Pipeable.Class` from v3.

  ```ts
  class MyClass extends Pipeable.Class() {
    constructor(public a: number) {
      super();
    }
    methodA() {
      return this.a;
    }
  }
  console.log(new MyClass(2).pipe((x) => x.methodA())); // 2
  ```

  ```ts
  class A {
    constructor(public a: number) {}
    methodA() {
      return this.a;
    }
  }
  class B extends Pipeable.Class(A) {
    constructor(private b: string) {
      super(b.length);
    }
    methodB() {
      return [this.b, this.methodA()];
    }
  }
  console.log(new B("pipe").pipe((x) => x.methodB())); // ['pipe', 4]
  ```

- [#1337](https://github.com/Effect-TS/effect-smol/pull/1337) [`f37dc33`](https://github.com/Effect-TS/effect-smol/commit/f37dc335f64622fa9ce8d6d1d5dd8fc3f260257b) Thanks @IMax153! - Encoding: consolidate `effect/encoding` sub-modules (Base64, Base64Url, Hex, EncodingError) into a top-level `Encoding` module. Functions are now prefixed: `encodeBase64`, `decodeBase64`, `encodeHex`, `decodeHex`, etc. The `effect/encoding` sub-path export is removed.

- [#1351](https://github.com/Effect-TS/effect-smol/pull/1351) [`3662f32`](https://github.com/Effect-TS/effect-smol/commit/3662f328fcfa3b2fa01ffa79da40e12e93fcede8) Thanks @tim-smart! - add `Schema.HashSet` for decoding and encoding `HashSet` values.

- [#1336](https://github.com/Effect-TS/effect-smol/pull/1336) [`a7d436f`](https://github.com/Effect-TS/effect-smol/commit/a7d436f438dcd7f49b9485e4e95a4511f31fad7d) Thanks @mikearnaldi! - Extract `Semaphore` and `Latch` into their own modules.

  `Semaphore.make` / `Semaphore.makeUnsafe` replace `Effect.makeSemaphore` / `Effect.makeSemaphoreUnsafe`.
  `Latch.make` / `Latch.makeUnsafe` replace `Effect.makeLatch` / `Effect.makeLatchUnsafe`.

  Merge `PartitionedSemaphore` into `Semaphore` as `Semaphore.Partitioned`, `Semaphore.makePartitioned`, `Semaphore.makePartitionedUnsafe`.

- [#1345](https://github.com/Effect-TS/effect-smol/pull/1345) [`6856a41`](https://github.com/Effect-TS/effect-smol/commit/6856a415d7eddd9d73d60919e976f1d071421be4) Thanks @tim-smart! - allocate less effects when reading a file

- [#1350](https://github.com/Effect-TS/effect-smol/pull/1350) [`8c417d0`](https://github.com/Effect-TS/effect-smol/commit/8c417d03475e5e12d00dca0c4781d0af7e66b86c) Thanks @tim-smart! - Add "Previously Known As" JSDoc migration notes for the `Semaphore` and `Latch` APIs extracted from `Effect`.

- [#1355](https://github.com/Effect-TS/effect-smol/pull/1355) [`5419570`](https://github.com/Effect-TS/effect-smol/commit/5419570ba47ce882a3a10882707b46f66e464906) Thanks @tim-smart! - ensure non-middleware http errors are correctly handled

- [#1352](https://github.com/Effect-TS/effect-smol/pull/1352) [`449c5ed`](https://github.com/Effect-TS/effect-smol/commit/449c5ed5318e8a874e730420bcf52918fa2ec80f) Thanks @tim-smart! - Add `Schema.HashMap` for decoding and encoding `HashMap` values.

- [#1347](https://github.com/Effect-TS/effect-smol/pull/1347) [`4b5ec12`](https://github.com/Effect-TS/effect-smol/commit/4b5ec12f87f95f2a3cd8fe4d5b26c6eb0529381a) Thanks @tim-smart! - use .toJSON for default .toString implementations

- [#1329](https://github.com/Effect-TS/effect-smol/pull/1329) [`df87937`](https://github.com/Effect-TS/effect-smol/commit/df879375fc3b169c43f9c434b3775e12b80dffe4) Thanks @gcanti! - Schema: extract shared `dateTimeUtcFromString` transformation for `DateTimeUtc` and `DateTimeUtcFromString`.

- [#1318](https://github.com/Effect-TS/effect-smol/pull/1318) [`5dbfca8`](https://github.com/Effect-TS/effect-smol/commit/5dbfca8d1dbb6d18d1605d4f8562e99c86e2ff11) Thanks @gcanti! - Schema: rename `$` suffix to `$` prefix for type-level identifiers that conflict with built-in names (`Array$` → `$Array`, `Record$` → `$Record`, `ReadonlyMap$` → `$ReadonlyMap`, `ReadonlySet$` → `$ReadonlySet`).

- [#1356](https://github.com/Effect-TS/effect-smol/pull/1356) [`e629497`](https://github.com/Effect-TS/effect-smol/commit/e6294973d55597ab6b6deca6babbe1e946b2c91d) Thanks @tim-smart! - allow passing void for request constructors

- [#1348](https://github.com/Effect-TS/effect-smol/pull/1348) [`981c991`](https://github.com/Effect-TS/effect-smol/commit/981c991cd78db34def815d5754379d737157f005) Thanks @tim-smart! - Fix `Schedule.andThenResult` to initialize the right schedule only after the left schedule completes.
  This removes the extra immediate transition tick and correctly completes when the right schedule is finite.

- [#1320](https://github.com/Effect-TS/effect-smol/pull/1320) [`1ca2ed6`](https://github.com/Effect-TS/effect-smol/commit/1ca2ed67301a5dc40ae0ed94346b99f26fd22bbe) Thanks @gcanti! - Struct: add `Struct.Record` constructor for creating records with the given keys and value.

- [#1342](https://github.com/Effect-TS/effect-smol/pull/1342) [`45722bd`](https://github.com/Effect-TS/effect-smol/commit/45722bde974458311f11ad237711363a10ec6894) Thanks @cevr! - `Schema.TaggedErrorClass`, `Schema.Class`, and `Schema.ErrorClass` constructors now allow omitting the props argument when all fields have constructor defaults (e.g. `new MyError()` instead of `new MyError({})`).

- [#1322](https://github.com/Effect-TS/effect-smol/pull/1322) [`eb2a85e`](https://github.com/Effect-TS/effect-smol/commit/eb2a85ed4dc162b2535d304799333a5a20477fd0) Thanks @tim-smart! - Add a `requireServicesAt` option to `PersistedCache.make` so lookup-service requirements can be configured like `Cache`.

## 4.0.0-beta.5

### Patch Changes

- [#1317](https://github.com/Effect-TS/effect-smol/pull/1317) [`f6e133e`](https://github.com/Effect-TS/effect-smol/commit/f6e133e9a16b32317bd09ff08c12b97a0ae44600) Thanks @tim-smart! - support tag unions in Effect.catchTag/Reason

- [#1314](https://github.com/Effect-TS/effect-smol/pull/1314) [`e3893cc`](https://github.com/Effect-TS/effect-smol/commit/e3893ccf2632338c7d8e745f639dcd825a9d42f8) Thanks @zeyuri! - Fix `Atom.serializable` encode/decode for wire transfer.

  Use `Schema.toCodecJson` instead of `Schema.encodeSync`/`Schema.decodeSync` directly, so that encoded values are plain JSON objects that survive serialization roundtrips (JSON, seroval, etc.). Previously, `AsyncResult.Schema` encode produced instances with custom prototypes that were lost after wire transfer, causing decode to fail with "Expected AsyncResult" errors during SSR hydration.

- [#1315](https://github.com/Effect-TS/effect-smol/pull/1315) [`a88e206`](https://github.com/Effect-TS/effect-smol/commit/a88e206e44dc66ca5a2b45bedc797877c5dbb083) Thanks @tim-smart! - add Filter.reason api

- [#1314](https://github.com/Effect-TS/effect-smol/pull/1314) [`e3893cc`](https://github.com/Effect-TS/effect-smol/commit/e3893ccf2632338c7d8e745f639dcd825a9d42f8) Thanks @zeyuri! - Port ReactHydration to effect-smol.

  Add `Hydration` module to `effect/unstable/reactivity` with `dehydrate`, `hydrate`, and `toValues` for SSR state serialization. Add `HydrationBoundary` React component to `@effect/atom-react` with two-phase hydration (new atoms in render, existing atoms after commit).

## 4.0.0-beta.4

### Patch Changes

- [#1308](https://github.com/Effect-TS/effect-smol/pull/1308) [`c5a18ef`](https://github.com/Effect-TS/effect-smol/commit/c5a18ef44171e3880bf983faee74529908974b32) Thanks @tim-smart! - improve Schema.TaggedUnion .match auto completion

- [#1310](https://github.com/Effect-TS/effect-smol/pull/1310) [`bc6b885`](https://github.com/Effect-TS/effect-smol/commit/bc6b885b94d887a200657c0775dfa874dc15bc0c) Thanks @tim-smart! - Add `Schedule.duration`, a one-shot schedule that waits for the provided duration and then completes.

## 4.0.0-beta.3

### Patch Changes

- [#1303](https://github.com/Effect-TS/effect-smol/pull/1303) [`3a0cf36`](https://github.com/Effect-TS/effect-smol/commit/3a0cf36eff106ba48d74e133c1598cd40613e530) Thanks @tim-smart! - add Result.failVoid

- [#1307](https://github.com/Effect-TS/effect-smol/pull/1307) [`c4da328`](https://github.com/Effect-TS/effect-smol/commit/c4da328d32fad1d61e0e538f5d371edf61521d7e) Thanks @tim-smart! - Add `HttpClientRequest.bodyFormDataRecord` and `HttpBody.makeFormDataRecord` helpers for creating multipart form bodies from plain records.

## 4.0.0-beta.2

### Patch Changes

- [#1302](https://github.com/Effect-TS/effect-smol/pull/1302) [`a22ce73`](https://github.com/Effect-TS/effect-smol/commit/a22ce73b2bd9305b7ba665694d2255c0e6d5a8d0) Thanks @tim-smart! - allow undefined for VariantSchema.Overridable input

- [#1299](https://github.com/Effect-TS/effect-smol/pull/1299) [`ebdabf7`](https://github.com/Effect-TS/effect-smol/commit/ebdabf79ff4e62c8384aa8cf9a8d2787d536ee78) Thanks @tim-smart! - Port `SqlSchema.findOne` from effect v3 to return `Option` on empty results and add `SqlSchema.single` for the fail-on-empty behavior.

- [#1298](https://github.com/Effect-TS/effect-smol/pull/1298) [`8f663bb`](https://github.com/Effect-TS/effect-smol/commit/8f663bb121021bf12bd264e8ae385187cb7a5dae) Thanks @tim-smart! - Add `Effect.catchNoSuchElement`, a renamed port of v3 `Effect.optionFromOptional` that converts `NoSuchElementError` failures into `Option.none`.

## 4.0.0-beta.1

### Patch Changes

- [#1293](https://github.com/Effect-TS/effect-smol/pull/1293) [`0fecf70`](https://github.com/Effect-TS/effect-smol/commit/0fecf70048057623eed7c584a06671773a2b1743) Thanks @mikearnaldi! - Add `Effect.filter` support for synchronous `Filter.Filter` overloads and correctly handle non-effect `Result` return values at runtime.

- [#1294](https://github.com/Effect-TS/effect-smol/pull/1294) [`709569e`](https://github.com/Effect-TS/effect-smol/commit/709569ed76bead9ebb0670599e4d890a07ca5a43) Thanks @tim-smart! - Fix `Prompt.text` and related text prompts to initialize from `default` values so users can edit the default input directly.

## 4.0.0-beta.0

### Major Changes

- [#1183](https://github.com/Effect-TS/effect-smol/pull/1183) [`be642ab`](https://github.com/Effect-TS/effect-smol/commit/be642ab1b3b4cd49e53c9732d7aba1b367fddd66) Thanks @tim-smart! - v4 beta
