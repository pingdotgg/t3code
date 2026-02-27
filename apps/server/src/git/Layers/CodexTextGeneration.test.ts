import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { expect } from "vitest";

import { CodexTextGenerationLive } from "./CodexTextGeneration.ts";
import { TextGenerationError } from "../Errors.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";

function makeFakeCodexBinary(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    const codexPath = path.join(binDir, "codex");
    yield* fs.makeDirectory(binDir, { recursive: true });

    yield* fs.writeFileString(
      codexPath,
      [
        "#!/bin/sh",
        'output_path=""',
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "--output-last-message" ]; then',
        "    shift",
        '    output_path="$1"',
        "  fi",
        "  shift",
        "done",
        "cat >/dev/null",
        'if [ -n "$T3_FAKE_CODEX_STDERR" ]; then',
        '  printf "%s\\n" "$T3_FAKE_CODEX_STDERR" >&2',
        "fi",
        'if [ -n "$output_path" ]; then',
        '  node -e \'const fs=require("node:fs"); const value=process.argv[2] ?? ""; fs.writeFileSync(process.argv[1], Buffer.from(value, "base64"));\' "$output_path" "${T3_FAKE_CODEX_OUTPUT_B64:-e30=}"',
        "fi",
        'exit "${T3_FAKE_CODEX_EXIT_CODE:-0}"',
        "",
      ].join("\n"),
    );
    yield* fs.chmod(codexPath, 0o755);
    return binDir;
  });
}

function withFakeCodexEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
  },
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-codex-text-" });
      const binDir = yield* makeFakeCodexBinary(tempDir);
      const previousPath = process.env.PATH;
      const previousOutput = process.env.T3_FAKE_CODEX_OUTPUT_B64;
      const previousExitCode = process.env.T3_FAKE_CODEX_EXIT_CODE;
      const previousStderr = process.env.T3_FAKE_CODEX_STDERR;

      yield* Effect.sync(() => {
        process.env.PATH = `${binDir}:${previousPath ?? ""}`;
        process.env.T3_FAKE_CODEX_OUTPUT_B64 = Buffer.from(input.output, "utf8").toString("base64");

        if (input.exitCode !== undefined) {
          process.env.T3_FAKE_CODEX_EXIT_CODE = String(input.exitCode);
        } else {
          delete process.env.T3_FAKE_CODEX_EXIT_CODE;
        }

        if (input.stderr !== undefined) {
          process.env.T3_FAKE_CODEX_STDERR = input.stderr;
        } else {
          delete process.env.T3_FAKE_CODEX_STDERR;
        }
      });

      return {
        previousPath,
        previousOutput,
        previousExitCode,
        previousStderr,
      };
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        process.env.PATH = previous.previousPath;

        if (previous.previousOutput === undefined) {
          delete process.env.T3_FAKE_CODEX_OUTPUT_B64;
        } else {
          process.env.T3_FAKE_CODEX_OUTPUT_B64 = previous.previousOutput;
        }

        if (previous.previousExitCode === undefined) {
          delete process.env.T3_FAKE_CODEX_EXIT_CODE;
        } else {
          process.env.T3_FAKE_CODEX_EXIT_CODE = previous.previousExitCode;
        }

        if (previous.previousStderr === undefined) {
          delete process.env.T3_FAKE_CODEX_STDERR;
        } else {
          process.env.T3_FAKE_CODEX_STDERR = previous.previousStderr;
        }
      }),
  );
}

const CodexTextGenerationTestLayer = Layer.provideMerge(
  CodexTextGenerationLive,
  NodeServices.layer,
);

it.layer(CodexTextGenerationTestLayer)("CodexTextGenerationLive", (it) => {
  it.effect("generates and sanitizes commit messages", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject:
            "  Add important change to the system with too much detail and a trailing period.\nsecondary line",
          body: "\n- added migration\n- updated tests\n",
        }),
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
        });

        expect(generated.subject.length).toBeLessThanOrEqual(72);
        expect(generated.subject.endsWith(".")).toBe(false);
        expect(generated.body).toBe("- added migration\n- updated tests");
      }),
    ),
  );

  it.effect("generates PR content and trims markdown body", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: "  Improve orchestration flow\nwith ignored suffix",
          body: "\n## Summary\n- improve flow\n\n## Testing\n- bun test\n\n",
        }),
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generatePrContent({
          cwd: process.cwd(),
          baseBranch: "main",
          headBranch: "feature/codex-effect",
          commitSummary: "feat: improve orchestration flow",
          diffSummary: "2 files changed",
          diffPatch: "diff --git a/a.ts b/a.ts",
        });

        expect(generated.title).toBe("Improve orchestration flow");
        expect(generated.body.startsWith("## Summary")).toBe(true);
        expect(generated.body.endsWith("\n\n")).toBe(false);
      }),
    ),
  );

  it.effect("returns typed TextGenerationError when codex exits non-zero", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "ignored", body: "" }),
        exitCode: 1,
        stderr: "codex execution failed",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const result = yield* textGeneration
          .generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-error",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
          })
          .pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: "Left" as const, left: error }),
              onSuccess: (value) => ({ _tag: "Right" as const, right: value }),
            }),
          );

        expect(result._tag).toBe("Left");
        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(TextGenerationError);
          expect(result.left.message).toContain("Codex CLI command failed: codex execution failed");
        }
      }),
    ),
  );
});
