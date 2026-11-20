# Rust Design Patterns (digest)

Source: https://rust-unofficial.github.io/patterns/ (community book, last updated
September 2026). Idioms, design patterns, and anti-patterns with code. Read this when you
need a concrete pattern (builder, RAII guard, newtype, visitor, `mem::take`) or want to
check whether something is a known anti-pattern.

## Idioms

**Borrowed types for arguments.** Take `&str`, `&[T]`, `&T` instead of `&String`,
`&Vec<T>`, `&Box<T>`. Callers can then pass owned values, borrows, or literals through
deref coercion, and you avoid a layer of indirection.

```rust
fn three_vowels(word: &str) -> bool { /* ... */ }
three_vowels(&String::from("Ferris"));  // &String coerces to &str
three_vowels("Curious");                // literal works too
```

**Concatenate strings with `format!`.** `format!("Hello {name}!")` is the most readable
way to mix literals and variables. A pre-allocated `String` with `push_str` is faster
in hot paths.

**Constructors.** Provide an associated function `new` with no `self`, even when it takes
no arguments and duplicates `Default`.

**The `Default` trait.** `#[derive(Default)]` when every field implements it; struct
update syntax for partial configuration:

```rust
let conf = MyConfiguration { check: true, ..Default::default() };
```

Only one `Default` per type; use named constructors for other starting states.

**Collections are smart pointers.** An owning collection implements `Deref` to its
borrowed view (`Vec<T>` -> `[T]`, `String` -> `str`) so the view's methods are available
on the owner. Methods reached through `Deref` don't count toward trait bounds, so generic
code may need `Borrow` or `AsRef`.

**Finalisation in destructors.** Rust has no `finally`; put cleanup in a `Drop` impl on a
guard bound to a named variable (`let _exit = Guard;`). It runs on early `?` returns and
on unwinding. `let _ = ..` drops immediately. Destructors can be skipped by an abort, an
infinite loop, or a panic during unwinding, so don't rely on them for essential work.

**`mem::take` and `mem::replace`.** Move a field out of a `&mut` value by swapping in a
placeholder instead of cloning. `take` uses `Default` (an empty `String` doesn't
allocate); `replace` takes an explicit value; `Option::take` for options.

```rust
fn a_to_b(e: &mut MyEnum) {
    if let MyEnum::A { name, x: 0 } = e {
        *e = MyEnum::B { name: mem::take(name) };
    }
}
```

**On-stack dynamic dispatch.** Get `dyn Trait` over differently typed values without
`Box` by binding a reference in an `if` expression (temporary lifetime extension since
Rust 1.79):

```rust
let readable: &mut dyn io::Read = if arg == "-" {
    &mut io::stdin()
} else {
    &mut fs::File::open(arg)?
};
```

**Iterating over an `Option`.** `Option` is an iterator of zero or one items:
`vec.extend(opt)`, `iter.chain(opt.iter())`. `std::iter::once` when always `Some`. For a
plain branch, `if let Some(..)` reads better.

**Pass variables to closure.** When a closure needs some captures cloned or borrowed and
others moved, rebind them in an inner block, then `move`:

```rust
let closure = {
    let num2 = num2.clone();    // cloned
    let num3 = num3.as_ref();   // borrowed
    move || *num1 + *num2 + *num3  // num1 moved
};
```

**`#[non_exhaustive]` and private fields.** In a library, mark public structs, enums, or
variants `#[non_exhaustive]` when you may add fields or variants later. Within a crate,
a private `_b: ()` field blocks struct literals. Use sparingly: it forces wildcard arms
downstream, and a major-version bump is often better.

**Easy doc initialization.** When a doc example needs lots of setup, wrap the example in
a hidden helper function (`# fn call_send(conn: Connection) {`) that takes the prepared
values as parameters. The example compiles but doesn't run its assertions.

**Temporary mutability.** Finish mutation in setup, then freeze: `let data = data;`.

**Return consumed argument on error.** A fallible function that takes ownership returns
the argument inside the error so the caller can retry without cloning
(`String::from_utf8` and `FromUtf8Error::into_bytes`).

## Design patterns

The section opens with YAGNI: many classic patterns are unnecessary in Rust. Strategy is
just traits; Option::map is already strategy.

### Behavioural

**Command.** Store actions as values: `Box<dyn Trait>` for command structs with several
methods (`execute` / `rollback`), `fn()` pointers for simple actions, `Fn` closures for
captured state. Function pointers and closures avoid dynamic dispatch.

**Interpreter.** When a recurring problem is a small language, define a grammar and an
interpreter. For lightweight DSL syntax, `macro_rules!`.

**Newtype.** A single-field tuple struct creates a distinct type (`Miles` vs
`Kilometres`), hides secrets (a `Password(String)` whose `Display` prints `****`), or
restricts the trait set. No runtime cost; the cost is forwarding boilerplate
(`derive_more` helps).

**RAII with guards.** Acquire in a constructor, release in `Drop`, and expose the resource
only through a guard that implements `Deref` (as `MutexGuard` does). The borrow checker
stops references obtained through the guard from outliving it.

**Strategy.** Interchangeable algorithms as a trait with a generic bound for static
dispatch; for small variations, a closure bound (`F: Fn(u8, u8) -> u8`) is enough.

**Visitor.** Run several algorithms over heterogeneous data (an AST) without modifying
it: a `Visitor<T>` trait with one `visit_*` method per node type, plus shared `walk_*`
traversal helpers. For homogeneous data, use iterators.

### Creational

**Builder.** `Foo::builder()` returns `FooBuilder` with chained setters and `build()`.
Avoids constructor proliferation and lets you add fields without breaking callers.
Setters that take `&mut self` are often more ergonomic than by-value. `derive_builder`
removes the boilerplate.

**Fold.** Map a tree into a new tree with a `Folder` trait whose default `fold_*` methods
recurse into children; override only the nodes you change. (Not `Iterator::fold`.)

### Structural

**Prefer small crates.** Single-purpose crates compose, build in parallel, and get
reused. Costs: dependency hell (two `url` versions give incompatible `Url` types), no
curation on crates.io, less cross-crate LTO.

**Contain unsafety in small modules.** Put `unsafe` in the smallest module that can
uphold its invariants and wrap it in a safe interface. `String` is a `Vec<u8>` whose safe
methods maintain the UTF-8 invariant.

**Compose structs.** When one large struct causes borrow conflicts, split it into
smaller structs and compose them in the parent; each piece can then be borrowed
separately, and the design usually improves.

## Anti-patterns

**Clone to satisfy the borrow checker.** A `.clone()` added only to make a borrow error
go away creates a separate copy whose later changes aren't reflected in the original.
`Rc` / `Arc` clones are cheap and fine. Clones are acceptable in prototypes, but should
be deliberate; fix the ownership design or use `mem::take` / `replace`. Clippy flags
unnecessary clones.

**`#![deny(warnings)]`.** New compiler releases add lints that start as warnings, so the
build breaks after a toolchain update, and it blocks extra lint tools. Use
`RUSTFLAGS="-D warnings"` in CI or deny specific lints by name.

**Deref polymorphism.** Implementing `Deref<Target = Base>` on `Derived` to inherit
methods is surprising: no subtyping, `Base`'s traits don't carry over in bounds, `self`
semantics differ, and the implicit mechanism misleads readers. `Deref` is for smart
pointers. Write explicit forwarding methods, define a trait, or use a delegation crate
(`delegate`, `ambassador`).

## Functional programming

**Paradigms.** Imperative says how; declarative says what. Prefer iterator combinators
to mutable accumulation loops: `(1..11).fold(0, |a, b| a + b)`.

**Generics as type classes.** Each generic argument produces a distinct type, so encode
protocol or state in a type parameter and invalid calls fail to compile:
`impl FileDownloadRequest<Nfs> { fn mount_point(&self) -> &Path }` doesn't exist for the
BOOTP variant. Alternatives: builder for construction-time splits, strategy when only
behavior varies. Cost: larger binary.

**Functional optics.** Iso, Poly Iso, and Prism, illustrated through Serde's Visitor API.
Rarely used directly in Rust; useful mainly for reading APIs such as Serde.
