# Claude SDK helper

A small Node program that runs Claude for the Conn Server through Anthropic's official
`@anthropic-ai/claude-agent-sdk`, pinned to 0.3.321 as the T3 server pins it. The SDK starts the
`claude` CLI and talks to it; the Rust server talks to this helper. Protocol: `PROTOCOL.md`.

- One helper serves all Claude sessions of a server. It starts with the first query and stops
  when the last one ended, so an idle server has no helper.
- It never reads or handles credentials; only the `claude` binary does.
- Its only runtime dependency is the SDK (5 MB, which imports only Node built-ins). The SDK's
  platform packages, each with a bundled `claude` binary, are omitted (`.npmrc`), as T3 omits
  them. `esbuild` is a build-time dependency for the single executable.

## Run from a checkout (development)

```sh
cd helpers/claude-sdk && npm ci
```

The server then finds `helpers/claude-sdk/index.mjs` and runs it with `node` from `PATH`
(Node 24.10 or newer). Choose another with `--claude-helper <path>` or `CONN_CLAUDE_HELPER`.

## Single executable (containers)

The Orbit bundle has no `node`, so the helper ships as a Node single executable, the way the
T3 server ships as `t3`:

```sh
./build-sea.sh      # with Node 26.12.1, the version the T3 server pins
# → dist/conn-claude-sdk-helper; put it beside conn-server (found there by default)
```

It bundles `index.mjs` and the SDK with esbuild into one ESM file and runs
`node --build-sea` (`mainFormat: "module"`, no code cache, as T3's build). On macOS it signs
the result ad hoc. A Linux build must run on Linux with the same Node (T3's
`linux-arm64-sea.ts` describes the arm64 page-size workaround).

## Memory (macOS arm64, Node 26.12.1, `ps` RSS / `footprint`)

| Helper                                               | RSS      | Footprint (private) |
| ---------------------------------------------------- | -------- | ------------------- |
| bare `node` waiting on stdin (reference)             | 49 MiB   | 13 MB               |
| idle after start, single executable                  | 86 MiB   | 43 MB               |
| idle after start, `node index.mjs`                   | 87 MiB   | 45 MB               |
| `--max-semi-space-size=1 --max-old-space-size=64`    | 84 MiB   | 42 MB               |
| `--lite-mode`                                        | 81 MiB   | 41 MB               |
| `--jitless`                                          | 84 MiB   | 46 MB               |
| in a session, turn 1 running (stub CLI)              | 88 MiB   | 44 MB               |
| after 10 turns (stub CLI)                            | 88 MiB   | 44 MB               |
| after the last session closed                        | gone     | gone                |

Loading the SDK costs about 30 MB of private memory over bare Node. The small-heap flags save
2 to 4 MB and are not set (T3 sets none). The single executable's 147 MB file is shared
read-only between containers; only the heap above is private. Measured with
`cargo run --release -p conn-provider-claude --example helper_memory`.
