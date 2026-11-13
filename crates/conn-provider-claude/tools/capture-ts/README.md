# capture-ts

Feeds the recorded CLI transcripts in `testdata/cli` through the TypeScript `ClaudeAdapterV2` and
writes the events it emits to `testdata/ts/<name>.json` (`{note, offered, events}`, `driver` dropped).
The Rust replay tests compare against those files.

```sh
CONN_MONOREPO=/path/to/conn ./run.sh     # default: /Users/nckrtl/apps/conn
```

Variables: `CONN_MONOREPO` (monorepo root), `CAPTURE_CLI_DIR` (default `testdata/cli`),
`CAPTURE_OUT_DIR` (default `testdata/ts`; point it elsewhere to diff before overwriting).

`run.sh` copies `claudeCapture.test.ts` into the monorepo's `apps/server/src/orchestration-v2/Adapters/`
(its relative imports resolve only there), runs it with `vp test run`, and always deletes the copy.
The test embeds a copy of the wake harness from `ClaudeAdapterV2.test.ts`; refresh it if that harness changes.

Expected noise on a rerun: random prompt uuids in `offered`, and random uuid suffixes in runtime request ids.
`e06` runs with `approval-required`. Prompts are answered from the recorded `control_response`.
