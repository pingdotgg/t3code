# Microsoft Pragmatic Rust Guidelines (digest)

Source: https://microsoft.github.io/rust-guidelines/ (version 2026.6, MIT licensed).
Ninety guidelines with `M-` codes, written for teams shipping Rust at scale, with a
chapter aimed at AI coding agents. Read this for error struct design, panic policy,
unsafe policy, async, workspace layout, performance, and what makes code easy for an
agent to work with. "Must" guidelines are hard constraints; "should" allows judgment;
the spirit counts over the letter.

## Universal

- **M-UPSTREAM-GUIDELINES**: follow the Rust API Guidelines, Style Guide, Design
  Patterns, and the UB reference. Especially C-CONV, C-GETTER, C-COMMON-TRAITS, C-CTOR
  (provide `Foo::new()` even with `Default`), C-FEATURE.
- **M-STATIC-VERIFICATION**: compiler lints, clippy, rustfmt, cargo-audit, cargo-hack,
  cargo-udeps, and Miri as check-in gates. Enable `[lints.rust]` such as
  `unsafe_op_in_unsafe_fn` and `missing_debug_implementations`, the clippy groups at
  `priority = -1`, and restriction lints like `undocumented_unsafe_blocks`,
  `allow_attributes_without_reason`, `map_err_ignore`.
- **M-LINT-OVERRIDE-EXPECT**: `#[expect(clippy::x, reason = "...")]` for local
  overrides; an unfulfilled `expect` warns, so stale suppressions are caught. `#[allow]`
  only for generated code and macros.
- **M-PUBLIC-DEBUG**: derive `Debug` on public types. Types holding secrets get a
  hand-written `Debug` (`UserSecret(...)`) plus a unit test asserting the secret never
  appears in output.
- **M-PUBLIC-DISPLAY**: types meant to be read, especially errors and string wrappers,
  implement `Display`. Same redaction rules as `Debug`.
- **M-SMALLER-CRATES**: when in doubt, split into more crates (faster builds, no cycles).
  `web_server`, `web_client`, `web_protocols` rather than one `web` crate with modules.
- **M-WEASEL-WORDS**: no `Service`, `Manager`, `Factory` suffixes. `Bookings` or
  `BookingDispatcher`; `Builder` instead of `Factory`; disposal is `Drop`, not a manager.
  Repeatable instantiation takes `impl Fn() -> Foo`.
- **M-SHORT-NAMES**: at most two short words per identifier. No module name baked into a
  type (`foo::Id`, not `foo::FooId`).
- **M-REGULAR-FN**: associated functions are for instance creation. Computation with no
  receiver is a free function, not `Database::check_parameters(p)`.
- **M-DOCUMENTED-MAGIC**: magic values get a comment on why the value was chosen, the
  effects of changing it, and the external systems involved. Prefer a named `const` with
  a doc comment.
- **M-LOG-STRUCTURED**: structured events with message templates, named
  `<component>.<operation>.<state>`, OpenTelemetry attribute names, PII redacted. Don't
  pre-format with `format!`.

## Libraries: interoperability

- **M-TYPES-SEND**: public types and the futures they produce are `Send`. Assert with
  `const _: () = assert_send::<Foo>();`. An `Rc` held across `.await` makes a future
  `!Send`.
- **M-ESCAPE-HATCHES**: wrappers around native handles provide
  `pub unsafe fn from_native(..)` plus `into_native` / `to_native`, with documented
  safety requirements.
- **M-DONT-LEAK-TYPES**: prefer std types in public APIs. Third-party types only behind a
  feature flag (`serde`) or with substantial benefit.
- **M-FOREIGN-REEXPORTS**: don't `pub use` another crate's items; users depend on it
  directly. Exceptions: umbrella crates, technical splits, hidden macro paths.
- **M-IMPL-ASREF**: parameters may take `impl AsRef<str>` / `AsRef<Path>` /
  `AsRef<[u8]>` when ownership isn't needed. Struct fields hold `String`, `PathBuf`.
- **M-IMPL-RANGEBOUNDS**: accept `impl RangeBounds<T>`, not `(low, high)` pairs, so
  callers write `1..3`, `1..`, `..`.
- **M-IMPL-IO**: write sans-IO functions. Synchronous one-shot I/O takes `impl Read` /
  `impl Write`; runtime-agnostic async takes `futures::io::AsyncRead`.

## Libraries: UX

- **M-SIMPLE-ABSTRACTIONS**: service-level public types don't expose nested type
  parameters. `Service<Backend>` is fine; `Service<Backend<Store>>` is not.
- **M-AVOID-WRAPPERS**: keep `Rc`, `Arc`, `Box`, `RefCell` out of public APIs; use `&T`,
  `&mut T`, `T`. Smart pointers only when fundamental or benchmarked.
- **M-DI-HIERARCHY**: prefer concrete types, then generics over narrow traits, then
  `dyn Trait` wrapped in a custom struct (`DynamicDataAccess(Arc<dyn DataAccess>)`).
  Don't port a C# `IDatabase` into `Rc<dyn Database>`. Test doubles: an enum with a
  `Mock(MockCtrl)` variant.
- **M-ERRORS-CANONICAL-STRUCTS**: errors are situation-specific structs, not one global
  enum. Each holds a `Backtrace`, an optional upstream cause, and helper methods
  (`config_file(&self) -> &Path`). Keep any `ErrorKind` private and expose `is_io()`
  style methods. Capture the backtrace in `new()` or `From`. `Display` prints a summary,
  the backtrace, and the cause. Implement `std::error::Error`. Reuse one general error
  across similar functions (`ParseError` for `parse_json` and `parse_toml`).
- **M-FROM-ERROR**: implement `From<Upstream> for Error` so `?` converts; `map_err`
  only for foreign errors or to add context.
- **M-INIT-BUILDER**: up to two optional parameters use inherent constructors (`new`,
  `with_a`, `with_b`, `with_a_b`). At four or more permutations, `FooBuilder` with
  setters named after fields (`x()`, not `set_x()`), `build()`, and `Foo::builder()`.
  `FooBuilder::new()` is not public. Required parameters arrive through
  `deps: impl Into<FooDeps>`.
- **M-INIT-CASCADED**: constructors with four or more parameters group them into semantic
  types: `Deposit::new(account, amount)`.
- **M-SERVICES-CLONE**: heavyweight services implement cheap `Clone` through
  `Arc<Inner>`; clones share state.
- **M-ESSENTIAL-FN-INHERENT**: core functionality in inherent methods; trait impls
  forward to them, so callers need no import.
- **M-BALANCED-MODULES**: essential items at the crate root; group the rest by use case
  (`account`, `network`), not kind (`traits`, `errors`).
- **M-NO-PRELUDE**: no prelude or `use foo::*` target. Fix the module design instead.
- **M-PARAMETER-CONSISTENCY**: shared parameters in the same order everywhere.
  Call-specific first, ubiquitous (`&logger`) last, closures last, at most one closure.
- **M-COLLECTION-TRAITS**: custom collections provide `Iter`, `IterMut`, `IntoIter`,
  `iter()` / `iter_mut()`, `IntoIterator` for owned and borrowed, `FromIterator`,
  `Extend`, `DoubleEndedIterator` / `ExactSizeIterator` where applicable. `size_hint()`
  is truthful.
- **M-ASYNC-FN**: `async fn foo() -> Result<T, E>` over `fn foo() -> impl Future`. The
  explicit form only in traits or for hot functions (M-ASYNC-STACK-SIZE).

## Libraries: resilience

- **M-AVOID-STATICS**: avoid statics and thread-locals where a consistent value matters.
  Two semver-incompatible copies of a crate get separate statics.
- **M-BUILD-RESULT**: builder setters are infallible; validation, including cross-field
  checks, lives in `build() -> Result<_, _>`.
- **M-INTEGRATION-TESTS**: tests using only the public API go in `tests/`. Prefer an
  integration test whenever either would do.
- **M-LOG-NOT-PRINT**: production code uses the telemetry framework, not `println!` /
  `dbg!`. Only CLIs writing their UI to stdout are exempt.
- **M-MOCKABLE-SYSCALLS**: types doing file, network, clock, entropy, or other
  non-deterministic I/O must be mockable. Provide `new_mocked() -> (Self, MockCtrl)`
  behind `test-util`; don't offer a `Default` that performs I/O.
- **M-NO-GLOB-REEXPORTS**: re-export individually (`pub use foo::{A, B, C};`). Globs
  only for platform HAL modules selected by `cfg(target_os)`.
- **M-STRONG-TYPES**: the strongest std type (`PathBuf` / `Path` for OS data). Plain
  numbers stay plain at API boundaries; no `NonZero` or `Saturating` there.
- **M-STRONG-TYPES-GUARD**: a newtype encoding an invariant (month 1..=12) enforces it in
  a fallible constructor returning `Result`. A panicking `const fn new` is allowed. No
  infallible `From`; use `TryFrom` / `FromStr`.
- **M-TEST-UTIL**: mocks, sensitive-data inspection, safety overrides, and fake data
  generators behind a single `test-util` feature.

## Libraries: building

- **M-OOBE**: non-platform crates build on all Tier 1 targets with only cargo and rustc,
  no extra tools or environment variables. Code generation runs at publish time and its
  output ships in the crate.
- **M-SYS-CRATES**: `-sys` crates build native code from `build.rs` with the `cc` crate,
  embed verifiable upstream sources (URL plus hash), make optional tools optional,
  pre-generate bindgen output, and support static and `libloading` dynamic linking.
- **M-FEATURES-ADDITIVE**: any combination of features compiles. Use a `std` feature,
  never `no-std`. A feature never removes or changes a public item (adding
  `#[non_exhaustive]` enum variants is fine).

## Macros

- **M-MACRO-LAST-RESORT**: macros only when the language can't do the job; they are
  opaque, slow to compile, and brittle across editions.
- **M-EXAMPLE-OVER-PROC**: `macro_rules!` over proc macros when it suffices.
- **M-MACROS-DONT-LIE**: macros never change a type's kind, alter a function signature,
  or add or remove `async`.
- **M-MACRO-MAIN-CRATE**: structure as `foo` (re-exports), `foo_proc` (facade),
  `foo_proc_impl` (logic and tests). Don't support renamed imports.
- **M-MACRO-VERSION-PIN**: companion macro crates pinned with `=x.y.z` and published
  together.
- **M-MACRO-HELPERS**: generated code reaches third-party items through a hidden
  `#[doc(hidden)] pub mod _private { pub use ::bar::Bar; }`.
- **M-PROC-IMPL**: proc macro crate is a thin shim over a normal library crate holding
  the logic and snapshot tests (`insta`); `trybuild` tests for error messages.
- **M-PROC-IMPLIED-ITEMS**: macros don't generate hidden or extra public types (except
  Rocket-style function-plus-struct handlers).

## Applications

- **M-APP-ERROR**: applications and single-app crates may use `anyhow`, `eyre`, or
  similar; libraries follow M-ERRORS-CANONICAL-STRUCTS. Don't mix several app-level
  error types.
- **M-MIMALLOC-APPS**: applications set `#[global_allocator]` to `mimalloc` (up to 25%
  gains reported).
- **M-TARGET-CPU**: server apps compile for the highest `target-cpu` the deployment
  guarantees (`x86-64-v3` via `.cargo/config.toml`). Libraries ignore this.

## FFI

- **M-FFI-NAMING**: `-sys` crates import C libraries; `-ffi` crates export Rust as a
  C-style library.
- **M-FFI-TRANSLATES**: business logic in a safe core crate; the `-ffi` crate only
  translates types and signatures. No `repr(C)` pointer fields in core types.
- **M-ISOLATE-DLL-STATE**: across DLL boundaries share only portable data: `#[repr(C)]`
  types with no statics, thread-locals, `TypeId`, or pointers to non-portable data.

## Correctness

- **M-UNSAFE**: `unsafe` only for a novel abstraction, a benchmarked performance need, or
  FFI/platform calls. Banned: enum casts via `transmute`, `unsafe impl Send` to bypass
  bounds, `transmute` to bypass lifetimes. Each use needs plain-text safety reasoning;
  new abstractions are tested against adversarial code and pass Miri.
- **M-UNSAFE-IMPLIES-UB**: mark a function or trait `unsafe` only when misuse risks
  undefined behavior, not for merely dangerous operations (`delete_database()`).
- **M-UNSOUND**: a safe function that can cause UB through any safe calls is unsound.
  Unsound abstractions are never permissible. If you can't encapsulate it, expose an
  `unsafe fn` and document the contract. Soundness boundaries are module boundaries.
- **M-PANIC-IS-STOP**: panics are not exceptions; a panic means the program should stop
  now. Don't use panics to report errors or rely on them being caught. Valid: programming
  errors (`expect("must never happen")`), const contexts, user-requested unwrap-style
  methods, poisoned-lock `unwrap()`. Code must still be minimally panic-safe.
- **M-PANIC-ON-BUG**: detected bugs and contract violations panic, in libraries and
  applications. Don't return an `Error` the caller can't act on. Fallible input returns
  `Result` (`parse_uri(&str) -> Result<Uri, ParseError>`). Prefer types that make the bad
  state unrepresentable.
- **M-PANIC-CONTINUATION**: `catch_unwind` is a last resort. Libraries don't catch and
  continue. Servers may catch per request but should then promote a controlled restart.
- **M-PANIC-MESSAGE**: every intentional panic (`panic!`, `assert!`, `unreachable!`,
  `todo!`) has a message with the relevant values:
  `assert!(buf.len() >= HEADER_SIZE, "buffer too small: got {} bytes", buf.len())`.

## Performance

- **M-HOTPATH**: decide early whether the crate is performance-relevant; if so, find and
  benchmark hot paths (criterion or divan), profile regularly, document hot spots.
- **M-THROUGHPUT**: optimize for items per CPU cycle; batched APIs; no hot spinning or
  per-item work where batching is possible.
- **M-YIELD-POINTS**: long CPU-bound async work yields (`yield_now().await`) roughly
  every 10 to 100 microseconds.
- **M-MEM-REUSE**: let callers own and reuse buffers: `get_in(id, &mut value)` alongside
  a convenience `get(id)`; provide `clear()`. Arenas for deep call stacks.
- **M-LOG-OVERHEAD**: no telemetry in hot inner loops; no per-event `format!`.
- **M-AVOID-INDIRECTION**: don't stack `Arc` layers on hot types; lift hot cacheable
  fields (`enabled: bool`) into the owning struct.
- **M-BOX-DST**: frequently created, immutable, non-user-visible sequences use
  `Box<[T]>`, `Box<str>`, or `Arc<str>` instead of `Vec` / `String`.
- **M-SHRINK-TO-FIT**: `shrink_to_fit()` on long-lived growable collections built
  without a reservation.
- **M-FAST-HASHER**: `foldhash` or `FxHash` for trusted internal keys; the default hasher
  for untrusted input.
- **M-INITIAL-CAPACITY**: `with_capacity` when the size is known; `collect()` over push
  loops.
- **M-ASYNC-STACK-SIZE**: track the size of hot futures with `size_of_val` in a test;
  shrink state held across `.await`; move setup outside the async block.

## Project

- **M-CARGO-WORKSPACE**: share metadata, versions, and lints through
  `[workspace.dependencies]` and `[workspace.lints]`, with `default-features = false`
  on workspace dependency definitions.
- **M-CRATES-FLAT-FOLDER**: one workspace `Cargo.toml`, crates as siblings under
  `crates/`, never nested inside another crate or its `src/`.
- **M-CRATES-IN-WORKSPACE**: every crate is a workspace member; siblings referenced as
  `sibling.workspace = true`.
- **M-LATEST-EDITION**: new crates use the latest stable edition (2024 or later).
- **M-MSRV**: set a minimum supported Rust version at creation; raise it conservatively
  in minor releases.

## Documentation

- **M-CANONICAL-DOCS**: public items get a one-line summary, extended docs, then
  `# Examples`, `# Errors`, `# Panics`, `# Safety` (required for `unsafe fn`), `# Abort`
  as applicable. Parameters described in prose, not a table.
- **M-DOC-INLINE**: `#[doc(inline)]` on `pub use` of crate-internal items; not for std or
  third-party types.
- **M-FIRST-DOC-SENTENCE**: first sentence on one line, about 15 words; it becomes the
  module summary.
- **M-MODULE-DOCS**: every public module has `//!` docs: what it contains, when to use
  it, examples, observable side effects.

## AI (agent-specific)

- **M-DESIGN-FOR-AI**: what makes an API easy for humans makes it easy for agents:
  idiomatic design, thorough docs on every module and public item, directly usable
  examples, strong types, APIs testable through fakes or mocks, good coverage of
  observable behavior. The compiler's checks counterbalance an agent's limited
  understanding.
- **M-NO-META-DESIGN-DOCUMENTATION**: no design journals, "why we picked X" essays, or
  agent self-report tables (a `Rule | Applied | Where` list) in crate or module docs.
  Document the end state. A README section on enduring architectural goals is fine.
- **M-RUST-SHAPED**: when porting from C#, Java, or C++, don't translate constructs
  one-to-one. Keep the domain logic; use Rust idioms for errors, tasks, ownership, and
  traits. A `throw_if_null()` signals a problem.
- **M-SINGLE-ITEM-PATH**: one path per public item. Don't combine
  `pub mod db { pub struct Connection; }` with `pub use db::Connection;`. Agents tend to
  add re-exports during refactors instead of redesigning. A `pub(crate) mod` with a
  single `pub use` is fine.
- **M-TAUTOLOGICAL-TESTS**: don't write tests that restate constants or mirror
  implementation branches (`assert_eq!(CHECKPOINTS, [0, 90, 180, 270])`). Test
  properties: even spacing, monotonicity, round-trips.
