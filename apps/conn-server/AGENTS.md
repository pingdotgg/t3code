# conn-server

Read `docs/status.md` first: it says what is proven, what is not, and what is left, in order.
Update it with every merged step.

The **Conn Server**: a Rust server for Conn clients. It serves the same client contract as the
**T3 server** (`apps/server` in the Conn monorepo, TypeScript on Effect) with a far smaller
memory footprint: about 4.5 MiB idle against about 300 MiB. The T3 server stays as upstream
has it. This server is our own. One server runs in each Orbit container; never design for one
shared server.

Read `README.md` before you change code. It gives the crates, the three interfaces (Provider,
Engine, method table), the wire, and the checks. Each crate has its own `README.md`.

## Rules

1. **Own implementation.** Reproduce behaviour at three boundaries: the client contract,
   `/mcp`, and the provider protocols. Read the TypeScript server to learn what a caller
   expects, then design in Rust. Never translate the Effect code.
2. **Memory first.** One tokio thread, no worker pools. Blocking work runs on
   `spawn_blocking`, never on the runtime thread; `std::fs`, `std::process`, SQLite, `flock`
   and `fsync` count. No cache, buffer, map or queue that grows without bound. Measure before
   and after a change that holds state.
3. **Providers: only the official way, and exactly as the T3 server does.** See
   [Providers](#providers). A difference from the T3 server in how we start or talk to an
   agent is a defect, not a design choice.
4. **Maintained crates.** Prefer a popular, actively maintained crate over our own code when
   its measured cost in binary size and memory is small and it fits the one-thread runtime.
   Check a crate's state on crates.io, not from memory. State each new dependency and why.
5. **A panic stops the server** (`panic = "abort"`). No `unwrap`, `expect`, indexing or
   slicing on a path that outside input can reach: a client, a provider, `git` output, a file,
   a stored row. `unsafe` is forbidden in our code.
6. **Parity is proven, not assumed.** Each feature has a check against the TypeScript server
   or a recording of the real client. A method we do not serve stays unregistered and answers
   "not supported". A capability is advertised only when the server serves it.
7. **Drift must fail a check.** When upstream can change something, generate it from the Conn
   monorepo or test it against the monorepo. Do not copy a list, a text or a default by hand
   when a generator or a check can hold it.
8. **Checks stay green.** Run `tools/check.sh` before you say that work is done. On a Mac it
   proves macOS only: the compiler and clippy never see code marked for Linux
   (`#[cfg(target_os = "linux")]`). CI runs the same checks on Linux, so read the CI result
   after a push. To run them on a Linux host that has the pinned Rust version as its own
   toolchain, set `RUSTUP_TOOLCHAIN=stable RUSTUP_AUTO_INSTALL=0`, or `rustup` installs a
   second copy.
9. **Commit locally.** The Conn Server lives in the Conn monorepo (`nckrtl/conn`, public),
   in `apps/conn-server`. Push or open a pull request only when Nick asks. Its history up to
   2026-11-15 came from `hardimpactdev/conn-server`, which it replaces.

## Providers

The T3 server is the specification for every provider: the executable, argv, environment,
identity markers, the first handshake, every request we send, the system prompt text, and the
shutdown. Follow it byte for byte where a provider can see it.

| Provider | The official way, as the T3 server uses it | Here |
| --- | --- | --- |
| Claude | Anthropic's Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), at the T3 server's version | `crates/conn-provider-claude` and the SDK host (`helpers/sdk-host`), a small Node program that the Rust server starts with the first session and stops after the last |
| Codex | `codex app-server`, JSON-RPC over stdio | `crates/conn-provider-codex` |
| Cursor, OpenCode, Muse | The vendor's SDK | Not built. They go in the same Node helper. |
| Grok, Kiro, fx, Antigravity, ACP registry | ACP (Agent Client Protocol) over stdio | `crates/conn-provider-acp`: Grok built and offered by the server (off until settings enable it, as in T3), with `/compact`, background work and subagents; subagents carried over to a later turn, and the other flavors, not built. Proofs: its `tools/conformance.mjs`, `tools/probe-conformance.mjs`, the replay in `cargo test`, and the engine's fixture replay |
| Pi | | Out of scope. |

- Never write a vendor SDK's private protocol by hand, and never set an SDK's identity markers
  by hand. If the T3 server uses an SDK, we use that SDK.
- Never read, store or pass on a provider's credentials, and never call a provider's API from
  the server. Only the official binary or SDK does that.
- Pin the same SDK and CLI versions as the T3 server in this tree.
- A change to a provider needs a comparison of what we send with what the T3 server sends for
  the same input, from recordings or a stub executable. Reading the code is not proof.
- The Node helper is the SDK host, `helpers/sdk-host` (protocol in its `PROTOCOL.md`). It runs
  every vendor SDK; a new SDK provider is one more driver module there, not a second helper.
- The proofs for Claude: `crates/conn-provider-claude/tools/conformance/run.sh` (a stub CLI
  records argv, environment and stdin from both servers; they must be equal) and
  `tools/t3-replay/run.sh` (the T3 server's own Claude transcripts against our session). Rerun
  both on every SDK or CLI change, and after an upstream sync.

## Safety

- **Never touch a real T3 home.** The `conn-server` binary's default base folder is `~/.t3`,
  like `t3`. Every test, script and manual run passes `--state-dir <a temp folder>`. A
  TypeScript server started for a comparison gets its own temp `T3CODE_HOME` and a free port.
- Never change Claude, Codex or other provider settings or credentials on the machine, and
  never read them, nor `gh` or `git` settings, in a check. **The canary check holds this
  rule**: `tools/canary.mjs`, the last check in `tools/check.sh`. Every check runs with a
  decoy HOME, marker variables, a stand-in `SHELL` and a watched `TMPDIR`. The canary fails
  when a decoy file was read or the decoy home changed. It also fails when a marker reached any
  output or file, or when our code has a passwd home lookup. It also fails when a check ran a
  provider or host CLI (marker executables first on `PATH`) or connected outside loopback (a
  Node hook, and `CONN_NETWORK_LOG` in our server). A process that a tool starts gets
  `sealedEnv` (its `PATH` holds no provider or host CLI), `sealedNodeEnv` or `sealedCargoEnv`
  from `tools/sealed-env.mjs`. A `git` run gets `gitEnv`, and a `cargo build` gets
  `cargoBuildEnv`. Never pass the shell's environment, `HOME` or `SHELL` on, and never use
  `env -i` without `HOME=`.
- **Hand runs are sealed.** `.cargo/config.toml` runs every binary that cargo starts (tests,
  examples, benches, `cargo run`) through `tools/cargo-runner`: a throwaway HOME, the
  allow-list environment of `tools/sealed-env.mjs` (`sealedRunEnv`), a stand-in `SHELL`, a
  `PATH` without provider or host CLIs, no global git configuration, the status probes and the
  manifest fetch off. It needs `node`. In a test binary, `conn_support::spawn_guard` stops the
  run when a provider or host CLI would start from outside the temp folder or the workspace.
  The `sealed-run` check proves both. **The way out** is `CONN_UNSEALED=1`, only for the live
  tests (`--ignored`), the recorder with a live model, and the server by hand with a real
  login; the runner prints a warning, and `tools/check.sh` and CI refuse it. Never set it in a
  script. Cargo itself still reads `~/.gitconfig` through `HOME`: run it with
  `sealedCargoEnv` or `cargoBuildEnv` from a tool.
- **Model calls.** `tools/check.sh` calls no model, and a new check must not call one by
  default. A live proof uses the cheapest model (Claude Haiku), few turns, behind an explicit
  flag or `--ignored`.
- Stop every process you start, by PID. Never `killall` or `pkill`.
- Never read or change the working tree of a shared Conn checkout. Work in your own checkout
  or worktree of the monorepo; the capture tools write temporary test files into its
  `apps/server`.

## Commands

```sh
(cd ../.. && vp i)                               # once: the monorepo's node_modules
tools/check.sh                                   # every check that needs no model
tools/follow-conn.sh [--capture]                 # follow Conn: regenerate, check, report
cargo run -p conn-server -- serve --state-dir /tmp/conn-state --project <dir>   # sealed; CONN_UNSEALED=1 for a real login
(cd helpers/sdk-host && npm ci)                  # once, so Claude can run from a checkout
crates/conn-provider-claude/tools/conformance/run.sh
```

`tools/check.sh` runs format, clippy with warnings as errors, the tests, the release build,
`cargo deny`, the generator checks, the Effect client, the client's own reducers, the replay,
the `/mcp` parity check and Orbit's container flow on the fake provider.

## The Conn monorepo is an input

The contract (`packages/contracts`), the web client that the recorder drives, and the
TypeScript server and adapters used for comparison live in the Conn monorepo (`nckrtl/conn`,
a fork of T3 Code). The Conn Server sits inside it, in `apps/conn-server`, so it always
follows the Conn commit it is part of. There is no pin.

- Run every tool from `apps/conn-server`. The Node tools read the monorepo two levels up
  (`tools/monorepo.mjs`) and resolve packages from its `node_modules`: run `vp i` at the
  monorepo root first.
- Generated files: `crates/conn-contract/src/generated.rs` and `methods.json`, the `/mcp` tool
  catalog and instruction texts in `crates/conn-mcp/src`, the keybinding defaults, and the
  upstream tables from `tools/gen-upstream.mjs` (`crates/conn-server/src/scopes/generated.rs`,
  `crates/conn-server/src/settings/generated.rs`, `crates/conn-contract/src/upstream.rs` with
  `T3_SERVER_VERSION`, `tools/upkeep/http-routes.json`). Never edit one by hand; change its
  generator and regenerate.
- `docs/upkeep.md` says how the Conn Server follows Conn and what to do when a check is red.
  The nightly sync follows the Conn Server too: it ports the in-scope upstream server changes
  and waits for the Conn Server checks (Nick, 2026-11-16; `FORK.md`, "Upstream scope").
- Do not change TypeScript in the Conn monorepo for Conn Server work.

## Where things go

| To add | Put it in | Then |
| --- | --- | --- |
| An RPC method in an existing area | that area's file in `crates/conn-server/src/methods/` | the method table checks the tag, the kind and the scope against the contract at start; add a call to `crates/conn-server/tools/effect-client.mjs`, or the `decode coverage` check fails |
| A new area | a new file there, and one line in `methods/mod.rs` | |
| An engine command or event | `crates/conn-engine` (`commands.rs`, `runner.rs`, `store.rs`) | prove it with `crates/conn-engine/tools/client-check.mjs` |
| An `/mcp` tool | `crates/conn-mcp/src/tools/` | `gen-tools.mjs --check` and `parity.mjs` |
| A provider | a crate that implements `Provider` and `Session` from `crates/conn-provider`; shared parts go in `crates/conn-provider-support` | replay tests against the T3 adapter's events, and the comparison in [Providers](#providers) |
| A settings rule | `crates/conn-server/src/settings.rs` | add a case to `crates/conn-server/tools/settings-cases.json`; `settings-diff.mjs` runs it against the T3 server's own functions |
| A capability or `ServerConfig` flag | `capabilities` / `config_flags` in `crates/conn-server/src/environment.rs` | advertise only what the server serves |
| A part that follows upstream files | a pathspec in `tools/upkeep/followed-files.txt` | the `follow-conn.sh` report then prints that part's upstream commits |
| A helper two crates need (time, hex, base64, HMAC, atomic file write, ids) | `crates/conn-support`: std only (plus `sha2`, `uuid`, `getrandom`), no async, no state | a test there |
| A dependency | the workspace `Cargo.toml` | state why and what it costs; `cargo deny` must pass |

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
- Dependencies cost binary size and memory here, so rule 4 above decides, with numbers.
- `crates/conn-contract/src/generated.rs` is generated. Never edit or review it by hand;
  change the generator.

`lints/beautiful-rust/` holds the skills' clippy set. The workspace turns on part of it in
`Cargo.toml` and `clippy.toml`; `CRATES.md` ("Lint set") says which, why, and what follows in
which stage.

## Writing

Write documents, comments, commit messages and reports in clear, brief English: common words,
short sentences, active voice, one idea per sentence. Lead with the answer. Say plainly what is
proven and what is not.
