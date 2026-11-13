---
name: rust-port
description: >-
  Port code from C, C++, Python, Go, JavaScript, or TypeScript into idiomatic Rust that
  keeps the original behavior: ownership instead of manual memory, Result instead of error
  codes and exceptions, enums instead of flag ints and magic strings, and tests that prove
  the port matches. Use this whenever the user asks to port, translate, convert, migrate,
  or rewrite code in Rust ("rewrite this in Rust", "what would this look like in Rust",
  "move this module to Rust"), even if they don't say "port". Pairs with the
  rust-best-practices skill, which covers the target code's style.
---

# Rust port

The goal is the Rust a Rust developer would have written to solve the same problem, with
the same observable behavior. A line-by-line transliteration (C written in Rust syntax,
or Python with `Box<dyn Any>`) compiles but keeps every problem the original had and adds
the borrow checker on top. Port the behavior, not the structure.

## 1. Understand the original before writing anything

1. **Read the code and its tests**, and anything that calls it, if you have it.
2. **List the observable behavior**: every public function, its inputs, its outputs, and
   every way it can fail. Include the quiet parts, which are where ports go wrong:
   ordering of results, how ties break, what happens on empty input, whitespace and case
   handling, integer limits, and what counts as an error versus a valid edge case.
3. **Note what is incidental**, meaning things the original only does because of its
   language: manual memory management, out-parameters, `NULL` returns, global state,
   fixed-size buffers, a class that exists only to group functions, or `isinstance`
   checks. These don't carry over.
4. If the original has a bug or an ambiguity, keep its behavior, flag it in the porting
   notes, and let the user decide. A port is not the place to silently fix things.

## 2. Port the tests first

Translate the original tests into Rust tests before porting the implementation. Keep one
Rust test per original test, with a name that maps back to it, so a reader can check
coverage. The tests are the definition of "same behavior". If the original has no tests,
write characterization tests from the behavior list in step 1.

## 3. Design the Rust API, then implement it

Decide the public types and signatures from the behavior list, not from the original's
shape. Then implement against the ported tests.

### From C and C++

| In the original | In Rust |
|---|---|
| `malloc`/`free`, `new`/`delete`, `create`/`destroy` pairs | Owned types (`String`, `Vec`, `Box`) dropped automatically; `Drop` for anything else |
| `NULL` meaning "absent" | `Option<T>` |
| Error codes (`-1`, `ERR_*` defines), `errno` | `Result<T, E>` with an error enum, one variant per code, implementing `Display` and `std::error::Error` |
| Out-parameters (`int *err_line`, `long *out`) | Return values: put the data in the `Ok` value or the error variant |
| Flag bitmasks (`FLAG_A \| FLAG_B`) | An options struct with named fields and `Default`, or the `bitflags` crate; never a raw `u32` |
| `char *` plus length, `strcmp`, `strcasecmp` | `&str`/`String`, `==`, `eq_ignore_ascii_case` |
| Pointer plus count, iterator by index | Slices, iterators |
| Fixed-size buffers and their truncation | Growable types; drop the limit unless the limit is behavior |
| `#define` constants and macros | `const`, enums, and functions |
| Global or static mutable state | A struct the caller owns |
| `strtol` and friends | `str::parse` with the matching integer type; map parse failures to your error enum |

Don't write `unsafe` or use raw pointers unless the port must talk to C through FFI, and
then confine it as the `rust-best-practices` skill describes.

### From Python

| In the original | In Rust |
|---|---|
| An exception hierarchy | One error enum (or one per area) with a variant per exception class; data attributes become variant fields |
| `None` as a value | `Option<T>` |
| Strings used as a closed set (`kind in ("build", "test")`) | An enum, with `FromStr` and `Display` for the text form |
| Dicts or classes used as records | Structs with named fields |
| `dict` iteration order (insertion order is guaranteed) | `Vec` or an ordered map when order is observable; a plain `HashMap` silently changes output order |
| Duck typing, `isinstance` | Traits or enums |
| Unbounded `int` | A sized integer chosen on purpose, with overflow handled (`checked_*`) where input can be large |
| `sorted(..., key=...)` | `sort_by_key` or `sort_by`; both are stable, like Python's |
| `str.splitlines()`, `strip()`, `isalnum()` | `lines()`, `trim()`, `char::is_alphanumeric`; check edge cases such as `\r\n`, Unicode, and empty strings against the original |
| `try`/`except` around a parse | `?` with a mapped error, or `match` on the `Result` |

### From Go, JavaScript, and TypeScript

- Go `(value, error)` returns become `Result`; `nil` becomes `Option`; interfaces become
  traits; goroutines and channels become threads with `std::sync::mpsc` or async tasks,
  depending on what the original needs.
- JavaScript `null` and `undefined` become `Option`; thrown errors become `Result`; plain
  objects become structs; numbers become a sized integer or `f64`, chosen on purpose.

## 4. Keep the port proportionate

A port that matches the original on every possible input is usually the wrong goal.
Match it on the inputs it actually receives, and use Rust's standard library for the rest.

- **Don't reimplement the source language's runtime.** Use `str::lines`, `str::trim`,
  `str::parse`, and `char` methods, not hand-written copies of Python's `splitlines`,
  `strip`, `int()`, or `repr()`, or of C's locale-dependent `isspace` and `strtol`. Where
  Rust's behavior differs only on exotic input, such as Unicode digits, non-ASCII
  whitespace, or unbounded integers, list the difference in the porting notes instead of
  coding around it. Write a compatibility shim only when the user says those inputs occur.
- **Don't grow the API.** Port the public surface the original has, plus the standard
  trait impls Rust callers expect (`Debug`, `Clone`, `Display`, `Error`, `FromStr`,
  `Default`, and `IntoIterator` for collections). Skip builders, `Index` impls,
  `FromIterator`, `Extend`, and custom iterator types unless the original's callers need
  them.
- **Keep the algorithm unless it's wrong.** Swap in a different algorithm only to fix a
  real problem, such as quadratic behavior on realistic input, and say so in the notes.
- **Check the size.** Count code lines, excluding tests, comments, and doc comments. A
  port from C or C++ usually lands near the original's size. A port from Python or
  JavaScript usually lands at two to three times the original, because types, error
  enums, and their trait impls are explicit in Rust. Much more than that usually means one
  of the three habits above.

Differential testing against the original is worth doing, but a few dozen realistic and
edge-case inputs answer the question. A fuzzing harness over millions of inputs usually
just finds exotic divergences that belong in the notes.

## 5. Verify

Run these if a Rust toolchain is available, and fix everything before reporting:

```bash
cargo build
cargo test
cargo clippy --all-targets -- -D warnings
```

Every ported test must pass. If the original's tests can be run too, run them and compare
results on the same inputs.

## 6. Write the porting notes

Alongside the code, write a short `PORTING.md` that a reviewer can check in a few
minutes:

- **API mapping:** a table from each original function or type to its Rust equivalent.
- **Test mapping:** each original test and the Rust test that covers it.
- **Deliberate differences:** anything that now behaves differently and why, such as an
  out-of-memory error that no longer exists, a fixed buffer limit that's gone, or exotic
  input where Rust's standard library behaves differently from the original's.
- **Preserved quirks:** odd behavior kept on purpose, so nobody "fixes" it by accident.
- **Verification:** which commands you ran and their result, or a plain statement that
  you couldn't run them.

For the style of the Rust itself, follow the `rust-best-practices` skill if it is
installed.
