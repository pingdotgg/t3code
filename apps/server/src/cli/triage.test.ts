// @effect-diagnostics nodeBuiltinImport:off - CLI integration spawns a fake agent from PATH.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { TRIAGE_PROMPT_FILE_NAME } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

import { cli } from "../binCli.ts";
import { buildTriageLaunchPrompt } from "../triage/triagePrompt.ts";

const FAILING_AGENT_POSIX = `#!/bin/sh
echo "Error: There is not enough space on the disk. (os error 112)" >&2
exit 1
`;
const FAILING_AGENT_WINDOWS = `@echo Error: There is not enough space on the disk. (os error 112) 1>&2
@exit /b 1
`;

it.live("a failed agent launch points at the prompt it could not run", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-triage-cli-" });
    const binDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-triage-bin-" });
    NodeFS.writeFileSync(NodePath.join(binDir, "codex"), FAILING_AGENT_POSIX, { mode: 0o755 });
    NodeFS.writeFileSync(NodePath.join(binDir, "codex.cmd"), FAILING_AGENT_WINDOWS);
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.stubEnv("PATH", `${binDir}${NodePath.delimiter}${process.env.PATH ?? ""}`),
      ),
      () => Effect.sync(() => vi.unstubAllEnvs()),
    );
    const previousExitCode = process.exitCode;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        process.exitCode = previousExitCode;
      }),
    );

    yield* Command.runWith(cli, { version: "0.0.0" })([
      "triage",
      "--agent",
      "codex",
      "--base-dir",
      baseDir,
    ]);
    const output = (yield* TestConsole.logLines).join("\n");

    assert.equal(process.exitCode, 1);
    const promptFilePath = NodeFS.readdirSync(baseDir, { recursive: true, encoding: "utf8" })
      .filter((entry) => NodePath.basename(entry) === TRIAGE_PROMPT_FILE_NAME)
      .map((entry) => NodePath.join(baseDir, entry))[0];
    assert.isDefined(promptFilePath);
    assert.include(output, promptFilePath);
    assert.include(output, buildTriageLaunchPrompt(promptFilePath));
    assert.include(output, NodePath.join(NodePath.dirname(promptFilePath), "context.md"));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer))),
);
