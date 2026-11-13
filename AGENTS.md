# conn-server

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
2. **Memory first.** One tokio thread, no worker pools, blocking work on `spawn_blocking`.
   No cache, buffer, map or queue that grows without bound. Measure before and after a change
   that holds state.
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
8. **Checks stay green.** Run `tools/check.sh` before you say that work is done.
9. **Commit locally.** The remote is `hardimpactdev/conn-server` (private). Push or open a
   pull request only when Nick asks.

## Providers

The T3 server is the specification for every provider: the executable, argv, environment,
identity markers, the first handshake, every request we send, the system prompt text, and the
shutdown. Follow it byte for byte where a provider can see it.

| Provider | The official way, as the T3 server uses it | Here |
| --- | --- | --- |
| Claude | Anthropic's Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), at the T3 server's version | The SDK runs in a small Node helper that the Rust server starts. The helper starts with the first session and stops after the last. |
| Codex | `codex app-server`, JSON-RPC over stdio | `crates/conn-provider-codex` |
| Cursor, OpenCode, Muse | The vendor's SDK | Not built. They go in the same Node helper. |
| Grok, Kiro, fx, Antigravity, ACP registry | ACP (Agent Client Protocol) over stdio | Not built. One Rust ACP provider for all of them. |
| Pi | | Out of scope. |

- Never write a vendor SDK's private protocol by hand, and never set an SDK's identity markers
  by hand. If the T3 server uses an SDK, we use that SDK.
- Never read, store or pass on a provider's credentials, and never call a provider's API from
  the server. Only the official binary or SDK does that.
- Pin the same SDK and CLI versions as the T3 server at the pinned Conn commit.
- A change to a provider needs a comparison of what we send with what the T3 server sends for
  the same input, from recordings or a stub executable. Reading the code is not proof.
- Until the Node helper is merged, `crates/conn-provider-claude` still holds an older driver
  that writes the SDK protocol itself. Do not extend it and run no live turn through it.

## Safety

- **Never touch a real T3 home.** The `conn-server` binary's default base folder is `~/.t3`,
  like `t3`. Every test, script and manual run passes `--state-dir <a temp folder>`. A
  TypeScript server started for a comparison gets its own temp `T3CODE_HOME` and a free port.
- Never change Claude, Codex or other provider settings or credentials on the machine.
- **Model calls.** `tools/check.sh` calls no model, and a new check must not call one by
  default. A live proof uses the cheapest model (Claude Haiku), few turns, behind an explicit
  flag or `--ignored`.
- Stop every process you start, by PID. Never `killall` or `pkill`.
- Never read or change the working tree of a shared Conn checkout. Use your own checkout
  (`tools/conn-checkout`).

## Commands

```sh
tools/check.sh                                   # the Rust checks; says what it skipped
CONN_MONOREPO=<conn checkout> tools/check.sh     # every check that needs no model
eval "$(tools/conn-checkout --source <conn git dir or URL>)"    # a Conn checkout at conn.pin
CONN_MONOREPO=<checkout at the new commit> tools/bump-conn.sh <commit>   # move the pin, regenerate, check, report
cargo run -p conn-server -- serve --state-dir /tmp/conn-state --project <dir>
```

`tools/check.sh` runs format, clippy with warnings as errors, the tests, the release build,
`cargo deny`, the generator checks, the Effect client, the client's own reducers, the replay,
the `/mcp` parity check and Orbit's container flow on the fake provider.

## The Conn monorepo is an input

The contract (`packages/contracts`), the web client that the recorder drives, and the
TypeScript server and adapters used for comparison live in the Conn monorepo (`nckrtl/conn`,
a fork of T3 Code). This repository pins one Conn commit in `conn.pin`.

- Run every tool from this repository. The Node tools take the monorepo root from
  `CONN_MONOREPO`, a Conn checkout at the pin after `vp i`. There is no default path.
- Generated files: `crates/conn-contract/src/generated.rs` and `methods.json`, the `/mcp` tool
  catalog and instruction texts in `crates/conn-mcp/src`, the keybinding defaults, and the
  upstream tables from `tools/gen-upstream.mjs` (`crates/conn-server/src/scopes/generated.rs`,
  `crates/conn-server/src/settings/generated.rs`, `crates/conn-contract/src/upstream.rs` with
  `T3_SERVER_VERSION`, `tools/upkeep/http-routes.json`). Never edit one by hand; change its
  generator and regenerate.
- `docs/upkeep.md` says how the pin moves and what to do when a bump is red. A nightly bot
  merges upstream T3 Code into Conn; the Conn Server follows with `tools/bump-conn.sh`.
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
| A part that follows upstream files | a pathspec in `tools/upkeep/followed-files.txt` | the bump report then prints that part's upstream commits |
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

`lints/beautiful-rust/` holds the skills' clippy set. It is not applied to the workspace yet.

## Writing

Write documents, comments, commit messages and reports in clear, brief English: common words,
short sentences, active voice, one idea per sentence. Lead with the answer. Say plainly what is
proven and what is not.
