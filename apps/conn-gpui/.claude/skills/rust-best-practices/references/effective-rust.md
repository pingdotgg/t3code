# Effective Rust (digest)

Source: *Effective Rust* by David Drysdale (O'Reilly, 2024), free online at
https://www.lurklurk.org/effective-rust/ . Thirty-five items on writing Rust well.
Read this when weighing alternatives: generics vs trait objects, `Result` vs panic,
iterators vs loops, how to get past the borrow checker, dependency and CI policy.
The book targets Rust 1.70 to 1.76; anything it calls "upcoming" has long since landed.

## Types (Items 1-9)

1. **Use the type system to express your data structures.** Replace "must be (0,0,0) if
   monochrome" comments with an enum that carries the data. `Option` for absence, never
   sentinels. Fallible results are always `Result<T, E>`. An enum instead of a `bool`
   parameter when a third option could ever arrive; a newtype when it will always be
   boolean.
2. **Use the type system to express common behavior.** Accept trait types rather than
   concrete ones when flexibility matters. For closures use the most general `Fn*` bound
   that works: `FnOnce` if called once, `FnMut` if it mutates, `Fn` otherwise. Prefer
   `Fn*` bounds to bare `fn` pointers, which cannot capture state. Marker traits
   (a method-less `StableSort: Sort`) express guarantees a signature cannot.
3. **Prefer `Option` and `Result` transforms over explicit `match`.** `map`, `and_then`,
   `ok_or`, `map_err`, `unwrap_or_else`, `as_ref()`, and `?`. `Result` beats `Option`
   when the failure could carry useful information. `unwrap` and `expect` are decisions
   to panic (Item 18).
4. **Prefer idiomatic `Error` types.** Implement `std::error::Error` (requires `Debug` +
   `Display`; `source()` exposes causes). Preserve sub-errors with an enum plus a `From`
   impl per inner error (`thiserror` generates this). When they need not be preserved,
   applications use `anyhow`; keep `anyhow` out of library public APIs. A bare `String`
   cannot implement `Error` (orphan rule), so wrap it.
5. **Understand type conversions.** Implement `From` (gives `Into` free); `TryFrom` only
   when a conversion can fail. In bounds use `Into<T>` so both kinds of impl are
   accepted. Prefer `from` / `into` over `as`, which silently permits lossy casts, except
   where exact cast semantics are the point (C interop).
6. **Embrace the newtype pattern.** `PoundForceSeconds(f64)` vs `NewtonSeconds(f64)`
   can't be mixed; an alias doesn't prevent it. Newtypes also let you implement a foreign
   trait for a foreign type. Cost: inner trait impls are lost and must be re-derived or
   forwarded. `#[repr(transparent)]` keeps the layout identical.
7. **Use builders for complex types.** `Default` with `..Default::default()` when most
   fields have sensible defaults; a builder when there are optional or validated fields.
   Consuming builders (`fn x(self) -> Self`) are most ergonomic but can't be staged
   conditionally or reused. `&mut self` builders allow staging but need a named `let`
   binding, and a repeatable `build(&self)` must construct fresh values.
8. **Familiarize yourself with reference and pointer types.** `&T` is a pointer the
   compiler guarantees valid, aligned, and borrow-checked. `Box<T>` for single-owner heap
   data; `Rc` / `Arc` for shared ownership (with `Weak` to avoid cycles); `Cell` /
   `RefCell` or `Mutex` / `RwLock` for interior mutability. `RefCell` moves borrow checks
   to runtime, so use `try_borrow` where a panic is unacceptable. Choose the mutation
   granularity you need: `Rc<RefCell<Vec<T>>>` vs `Rc<Vec<RefCell<T>>>`.
9. **Consider iterator transforms instead of explicit loops.** Source, adapters
   (`filter`, `take`, `map`, `zip`), consumer (`sum`, `fold`, `find`, `any`, `collect`).
   Propagate the first error by collecting into `Result<Vec<_>, _>` and applying `?`.
   Keep a loop when the body is large or does several jobs, when early returns are
   awkward inside closures, or when the transform is forced. Measure when it matters.

## Traits (Items 10-13)

10. **Familiarize yourself with standard traits.** Derive `Clone`, `Copy`, `Debug`,
    `PartialEq`, `Eq`, `PartialOrd`, `Ord`, `Hash`, `Default` when every field supports
    them; hand-implement only where the derived behavior is wrong. Skip `Clone` for
    unique-access resources and secret key material; `Copy` only when a bitwise copy is
    valid and fast. Pair `Eq` with `PartialEq` (not for floats), keep `Hash` consistent
    with `Eq`, never ship `PartialOrd` without a matching `Ord`.
11. **Implement `Drop` for RAII patterns.** Any type holding a resource that must be
    released (file descriptor, lock, raw memory) implements `Drop`. Scope guards with
    blocks so locks are not held longer than needed. `drop` can't return an error, so
    provide a separate fallible `release()`. Call `drop(x)`, never `x.drop()`.
12. **Understand the trade-offs between generics and trait objects.** Prefer generics.
    Monomorphization gives static dispatch and speed but one code copy per type (bigger
    binaries, slower builds). Trait objects (`&dyn`, `Box<dyn>`) use one copy plus a
    vtable and suit heterogeneous collections, code-size or compile-time limits, or code
    loaded at runtime. Object safety: no generic methods, no `Self` in args or returns
    beyond the receiver, unless marked `where Self: Sized`.
13. **Use default implementations to minimize required trait methods.** Few required
    methods; defaults for everything derivable (as `Iterator` builds 50+ methods on
    `next()`). Defaults can carry bounds (`cloned()` only for `Clone` items). Adding a
    defaulted method is usually backward compatible.

## Concepts (Items 14-20)

14. **Understand lifetimes.** A reference may not outlive its referent. Elision covers
    a single input reference lending to the output, and methods lending `&self`'s
    lifetime. Otherwise name them. A struct holding a reference needs a lifetime that
    propagates to every container, so prefer owning data. `'static` is for globals or
    deliberately leaked data (`Box::leak`).
15. **Understand the borrow checker.** Any number of `&T` or exactly one `&mut T`, never
    both, and non-lexical lifetimes end a reference at its last use. Coping tactics:
    extend a temporary with a named `let` or shorten with a block; split a complex
    expression into typed intermediates; redesign ownership by cloning small immutable
    data, using an owning `Vec` with indices (fragile), or `Rc` / `RefCell` with `Weak`
    back-pointers. Avoid self-referential structs (`ouroboros` if unavoidable).
16. **Avoid writing unsafe code.** Use std and crates.io first, where battle-tested
    `unsafe` already lives (`Rc`, `Mutex`, `Pin`, `cxx`). When unavoidable: confine it to
    a small wrapper with a safe API, document each block's preconditions in a safety
    comment, minimize each block, enable `unsafe_op_in_unsafe_fn`, write extra tests,
    run Miri.
17. **Be wary of shared-state parallelism.** `Send` / `Sync` and the borrow checker
    eliminate data races in safe code; deadlocks and logic races remain. Prefer message
    passing. When sharing: keep data with linked invariants under one lock, keep lock
    scopes small, never call closures while holding a lock, never return a `MutexGuard`
    to a caller, add deadlock detection to CI. A documented lock hierarchy is a last
    resort.
18. **Don't panic.** Prefer `Result`; panic is for unrecoverable bugs or corrupted
    state. Rule of thumb: `panic!`, `unwrap()`, `expect()` are acceptable when you
    control `main`, because no further caller exists. Where a panic is justified, pair
    an infallible function (documented under `# Panics`) with a fallible one.
    `catch_unwind` is not an exception substitute: it does nothing under
    `panic = "abort"` and can leave state inconsistent. Use it at FFI boundaries only.
19. **Avoid reflection.** No general runtime reflection. `type_name` is diagnostic only;
    `TypeId` / `Any::downcast_ref` work only on values already wrapped as `dyn Any`.
    Encode required behavior as traits, marker traits for properties, derive macros for
    compile-time generation.
20. **Avoid the temptation to over-optimize.** Design for usability first: a type that
    owns a `Vec<u8>` avoids lifetime propagation, and copying small data is usually fine.
    Add allocations or clones only after benchmarks show they matter; `Rc` / `Arc` with
    `RefCell` / `Mutex` are legitimate tools. Exception: `Copy`. Derive it for small
    bitwise-copyable types and never for large or non-trivial ones.

## Dependencies (Items 21-26)

21. **Understand what semantic versioning promises.** `"1.2.3"` means `^1.2.3`; `"~"`
    allows patches only; `"="` pins; `"*"` accepts anything. Breaking changes: removing
    public items, adding a variant to a matchable enum (unless `#[non_exhaustive]`),
    adding a public field to a publicly constructible struct, making a trait
    non-object-safe, adding a blanket impl. License and default feature set are API.
    Deprecate in a minor release before removing in a major one.
22. **Minimize visibility.** Private by default; `pub(crate)`, `pub(super)`,
    `pub(in path)` before `pub`. Widening later is minor; narrowing is breaking. Keep
    fields private; `pub` on an enum or trait exposes all variants or methods.
23. **Avoid wildcard imports.** Don't glob-import crates you don't control; a minor
    release can add a clashing name (error E0034). Fine for `use super::*` in tests,
    modules you own, and a deliberately curated prelude. If you glob a dependency anyway,
    pin it.
24. **Re-export dependencies whose types appear in your API.** A caller on a different
    semver-incompatible version of `rand` gets a confusing "trait bound not satisfied".
    Re-export (`pub use rand;`) so callers can name the matching version, and think hard
    before exposing foreign types at all.
25. **Manage your dependency graph.** Cargo allows semver-incompatible versions of a crate
    to coexist, never two compatible ones. Commit `Cargo.lock` for binaries. Prefer
    `"1"` or `"1.4.23"` to `"=1.2.3"` or `"*"`. Use `cargo tree` (`--invert`,
    `--duplicates`, `--edges features`), `cargo-deny`, `cargo-udeps`. Every dependency
    costs build time, binary size, and supply-chain exposure, including `build.rs` and
    proc macros.
26. **Be wary of feature creep.** Features must be additive because Cargo unifies them
    across the graph. Don't feature-gate public struct fields or trait methods. Feature
    names share a namespace with crate names. Each independent feature doubles the
    configurations; CI should cover the combinations that matter. Model: a `std` or
    `alloc` feature on a `no_std` base.

## Tooling (Items 27-32)

27. **Document public interfaces.** `///` and `//!`, cross-reference with `` [`Name`] ``,
    `# Examples`, `# Panics`, `# Safety` sections. Describe what the signature cannot
    express (preconditions, errors, panics, why), not the types. `cargo doc --open`;
    consider denying `broken_intra_doc_links`; avoid rushed docs written only to silence
    `missing_docs`.
28. **Use macros judiciously.** Only when a function or generic cannot do the job, or to
    keep parallel code in sync (one table generating an enum plus `group()`, `text()`,
    `TryFrom`). Macros can insert `return`, `?`, or mutations at the call site, so keep
    control flow visible, and bind expression arguments with `let` to avoid
    re-evaluation. Prefer a derive macro to a proc macro that emits a new type. Check
    `strum`, `enumn`, `num_enum` first.
29. **Listen to Clippy.** Keep the code warning-free. Fix rather than suppress; where a
    lint is genuinely wrong, a narrow `#[allow(clippy::..)]`. `cargo clippy -- -Dwarnings`
    in CI. Read the full lint list, including default-off lints such as
    `as_conversions`, to learn idiom.
30. **Write more than unit tests.** Unit tests in `#[cfg(test)] mod tests` (see private
    items); integration tests in `tests/` (public API only); doc tests; examples
    (`cargo test --examples`). Benchmarks with `std::hint::black_box`. `cargo-fuzz` for
    untrusted input. Write a failing test before fixing a bug. Test every feature
    combination and platform with distinct code.
31. **Take advantage of the tooling ecosystem.** `cargo fmt`, `check`, `clippy`, `doc`,
    `bench`, `update`, `tree`, `metadata`; `rust-analyzer`; `cargo-expand`,
    `cargo-tarpaulin`, `cargo-udeps`, `cargo-deny`, `cargo-semver-checks`, Miri. Wire
    useful tools into CI; fast, false-positive-free ones into the editor.
32. **Set up CI.** Build, run every test type, `cargo clippy -- -Dwarnings`,
    `cargo fmt --check`, `cargo doc`, `cargo-deny`. Pin the toolchain with
    `rust-toolchain.toml`, build every feature combination, check the MSRV, build a
    `no_std` target, detect generated-code drift. Remove flaky tests; make every check
    runnable locally; add a CI check for a process problem before fixing it.

## Beyond standard Rust (Items 33-35)

33. **Consider making library code `no_std` compatible.** `core` has `Option`, `Result`,
    iterators; `alloc` adds `Box`, `Rc`, `Arc`, `Vec`, `String`, `BTreeMap`. `HashMap`
    and `Mutex` need the OS. Often just `std::` path changes and `BTreeMap`. Guard with a
    CI cross-compile (`thumbv6m-none-eabi`); expose additive `std` / `alloc` features,
    never a `no_std` feature. Prefer `try_reserve` where memory is limited.
34. **Control what crosses FFI boundaries.** Calls into C are `unsafe`. `extern "C"`
    blocks, `#[link]` or `build.rs`, sized types, `#[repr(C)]`, `CString` / `CStr`.
    Allocate and free on the same side; wrap C-owned pointers in an RAII type; check null
    and return `Result`; keep unsafe inside the wrapper. Exported functions need
    `extern "C"`, `#[no_mangle]`, a unique prefix; `Box::into_raw` / `from_raw` for
    ownership transfer; never return stack pointers; stop panics with `catch_unwind`.
35. **Prefer `bindgen` to manual FFI mappings.** Generate declarations from C headers
    (`--allowlist-function`), `include!` the output, and fail CI if a regenerated file
    differs. Large C APIs: a raw `xyzzy-sys` crate under a safe `xyzzy` crate. C++: `cxx`.
