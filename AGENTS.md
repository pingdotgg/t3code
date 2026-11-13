# conn-server

The Conn Server: a Rust server for Conn clients. It serves the same client contract as the
T3 server (`apps/server` in the Conn monorepo, TypeScript on Effect) with a far smaller memory
footprint. The T3 server stays as upstream has it. This server is our own.

Read `README.md` before you change code. It gives the crates, the three interfaces (Provider,
Engine, method table), the wire, and the checks.

## Rules

1. **Own implementation.** Reproduce behaviour at three boundaries: the client contract,
   `/mcp`, and the provider CLI protocols. Read the TypeScript server to learn what a caller
   expects, then design in Rust. Never translate the Effect code.
2. **Memory first.** One tokio thread, no worker pools, blocking work on `spawn_blocking`.
   No cache or buffer that grows without bound. Measure before and after a change that holds
   state.
3. **Maintained crates.** Prefer a popular, actively maintained crate over our own code when
   its measured cost in binary size and memory is small and it fits the one-thread runtime.
   Check a crate's state on crates.io, not from memory. State each new dependency and why.
4. **A panic stops the server** (`panic = "abort"`). No `unwrap` or indexing on a path that
   outside input can reach. `unsafe` is forbidden in our code.
5. **Parity is proven, not assumed.** Each feature has a check against the TypeScript server
   or a recording of the real client. A method we do not serve stays unregistered and answers
   "not supported".
6. **Checks stay green:** `cargo test --workspace`, `cargo clippy --workspace --all-targets`,
   `cargo fmt --check`.
7. Commit locally. Push or open a pull request only when Nick asks.

## Skills

Three skills from [BeautifulRust](https://github.com/morganlinton/BeautifulRust) live in
`.claude/skills` (see `VENDORED.md`):

- `rust-best-practices`: follow it whenever you write or change Rust here.
- `rust-review`: use it for reviews of a crate or a diff.
- `rust-port`: use it when you bring a feature over from the TypeScript server. Its first two
  steps are our method too: list the observable behaviour, then port or record the tests
  before the code.

Where this project differs from the skills:

- This is an application, not a library. The library-only rules (`missing_docs`,
  `# Errors` sections, `#[non_exhaustive]`) apply to crate boundaries only where they help
  a reader.
- Dependencies cost binary size and memory here, so rule 3 above decides, with numbers.
- `crates/conn-contract/src/generated.rs` is generated. Never edit or review it by hand;
  change the generator.

`lints/beautiful-rust/` holds the skills' clippy set. It is not applied to the workspace yet.

## The Conn monorepo is an input

The contract (`packages/contracts`), the web client used by the recorder, and the TypeScript
adapters used for comparison live in the Conn monorepo (`nckrtl/conn`). This repository pins
one Conn commit (`crates/conn-contract/methods.json`). Run every tool from this repository.
The Node tools (`crates/*/tools`, `fixtures/recorder`) take the monorepo root from
`CONN_MONOREPO`, a Conn checkout after `vp i`; there is no default. `tools/check.sh` runs all
checks that need no model, and the Rust-only part without `CONN_MONOREPO`.
