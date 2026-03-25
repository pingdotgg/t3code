import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Result } from "effect";
import { expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import { CodexTextGenerationLive } from "./CodexTextGeneration.ts";
import { TextGenerationError } from "../Errors.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";

const DEFAULT_TEST_MODEL_SELECTION = {
  provider: "codex" as const,
  model: "gpt-5.4-mini",
};

const CodexTextGenerationTestLayer = CodexTextGenerationLive.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3code-codex-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

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
        '  if [ "$1" = "--image" ]; then',
        "    shift",
        '    if [ -n "$1" ]; then',
        '      seen_image="1"',
        "    fi",
        "    continue",
        "  fi",
        '  if [ "$1" = "--config" ]; then',
        "    shift",
        '    if [ "$1" = "service_tier=\\"fast\\"" ]; then',
        '      seen_fast_service_tier="1"',
        "    fi",
        '    case "$1" in',
        "      model_reasoning_effort=*)",
        '        seen_reasoning_effort="$1"',
        "        ;;",
        "    esac",
        "    continue",
        "  fi",
        '  if [ "$1" = "--output-last-message" ]; then',
        "    shift",
        '    output_path="$1"',
        "  fi",
        "  shift",
        "done",
        'stdin_content="$(cat)"',
        'if [ "$T3_FAKE_CODEX_REQUIRE_IMAGE" = "1" ] && [ "$seen_image" != "1" ]; then',
        '  printf "%s\\n" "missing --image input" >&2',
        "  exit 2",
        "fi",
        'if [ "$T3_FAKE_CODEX_REQUIRE_FAST_SERVICE_TIER" = "1" ] && [ "$seen_fast_service_tier" != "1" ]; then',
        '  printf "%s\\n" "missing fast service tier config" >&2',
        "  exit 5",
        "fi",
        'if [ -n "$T3_FAKE_CODEX_REQUIRE_REASONING_EFFORT" ] && [ "$seen_reasoning_effort" != "model_reasoning_effort=\\"$T3_FAKE_CODEX_REQUIRE_REASONING_EFFORT\\"" ]; then',
        '  printf "%s\\n" "unexpected reasoning effort config: $seen_reasoning_effort" >&2',
        "  exit 6",
        "fi",
        'if [ "$T3_FAKE_CODEX_FORBID_REASONING_EFFORT" = "1" ] && [ -n "$seen_reasoning_effort" ]; then',
        '  printf "%s\\n" "reasoning effort config should be omitted: $seen_reasoning_effort" >&2',
        "  exit 7",
        "fi",
        'if [ -n "$T3_FAKE_CODEX_STDIN_MUST_CONTAIN" ]; then',
        '  printf "%s" "$stdin_content" | grep -F -- "$T3_FAKE_CODEX_STDIN_MUST_CONTAIN" >/dev/null || {',
        '    printf "%s\\n" "stdin missing expected content" >&2',
        "    exit 3",
        "  }",
        "fi",
        'if [ -n "$T3_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN" ]; then',
        '  if printf "%s" "$stdin_content" | grep -F -- "$T3_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN" >/dev/null; then',
        '    printf "%s\\n" "stdin contained forbidden content" >&2',
        "    exit 4",
        "  fi",
        "fi",
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
    requireImage?: boolean;
    requireFastServiceTier?: boolean;
    requireReasoningEffort?: string;
    forbidReasoningEffort?: boolean;
    stdinMustContain?: string;
    stdinMustNotContain?: string;
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
      const previousRequireImage = process.env.T3_FAKE_CODEX_REQUIRE_IMAGE;
      const previousRequireFastServiceTier = process.env.T3_FAKE_CODEX_REQUIRE_FAST_SERVICE_TIER;
      const previousRequireReasoningEffort = process.env.T3_FAKE_CODEX_REQUIRE_REASONING_EFFORT;
      const previousForbidReasoningEffort = process.env.T3_FAKE_CODEX_FORBID_REASONING_EFFORT;
      const previousStdinMustContain = process.env.T3_FAKE_CODEX_STDIN_MUST_CONTAIN;
      const previousStdinMustNotContain = process.env.T3_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN;

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

        if (input.requireImage) {
          process.env.T3_FAKE_CODEX_REQUIRE_IMAGE = "1";
        } else {
          delete process.env.T3_FAKE_CODEX_REQUIRE_IMAGE;
        }

        if (input.requireFastServiceTier) {
          process.env.T3_FAKE_CODEX_REQUIRE_FAST_SERVICE_TIER = "1";
        } else {
          delete process.env.T3_FAKE_CODEX_REQUIRE_FAST_SERVICE_TIER;
        }

        if (input.requireReasoningEffort !== undefined) {
          process.env.T3_FAKE_CODEX_REQUIRE_REASONING_EFFORT = input.requireReasoningEffort;
        } else {
          delete process.env.T3_FAKE_CODEX_REQUIRE_REASONING_EFFORT;
        }

        if (input.forbidReasoningEffort) {
          process.env.T3_FAKE_CODEX_FORBID_REASONING_EFFORT = "1";
        } else {
          delete process.env.T3_FAKE_CODEX_FORBID_REASONING_EFFORT;
        }

        if (input.stdinMustContain !== undefined) {
          process.env.T3_FAKE_CODEX_STDIN_MUST_CONTAIN = input.stdinMustContain;
        } else {
          delete process.env.T3_FAKE_CODEX_STDIN_MUST_CONTAIN;
        }

        if (input.stdinMustNotContain !== undefined) {
          process.env.T3_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN = input.stdinMustNotContain;
        } else {
          delete process.env.T3_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN;
        }
      });

      return {
        previousPath,
        previousOutput,
        previousExitCode,
        previousStderr,
        previousRequireImage,
        previousRequireFastServiceTier,
        previousRequireReasoningEffort,
        previousForbidReasoningEffort,
        previousStdinMustContain,
        previousStdinMustNotContain,
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

        if (previous.previousRequireImage === undefined) {
          delete process.env.T3_FAKE_CODEX_REQUIRE_IMAGE;
        } else {
          process.env.T3_FAKE_CODEX_REQUIRE_IMAGE = previous.previousRequireImage;
        }

        if (previous.previousRequireFastServiceTier === undefined) {
          delete process.env.T3_FAKE_CODEX_REQUIRE_FAST_SERVICE_TIER;
        } else {
          process.env.T3_FAKE_CODEX_REQUIRE_FAST_SERVICE_TIER =
            previous.previousRequireFastServiceTier;
        }

        if (previous.previousRequireReasoningEffort === undefined) {
          delete process.env.T3_FAKE_CODEX_REQUIRE_REASONING_EFFORT;
        } else {
          process.env.T3_FAKE_CODEX_REQUIRE_REASONING_EFFORT =
            previous.previousRequireReasoningEffort;
        }

        if (previous.previousForbidReasoningEffort === undefined) {
          delete process.env.T3_FAKE_CODEX_FORBID_REASONING_EFFORT;
        } else {
          process.env.T3_FAKE_CODEX_FORBID_REASONING_EFFORT =
            previous.previousForbidReasoningEffort;
        }

        if (previous.previousStdinMustContain === undefined) {
          delete process.env.T3_FAKE_CODEX_STDIN_MUST_CONTAIN;
        } else {
          process.env.T3_FAKE_CODEX_STDIN_MUST_CONTAIN = previous.previousStdinMustContain;
        }

        if (previous.previousStdinMustNotContain === undefined) {
          delete process.env.T3_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN;
        } else {
          process.env.T3_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN = previous.previousStdinMustNotContain;
        }
      }),
  );
}

it.layer(CodexTextGenerationTestLayer)("CodexTextGenerationLive", (it) => {
  it.effect("generates and sanitizes commit messages without branch by default", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject:
            "  Add important change to the system with too much detail and a trailing period.\nsecondary line",
          body: "\n- added migration\n- updated tests\n",
        }),
        stdinMustNotContain: "branch must be a short semantic git branch fragment",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.subject.length).toBeLessThanOrEqual(72);
        expect(generated.subject.endsWith(".")).toBe(false);
        expect(generated.body).toBe("- added migration\n- updated tests");
        expect(generated.branch).toBeUndefined();
      }),
    ),
  );

  it.effect(
    "forwards codex fast mode and non-default reasoning effort into codex exec config",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            subject: "Add important change",
            body: "",
          }),
          requireFastServiceTier: true,
          requireReasoningEffort: "xhigh",
          stdinMustNotContain: "branch must be a short semantic git branch fragment",
        },
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
              options: {
                reasoningEffort: "xhigh",
                fastMode: true,
              },
            },
          });
        }),
      ),
  );

  it.effect("defaults git text generation codex effort to low", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        requireReasoningEffort: "low",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });
      }),
    ),
  );

  it.effect("generates commit message with branch when includeBranch is true", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
          branch: "fix/important-system-change",
        }),
        stdinMustContain: "branch must be a short semantic git branch fragment",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          includeBranch: true,
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.subject).toBe("Add important change");
        expect(generated.branch).toBe("feature/fix/important-system-change");
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
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.title).toBe("Improve orchestration flow");
        expect(generated.body.startsWith("## Summary")).toBe(true);
        expect(generated.body.endsWith("\n\n")).toBe(false);
      }),
    ),
  );

  it.effect("generates branch names and normalizes branch fragments", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "  Feat/Session  ",
        }),
        stdinMustNotContain: "Image attachments supplied to the model",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Please update session handling.",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.branch).toBe("feat/session");
      }),
    ),
  );

  it.effect("omits attachment metadata section when no attachments are provided", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/session-timeout",
        }),
        stdinMustNotContain: "Attachment metadata:",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Fix timeout behavior.",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.branch).toBe("fix/session-timeout");
      }),
    ),
  );

  it.effect("passes image attachments through as codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
        stdinMustContain: "Attachment metadata:",
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attachmentsDir } = yield* ServerConfig;
        const attachmentId = `thread-branch-image-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const attachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
        yield* fs.makeDirectory(attachmentsDir, { recursive: true });
        yield* fs.writeFile(attachmentPath, Buffer.from("hello"));

        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration.generateBranchName({
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          cwd: process.cwd(),
          message: "Fix layout bug from screenshot.",
          attachments: [
            {
              type: "image",
              id: attachmentId,
              name: "bug.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        });

        expect(generated.branch).toBe("fix/ui-regression");
      }),
    ),
  );

  it.effect("resolves persisted attachment ids to files for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attachmentsDir } = yield* ServerConfig;
        const attachmentId = `thread-1-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const imagePath = path.join(attachmentsDir, `${attachmentId}.png`);
        yield* fs.makeDirectory(attachmentsDir, { recursive: true });
        yield* fs.writeFile(imagePath, Buffer.from("hello"));

        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration
          .generateBranchName({
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "bug.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          })
          .pipe(
            Effect.tap(() =>
              fs.stat(imagePath).pipe(
                Effect.map((fileInfo) => {
                  expect(fileInfo.type).toBe("File");
                }),
              ),
            ),
            Effect.ensuring(fs.remove(imagePath).pipe(Effect.catch(() => Effect.void))),
          );

        expect(generated.branch).toBe("fix/ui-regression");
      }),
    ),
  );

  it.effect("ignores missing attachment ids for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attachmentsDir } = yield* ServerConfig;
        const missingAttachmentId = `thread-missing-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const missingPath = path.join(attachmentsDir, `${missingAttachmentId}.png`);
        yield* fs.remove(missingPath).pipe(Effect.catch(() => Effect.void));

        const textGeneration = yield* TextGeneration;
        const result = yield* textGeneration
          .generateBranchName({
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: missingAttachmentId,
                name: "outside.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          })
          .pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(TextGenerationError);
          expect(result.failure.message).toContain("missing --image input");
        }
      }),
    ),
  );

  it.effect(
    "fails with typed TextGenerationError when codex returns wrong branch payload shape",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            title: "This is not a branch payload",
          }),
        },
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const result = yield* textGeneration
            .generateBranchName({
              cwd: process.cwd(),
              message: "Fix websocket reconnect flake",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(TextGenerationError);
            expect(result.failure.message).toContain("Codex returned invalid structured output");
          }
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
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          })
          .pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(TextGenerationError);
          expect(result.failure.message).toContain(
            "Codex CLI command failed: codex execution failed",
          );
        }
      }),
    ),
  );
});
