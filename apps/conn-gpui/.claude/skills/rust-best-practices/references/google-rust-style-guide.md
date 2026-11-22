# Google Rust Style Guide (digest)

Source: https://google.github.io/styleguide/rustguide.html . Google's internal guide,
also adopted by Android, Chromium, and Fuchsia. It defers to the official Rust Style
Guide and API Guidelines and adds rules on top. API-design rules are binding for library
code and a strong recommendation for application code, which "should generally favor
simplicity and directness over broad reusability". Read this for formatting, imports,
module layout, accessor naming, and the application-vs-library distinction. Rules
specific to Chromium or Fuchsia builds are omitted below.

## Background and goals

Readability over writeability; automation (large-scale changes should be mechanical);
consistency with the Rust ecosystem; rules must pull their weight. Follow the official
Rust Style Guide and API Guidelines unless this guide conflicts. rustfmt enforces most
formatting automatically.

## Code organization

- Prefer small crates, ideally but not necessarily a single file. Larger crates are
  allowed for orphan-rule coherence or foundational libraries. Decide crate boundaries
  before submodules; the root may re-export from leaf submodules.
- Name a leaf module after its primary item: `Foo` gives `mod foo` / `foo.rs`.
- Non-leaf modules contain only `mod` declarations and re-exports. Small "ties things
  together" code is tolerated. Leaf modules may include `mod tests`.
- No glob imports, except at reviewer discretion: `use super::*` in inline modules,
  `use Enum::*` in enum method bodies, `pub use submodule::*` in non-leaf modules.
  Avoid defining preludes.
- One module per `use` statement (rustfmt `imports_granularity = Module`): no `::`
  inside braces.

  ```rust
  use foo::bar::{Bar, Baz};  // OK
  use foo::{Foo, bar::Bar};  // avoid
  ```

- Import traits inside function bodies unless the trait is used throughout the file.
- Qualify free function calls by module (`mem::transmute(y)`, not `transmute(y)`), but
  use types and traits unqualified (`Regex`, not `regex::Regex`). Exceptions: ambiguous
  names such as `io::Error` (or `use std::io::Error as IoError`), large type groups,
  macros and generated code.

## Formatting

- Always run the formatter. Recommended rustfmt settings: `max_width = 100`,
  `hex_literal_case = Lower`, `format_macro_matchers = true`.
- `#[rustfmt::skip]` only for deliberate manual alignment or generated code, never for
  personal style.

## Ownership and borrowing

- Avoid `Rc` / `Arc`; prefer unique ownership. Exception: when the alternative is
  unreasonably complex, a review judgment call.
- Borrow rather than `.clone()`. Clone when a real deep copy is needed or borrowing
  becomes excessively complex, and weigh performance. Cloning `Rc` / `Arc` is expected.

## Function inputs and outputs

- Accept the most flexible borrowed type: `&[T]` not `&Vec<T>`, `&str` not `&String`,
  `&T` not `&Box<T>`, `Option<&T>` not `&Option<T>` (clippy `borrowed_box`, `ptr_arg`).
- Library code returns iterators (concrete or `impl Iterator`) instead of `Vec<T>` and
  accepts `impl IntoIterator` when only iterating. Application code may return or take
  `Vec` / `&[T]` when simpler. Exceptions: callers need an owned vector, random
  indexing, or the function's purpose is building a collection.
- `impl Into<T>` parameters only where call-site ergonomics are paramount, weighed
  against code bloat. Application code should almost never use them.
- Use an `enum` instead of a `bool` parameter when the purpose isn't obvious. If you
  keep a `bool`, add an inline comment at the call site.
- Errors, chosen by API contract: `Option` for obvious failures (`checked_add`);
  `Result` when the caller needs details (`fn open_file(path: &Path) -> Result<File,
  io::Error>`); `panic!` for bugs and violated invariants, which must be fixed in the
  code, not handled at runtime. Developer-facing binaries may panic on non-fatal
  errors; tests may panic for assertions.

## Types

- Use a newtype rather than an alias for notable semantic differences, a type needing
  its own API, a possible future change of underlying type, or type safety
  (`Day` / `Month` / `Year`).
- Prefer named fields over tuples, since `.0` and `.1` get confusing. Exceptions:
  single-field newtypes and very local contexts.

## Traits

- Add trait impls when needed. Low-level library code anticipates needs; application
  code adds them on demand.
- Implement the std trait instead of a custom method: `impl FromStr for Foo`, not
  `fn from_str` (clippy `should_implement_trait`). Keeping both is acceptable.
- Use `#[derive]` wherever it can express the impl.
- Library code accepts generics (`T: Trait`, `impl Trait`) over `dyn Trait`, except when
  code size matters. Reasons: vtable indirection, no inlining, and some traits are not
  dyn-compatible (generic functions, associated functions without `self`, functions
  returning `Self`).
- Define a trait only for generic programming, for accepting or returning
  `impl` / `dyn Trait`, or as an extension trait. Otherwise use an inherent impl.
  Don't use traits merely to organize code.
- Extension traits: suffix `Ext`, sole purpose is adding methods (not for generics or
  `dyn`), owned by the team that owns the extended type.
- Trait guidance: types with public fields implement traits all subfields implement.
  Error types: `Copy` when possible. `Copy` whenever it will clearly stay `Copy`;
  `Clone` for most types except external resources; `Default` when there is a `new()` or
  default state (clippy `new_without_default`); `PartialEq` over `Eq` unless you need
  reflexivity; `PartialOrd` over `Ord` unless you need a total order; map keys get
  `Hash` and `Eq`, plus `Ord` if there is a clear total order.
- Pair an important `From` impl with an inherent `::new()`, `::new_from_foo()`, or
  `::from_foo()`.
- Bag-of-options structs with all-public fields implement `Default`, enabling
  `..Default::default()`.

## Concurrency

- Never reach inside a poisoned mutex, "no matter how tempting".
- Library code should not start threads itself.

## Macros

Preference order: plain functions, types, traits, and modules; then `macro_rules!`;
then other codegen; then `proc_macro`. Weigh IDE and code-search costs, dialect
creation, and difficulty of large-scale changes.

## Naming

- Methods follow std style: `as_`, `to_`, `into_` with the matching `self` convention
  (clippy `wrong_self_convention`).
- Lifetimes should be descriptive, especially on types. Exceptions: generic abstractions
  like `Cow`, `'_`, and single-character names for simple input/output relationships.
- Generic parameters: short, related to what they represent, ideally the letter from the
  most important bound. `T` / `U` for APIs meant for almost any type.
- Constructors: `new()` or `new_with_foo()`; `try_new()` if fallible. Value-to-value
  conversions: `from_foo()` with a `From` impl.
- Avoid abbreviations outsiders won't know, including acronyms and letter-dropping.
  Exceptions: Wikipedia-common terms and clear cases like `IpAddr`.

## Documentation

- Document public APIs; consider the `missing_docs` lint.
- Include examples somewhere in the crate, not necessarily on every function.
- Document panics caused by malformed input, and invariants of unsafe functions and
  traits.
- Use capitalization and punctuation. Don't explain language basics. Comments must add
  information: `/// Removes an element.` on `remove_element()` is bad; omit it or allow
  the lint. Enum variant docs are often omittable.
- `///` for items; `//!` at the top of a file for modules and crates; Markdown; `//` for
  implementation notes, TODOs, and commented-out code. Mixing `///` and `//` on one item
  is fine:

  ```rust
  /// Finds the first `FooItem` with the given `name`, or `None` if not present.
  // TODO(issue-12345): `name` should be &str, not String.
  ```

- Prefer plain doc comments over macro-generated docs.

## Other Rust features

- **Unsafe**: don't write it unless safe code cannot do the same. Wrap it in a safe
  abstraction, isolate it (ideally in its own crate with few dependencies), add a
  `SAFETY:` comment, and justify it, with benchmarks if performance is the reason.
- **Unstable features**: don't use them.
- **Accessors**: `foo()` returns the value or a reference, `foo_mut()`, `take_foo()`,
  `set_foo(T)`, `replace_foo(T) -> T`, and `with_foo(|f| ..)` / `with_mut_foo(|f| ..)`
  for closure access. Closure accessors suit interior-mutability wrappers (`Mutex`,
  `RefCell`) or follow-up validation where `set_foo` can't be used.
- If you implement `len()`, also implement `is_empty()` (clippy `len_without_is_empty`).
- Don't access `#[doc(hidden)]` items you don't own.
- Mark a public function `const` only if it will stay `const`; removing `const` is
  breaking.
- Overload operators only for their mathematical or logical meaning, not as sugar.
- `#[non_exhaustive]` on public enums and public-field structs used across teams.
  Exceptions: stable ontologies (`Color`), two-state enums, or a commitment to fixing
  breakage with a large-scale change (clippy `exhaustive_enums`).
- `#[must_use]` on functions when ignoring the return is a misuse (pure functions like
  `HashMap::get()`) or the return carries errors or critical info; not needed if the
  return type already has it (`Result`). On types returned by such functions: error
  types and lazy computations.
- Run no code before `main()` (no `ctor` crate).

## Implementation concerns

- Don't overuse inference. Add explicit types for `.into()`, `.parse()`, and complex
  iterator results. Prefer typed variable declarations to turbofish; use `_` where the
  compiler forces a turbofish.
- Pattern-match instead of check-then-unwrap: `if let Some(value) = option { .. }`, not
  `is_some()` followed by `unwrap()`.
- Use `expect("reason")` over `unwrap()` when a panic is unavoidable.
- On `#[non_exhaustive]` enums, list every variant you handle, with a wildcard for the
  rest. Use `if let` or `let .. else` when you care about one variant
  (lint `non_exhaustive_omitted_patterns`).
- Add context strings to `assert!`, especially when a human will see the failure or to
  distinguish API misuse from bugs:

  ```rust
  assert!(self.stream.is_some(), "Call connect() before executing queries");
  ```

  Don't repeat the condition as the message.
- Avoid long or complex iterator chains. Don't put a chain in a `for` header; bind it to
  a variable first. Avoid `for_each`. Short chains are fine:
  `values.iter().any(|&v| v > threshold)`.
- Don't call `panic::catch_unwind` in first-party code, except as defense in depth that
  is never relied on, and only where `panic = "unwind"` applies.
- Use `format!` / `write!` to concatenate more than two strings (`format!("{a}{b}{c}")`)
  and for substitutions instead of `str::replace`.

## Tests

Use the codebase's test framework. Tests may use panics for assertions. Tests live in a
`mod tests` inside leaf modules.
