# Rust API Guidelines (digest)

Source: https://rust-lang.github.io/api-guidelines/ (official rust-lang project).
Read this when designing or reviewing a public API or publishing a crate. All 54
checklist items are covered, grouped as in the original.

## Naming

- **C-CASE**: `UpperCamelCase` for types, traits, enum variants; `snake_case` for
  modules, functions, methods, locals; `SCREAMING_SNAKE_CASE` for consts and statics;
  short type params (`T`); short lowercase lifetimes (`'a`, `'de`). An acronym is one word
  in `UpperCamelCase` (`Uuid`, `Stdin`) and lowercased in `snake_case` (`is_xid_start`).
  Crate names never carry a `-rs` or `-rust` affix.
- **C-CONV**: ad-hoc conversion prefixes:

  | Prefix | Cost | Ownership |
  |---|---|---|
  | `as_` | free | borrowed -> borrowed |
  | `to_` | expensive | borrowed -> borrowed; borrowed -> owned (non-Copy); owned -> owned (Copy) |
  | `into_` | variable | owned -> owned (non-Copy) |

  `as_` and `into_` expose the representation; `to_` stays at the same abstraction level
  but does work (`Path::to_str` checks UTF-8). Wrappers expose their value with
  `into_inner()`. `mut` goes in type order: `as_mut_slice`.
- **C-GETTER**: no `get_` prefix: `first(&self) -> &First`, `first_mut(&mut self)`. Bare
  `get` only when there is one obvious thing to get (`Cell::get`). Checked accessors get
  `unsafe fn get_unchecked` siblings.
- **C-ITER**: collections provide `iter(&self) -> Iter` (items `&U`), `iter_mut`, and
  `into_iter(self) -> IntoIter`. Non-homogeneous types (`str`) use `bytes()`, `chars()`.
- **C-ITER-TY**: the iterator type is named after the method: `into_iter` -> `IntoIter`,
  `keys` -> `Keys`, `percent_encode` -> `PercentEncode`.
- **C-FEATURE**: feature names have no placeholder words: `abc`, not `use-abc`. Gate std
  as `default = ["std"]`, `std = []`, with `#![no_std]` and
  `#[cfg(feature = "std")] extern crate std;`. Features are additive, so `no-abc` is
  almost always wrong.
- **C-WORD-ORDER**: be consistent with std: error types are verb-object-error
  (`ParseBoolError`, so `ParseAddrError`, not `AddrParseError`).

## Interoperability

- **C-COMMON-TRAITS**: eagerly implement `Copy`, `Clone`, `Eq`, `PartialEq`, `Ord`,
  `PartialOrd`, `Hash`, `Debug`, `Display`, `Default` where applicable. Orphan rules mean
  downstream crates cannot add them. Provide an empty `new()` alongside `Default`, and
  make them behave identically.
- **C-CONV-TRAITS**: implement `From`, `TryFrom`, `AsRef`, `AsMut`. Never implement
  `Into` or `TryInto` directly. `From<u16> for u32` for lossless, `TryFrom<u32> for u16`
  for fallible; never `From<u32> for u16`.
- **C-COLLECT**: collections implement `FromIterator<T>` and `Extend<T>` so `collect`,
  `partition`, and `unzip` work.
- **C-SERDE**: data-structure types implement `Serialize` / `Deserialize` behind an
  optional feature named exactly `serde`:
  `#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]`.
- **C-SEND-SYNC**: `Send` and `Sync` are automatic; check them on types holding raw
  pointers and lock them in with a test: `fn assert_send<T: Send>() {}` then
  `assert_send::<MyType>();`.
- **C-GOOD-ERR**: any `E` in a public `Result<T, E>` implements `std::error::Error` and
  should be `Send + Sync`. Boxed errors are `Box<dyn Error + Send + Sync + 'static>`
  (`'static` enables `downcast_ref`). Never use `()` as an error type. `Display` messages
  are lowercase, concise, no trailing punctuation. Don't implement the deprecated
  `description()`.
- **C-NUM-FMT**: number-like types you would combine with `|` or `&` (bitflags)
  implement `LowerHex`, `UpperHex`, `Octal`, `Binary`. Quantities (`Nanoseconds(u64)`)
  don't need them.
- **C-RW-VALUE**: generic functions take `R: Read` and `W: Write` by value; `&mut R`
  also implements `Read`, so callers pass `&mut f` to keep using it. Say so in the docs.

## Macros

- **C-EVOCATIVE**: macro input resembles the output (`struct S: u32 { .. }`, const-like
  items end in `;`).
- **C-MACRO-ATTR**: macros that emit items accept attributes on each item, so
  `#[cfg(..)]` and `#[derive(..)]` work.
- **C-ANYWHERE**: item macros work at module and function scope; test both. Emitting
  `super::U` breaks inside a function.
- **C-MACRO-VIS**: emitted items are private unless the input says `pub`.
- **C-MACRO-TY**: a `$t:ty` fragment accepts primitives, relative and absolute paths,
  `super::`, and generics. Don't emit a nested `pub mod` that can't see local types.

## Documentation

- **C-CRATE-DOC**: crate-level docs are thorough and include examples.
- **C-EXAMPLE**: every public module, trait, struct, enum, function, method, macro, and
  type alias has an example, within reason. Show why to use it, not mechanically how.
- **C-QUESTION-MARK**: examples use `?`, never `try!` or `unwrap()`, because users copy
  them verbatim. Hide the scaffolding with `#` lines:

  ```rust
  /// ```
  /// # use std::error::Error;
  /// # fn main() -> Result<(), Box<dyn Error>> {
  /// let value = parse_it("...")?;
  /// # Ok(())
  /// # }
  /// ```
  ```

- **C-FAILURE**: `# Errors` when `Err` can be returned (including trait methods whose
  impls may err); `# Panics` when a function can panic; `# Safety` on every `unsafe fn`
  listing every caller invariant.
- **C-LINK**: link items in prose with `` [`Type`] ``.
- **C-METADATA**: `[package]` has `authors`, `description`, `license`, `repository`,
  `keywords`, `categories`; `documentation` only if not on docs.rs; `homepage` only if
  distinct from `repository`.
- **C-RELNOTES**: keep release notes, mark breaking changes, and tag releases with
  annotated tags (`git tag -a`).
- **C-HIDDEN**: `#[doc(hidden)]` on impls users never trigger
  (`From<PrivateError> for PublicError` exists only to enable `?`). Use `pub(crate)` for
  internals.

## Predictability

- **C-SMART-PTR**: smart pointers add no inherent methods; use associated functions
  (`Box::into_raw(b)`, not `b.into_raw()`), so a call can't be ambiguous with the pointee.
- **C-CONV-SPECIFIC**: put conversions on the more specific type (`str::as_bytes`,
  `str::from_utf8`). Prefer `to_` / `as_` / `into_` over `from_`; they chain better.
- **C-METHOD**: if a function has a clear receiver, make it a method
  (`impl Foo { fn frob(&self, w: Widget) }`). Methods need no import, autoborrow, and
  express ownership through `self`.
- **C-NO-OUT**: return multiple values as a tuple or struct, not `&mut` out-parameters.
  Exception: reusing a caller-owned buffer (`Read::read`).
- **C-OVERLOAD**: implement `std::ops` traits only when the operation resembles the
  operator and shares its properties (`Mul` should be associative).
- **C-DEREF**: only smart pointers implement `Deref` / `DerefMut`. The coercion and
  method-resolution rules are designed for them (`Box`, `String`, `Rc`, `Arc`, `Cow`).
- **C-CTOR**: constructors are static inherent methods. Primary is `new()`; secondary
  ones take a `_with_foo` suffix (`open_with_offset`); I/O resources use domain names
  (`File::open`, `TcpStream::connect`); conversion constructors are `from_foo` and may be
  `unsafe` (`Box::from_raw`) or take extra args (`u64::from_str_radix`), unlike `From`.
  Many options means a builder.

## Flexibility

- **C-INTERMEDIATE**: expose work already done. `binary_search` reports the insertion
  index on a miss; `String::from_utf8`'s error returns the valid prefix length and the
  bytes; `HashMap::insert` returns the old value.
- **C-CALLER-CONTROL**: if the function needs ownership, take by value and never clone a
  borrow internally. If it only reads or mutates, take `&` / `&mut`. Bound by `Copy` only
  when required, not to advertise cheapness.
- **C-GENERIC**: assume as little as possible. Iterating only?
  `fn foo<I: IntoIterator<Item = i64>>(iter: I)`, not `&[i64]`. `File::open` takes
  `AsRef<Path>`. Costs: code size, one concrete type per parameter, verbose signatures.
- **C-OBJECT**: decide early whether a trait is a bound or an object. Generic methods and
  `Self` outside the receiver block object safety; exclude them with `where Self: Sized`:

  ```rust
  trait MyTrait {
      fn object_safe(&self, i: i32);
      fn not_object_safe<T>(&self, t: T) where Self: Sized;
  }
  ```

## Type safety

- **C-NEWTYPE**: `struct Miles(pub f64)` vs `struct Kilometers(pub f64)` gives static
  distinctions at zero runtime cost. (The guide cites the Mars Climate Orbiter.)
- **C-CUSTOM-TYPE**: don't pass `bool`, `u8`, or `Option` where meaning is ambiguous.
  `Widget::new(Small, Round)`, not `Widget::new(true, false)`. Enums can also grow later.
- **C-BITFLAG**: independent flags use the `bitflags` crate; an enum models exactly one
  choice. Explicit discriminants suit serialization or C interop.
- **C-BUILDER**: introduce `TBuilder` when a type has many inputs, compound data, optional
  config, several flavors, or side effects on build. The constructor takes only required
  data, config methods chain, terminal methods build. Prefer non-consuming builders
  (`&mut self -> &mut Self`, terminal `&self`): `Command::new("cat").arg("f").spawn()`.
  Consuming builders only when the terminal method must move a value out.

## Dependability

- **C-VALIDATE**: enforce validity, in preference order: statically (a type that rules
  out bad input, `fn foo(a: Ascii)` over `fn foo(a: u8)`), dynamically (check as you
  process, `debug_assert!` for expensive checks), opt-out (`_unchecked` siblings or a
  `raw` module for confident callers).
- **C-DTOR-FAIL**: destructors never fail; failing during unwinding aborts. Provide
  `close(self) -> Result<..>` and let `Drop` be best-effort.
- **C-DTOR-BLOCK**: destructors don't block. Offer a separate method that prepares an
  infallible, non-blocking teardown.

## Debuggability

- **C-DEBUG**: all public types implement `Debug`. Exceptions are rare.
- **C-DEBUG-NONEMPTY**: even empty values produce non-empty `Debug` output
  (`""` -> `"\"\""`, empty vec -> `"[]"`).

## Future proofing

- **C-SEALED**: the sealed trait pattern lets you add methods without breaking users:

  ```rust
  pub trait TheTrait: private::Sealed { /* ... */ }
  impl TheTrait for usize { /* ... */ }
  mod private {
      pub trait Sealed {}
      impl Sealed for usize {}
  }
  ```

  Document that the trait is sealed.
- **C-STRUCT-PRIVATE**: fields private by default; a public field fixes the
  representation and blocks invariants. Public fields only for passive C-style data.
- **C-NEWTYPE-HIDE**: hide implementation types behind a newtype
  (`pub struct MyIter<I>(Enumerate<Skip<I>>)`) so the inner type can change. `impl Trait`
  is more concise but awkward for `Debug` / `Clone` bounds; fine for internal APIs.
- **C-STRUCT-BOUNDS**: no derivable bounds on struct definitions.
  `#[derive(Clone, Debug, PartialEq)] struct Good<T>`, not
  `struct Bad<T: Clone + Debug + PartialEq>`. Never bound a data structure by `Clone`,
  `PartialEq`, `PartialOrd`, `Debug`, `Display`, `Default`, `Error`, `Serialize`,
  `Deserialize`. Exceptions: associated-type references, `?Sized`, a `Drop` impl that
  needs the bound.

## Necessities

- **C-STABLE**: a 1.0+ crate needs every public dependency (any crate whose types appear
  in its API) to be stable too. `From<other_crate::Error>` leaks `other_crate`.
- **C-PERMISSIVE**: `license = "MIT OR Apache-2.0"` with both license files, matching
  Rust itself. Depend only on permissively licensed crates.
