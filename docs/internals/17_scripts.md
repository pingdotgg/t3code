# Scripts

Repository and package scripts are written in TypeScript with Effect and `effect/cli`, executed directly by the pinned Node runtime (`#!/usr/bin/env node`). Do not route around Effect with plain Node glue scripts.

## Rules

- **CLI parsing with `effect/cli`.** Define commands, flags, and positional args with `Command.make`, `Flag`, and `Argument` (validating values with `Flag.withSchema`). Do not hand-roll `process.argv` parsers or add third-party CLI parsers.
- **Platform services over raw Node built-ins.** Use Effect platform services—`FileSystem.FileSystem`, `Path.Path`, `ChildProcess` / `ChildProcessSpawner`, `Config`, `Console`, and `HttpClient`—provided via `@effect/platform-node/NodeServices`. Do not import `node:fs`, `node:child_process`, or read `process.env` directly, and do not suppress `nodeBuiltinImport` unless an external API genuinely requires it (with an explicit `-- <reason>` comment).
- **Scoped resources and typed errors.** Follow [Effect services](./02_effect-services.md): subpath namespace imports (`import * as Effect from "effect/Effect"`), `Schema.TaggedError` for failures, `Effect.fn("...")` for reusable steps, and `Effect.scoped` (such as `fs.makeTempDirectoryScoped`) so temporary directories and child processes always clean up.
- **Importable and testable entrypoints.** Export the core Effect functions and guard CLI execution behind `if (import.meta.main)`:

  ```ts
  if (import.meta.main) {
    Command.run(command, { version: "0.0.0" }).pipe(
      Effect.provide(NodeServices.layer),
      NodeRuntime.runMain,
    );
  }
  ```

- **References:** [`scripts/build-npm-launcher.ts`](../../scripts/build-npm-launcher.ts) and [`scripts/resolve-nightly-release.ts`](../../scripts/resolve-nightly-release.ts).

## Exceptions

Thin bootstrap shims that run before dependencies exist (such as `scripts/install.sh` / `scripts/install.ps1` and the zero-dependency `scripts/npm-launcher/t3.mjs`) and e2e test files under `scripts/scenarios/` (which run under the `e2e` runner) do not use `effect/cli`.
