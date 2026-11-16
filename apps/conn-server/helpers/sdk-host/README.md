# SDK host

A small Node program that runs vendor SDKs for the Conn Server the way the T3 server runs them.
Today it has one driver, `claude` (`drivers/claude.mjs`): Anthropic's official
`@anthropic-ai/claude-agent-sdk`, pinned to 0.3.321 as the T3 server pins it. The SDK starts the
`claude` CLI and talks to it; the Rust server talks to this host. Protocol: `PROTOCOL.md`.
Other SDK drivers the T3 server uses (Cursor, OpenCode, Muse) can join as further modules.

- One host serves every driver and session. It starts with the first query and stops when the
  last one ended, so an idle server has no host. A driver module is imported on first use.
- It never reads or handles credentials; only the `claude` binary does.
- Its only runtime dependency is the Claude SDK (5 MB, which imports only Node built-ins). The
  SDK's platform packages, each with a bundled `claude` binary, are omitted (`.npmrc`), as T3
  omits them. `esbuild` builds the single executable; it lives in `build/` with its own
  lockfile, which pins its platform package, so the build installs nothing outside a lockfile
  and runs no install script.

## Run from a checkout (development)

```sh
cd helpers/sdk-host && npm ci
```

The server then finds `helpers/sdk-host/index.mjs` and runs it with `node` from `PATH`
(Node 24.10 or newer). Choose another with `--sdk-host <path>` or `CONN_SDK_HOST`.

## Single executable (containers)

The Orbit bundle has no `node`, so the helper ships as a Node single executable, the way the
T3 server ships as `t3`:

```sh
./build-sea.sh      # with Node 26.12.1, the version the T3 server pins
# → dist/conn-sdk-host; put it beside conn-server (found there by default)
```

It bundles `index.mjs`, the drivers and the SDK with esbuild into one ESM file and runs
`node --build-sea` (`mainFormat: "module"`, no code cache, as T3's build). A single
executable's main module has no `import.meta.url`, which the SDK passes to `createRequire`
(`resolveSettings` failed without it); the build defines it as the executable's file URL. On macOS it signs
the result ad hoc. A Linux build must run on Linux with the same Node (T3's
`linux-arm64-sea.ts` describes the arm64 page-size workaround).

## Memory (macOS arm64, Node 26.12.1, `ps` RSS / `footprint`)

| Host                                                   | RSS      | Footprint (private) |
| ------------------------------------------------------ | -------- | ------------------- |
| bare `node` waiting on stdin (reference)               | 49 MiB   | 13 MB               |
| idle after start, single executable, no driver loaded  | 73 MiB   | 30 MB               |
| idle after start, `node index.mjs`, no driver loaded   | 53 MiB   | 14 MB               |
| in a session, turn 1 running (stub CLI, executable)    | 88 MiB   | 44 MB               |
| after 10 turns (stub CLI, executable)                  | 89 MiB   | 45 MB               |
| after the last session closed                          | gone     | gone                |

With the Claude SDK loaded (before the driver became lazy, same build otherwise):
`node index.mjs` 87 MiB / 45 MB idle; `--max-semi-space-size=1 --max-old-space-size=64`
84 MiB / 42 MB; `--lite-mode` 81 MiB / 41 MB; `--jitless` 84 MiB / 46 MB. Loading the SDK
costs about 30 MB of private memory; the small-heap flags save 2 to 4 MB and are not set (T3
sets none). The bundled single executable parses the whole bundle at start, so it idles higher
than the script. Its 147 MB file is shared read-only between containers; only the heap is
private. Measured with `cargo run --release -p conn-provider-claude --example helper_memory`.
