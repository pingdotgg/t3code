import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { CursorTextGenerationLive } from "./CursorTextGeneration.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const CursorTextGenerationTestLayer = CursorTextGenerationLive.pipe(
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3code-cursor-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

function makeFakeAgentBinary(
  dir: string,
  input: {
    result: string;
    requireModel?: string;
    requireTrust?: boolean;
    requireMode?: string;
    stdinMustContain?: string;
    stderr?: string;
    exitCode?: number;
  },
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    const agentPath = path.join(binDir, "agent");
    yield* fs.makeDirectory(binDir, { recursive: true });

    yield* fs.writeFileString(
      agentPath,
      [
        "#!/bin/sh",
        'model=""',
        'seen_trust="0"',
        'mode=""',
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "--model" ]; then',
        "    shift",
        '    model="$1"',
        "    shift",
        "    continue",
        "  fi",
        '  if [ "$1" = "--trust" ]; then',
        '    seen_trust="1"',
        "    shift",
        "    continue",
        "  fi",
        '  if [ "$1" = "--mode" ]; then',
        "    shift",
        '    mode="$1"',
        "    shift",
        "    continue",
        "  fi",
        "  shift",
        "done",
        'stdin_content="$(cat)"',
        ...(input.requireModel !== undefined
          ? [
              `if [ "$model" != "${input.requireModel}" ]; then`,
              '  printf "%s\\n" "unexpected model: $model" >&2',
              "  exit 11",
              "fi",
            ]
          : []),
        ...(input.requireTrust
          ? [
              'if [ "$seen_trust" != "1" ]; then',
              '  printf "%s\\n" "missing --trust" >&2',
              "  exit 12",
              "fi",
            ]
          : []),
        ...(input.requireMode !== undefined
          ? [
              `if [ "$mode" != "${input.requireMode}" ]; then`,
              '  printf "%s\\n" "unexpected mode: $mode" >&2',
              "  exit 13",
              "fi",
            ]
          : []),
        ...(input.stdinMustContain !== undefined
          ? [
              `if ! printf "%s" "$stdin_content" | grep -F -- ${JSON.stringify(input.stdinMustContain)} >/dev/null; then`,
              '  printf "%s\\n" "stdin missing expected content" >&2',
              "  exit 14",
              "fi",
            ]
          : []),
        ...(input.stderr !== undefined
          ? [`printf "%s\\n" ${JSON.stringify(input.stderr)} >&2`]
          : []),
        "cat <<'__T3CODE_FAKE_AGENT_OUTPUT__'",
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: input.result,
        }),
        "__T3CODE_FAKE_AGENT_OUTPUT__",
        `exit ${input.exitCode ?? 0}`,
        "",
      ].join("\n"),
    );
    yield* fs.chmod(agentPath, 0o755);
    return agentPath;
  });
}

function withFakeAgentEnv<A, E, R>(
  input: {
    result: string;
    requireModel?: string;
    requireTrust?: boolean;
    requireMode?: string;
    stdinMustContain?: string;
    stderr?: string;
    exitCode?: number;
  },
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-cursor-text-" });
      const agentPath = yield* makeFakeAgentBinary(tempDir, input);
      const serverSettings = yield* ServerSettingsService;
      const previousSettings = yield* serverSettings.getSettings;
      yield* serverSettings.updateSettings({
        providers: {
          cursor: {
            binaryPath: agentPath,
          },
        },
      });
      return { serverSettings, previousBinaryPath: previousSettings.providers.cursor.binaryPath };
    }),
    () => effect,
    ({ serverSettings, previousBinaryPath }) =>
      serverSettings
        .updateSettings({
          providers: {
            cursor: {
              binaryPath: previousBinaryPath,
            },
          },
        })
        .pipe(Effect.asVoid),
  );
}

it.layer(CursorTextGenerationTestLayer)("CursorTextGenerationLive", (it) => {
  it.effect("uses agent CLI model ids instead of ACP bracket notation for commit messages", () =>
    withFakeAgentEnv(
      {
        result: JSON.stringify({
          subject: "Add generated commit message",
          body: "- verify agent model mapping",
        }),
        requireModel: "composer-2-fast",
        requireTrust: true,
        requireMode: "ask",
        stdinMustContain: "Staged patch:",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/cursor-text-generation",
          stagedSummary: "M apps/server/src/git/Layers/CursorTextGeneration.ts",
          stagedPatch:
            "diff --git a/apps/server/src/git/Layers/CursorTextGeneration.ts b/apps/server/src/git/Layers/CursorTextGeneration.ts",
          modelSelection: {
            provider: "cursor",
            model: "composer-2",
            options: { fastMode: true },
          },
        });

        expect(generated.subject).toBe("Add generated commit message");
        expect(generated.body).toBe("- verify agent model mapping");
      }),
    ),
  );

  it.effect("accepts json objects with extra text around them from agent output", () =>
    withFakeAgentEnv(
      {
        result:
          'Sure, here is the JSON:\n```json\n{\n  "subject": "Update README dummy comment with attribution and date",\n  "body": ""\n}\n```\nDone.',
        requireModel: "composer-2",
        requireTrust: true,
        requireMode: "ask",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/cursor-noisy-json",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: {
            provider: "cursor",
            model: "composer-2",
          },
        });

        expect(generated.subject).toBe("Update README dummy comment with attribution and date");
        expect(generated.body).toBe("");
      }),
    ),
  );
});
