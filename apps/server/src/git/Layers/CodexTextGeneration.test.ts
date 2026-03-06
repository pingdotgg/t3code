import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import { CodexTextGenerationLive } from "./CodexTextGeneration.ts";
import { TextGenerationError } from "../Errors.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";

const makeCodexTextGenerationTestLayer = (stateDir: string) =>
  CodexTextGenerationLive.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), stateDir)),
    Layer.provideMerge(NodeServices.layer),
  );

function makeFakeCodexBinary(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    const launcherPath = path.join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
    const scriptPath = path.join(binDir, "codex.cjs");
    yield* fs.makeDirectory(binDir, { recursive: true });

    yield* fs.writeFileString(
      scriptPath,
      [
        'const fs = require("node:fs");',
        "",
        "async function readStdin() {",
        "  const chunks = [];",
        "  for await (const chunk of process.stdin) {",
        "    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));",
        "  }",
        '  return Buffer.concat(chunks).toString("utf8");',
        "}",
        "",
        "(async () => {",
        '  let outputPath = "";',
        "  let seenImage = false;",
        "  for (let index = 2; index < process.argv.length; index += 1) {",
        "    const arg = process.argv[index];",
        '    if (arg === "--image") {',
        "      const imagePath = process.argv[index + 1];",
        "      if (imagePath) {",
        "        seenImage = true;",
        "        index += 1;",
        "      }",
        "      continue;",
        "    }",
        '    if (arg === "--output-last-message") {',
        '      outputPath = process.argv[index + 1] ?? "";',
        "      index += 1;",
        "    }",
        "  }",
        "  const stdinContent = await readStdin();",
        '  if (process.env.T3_FAKE_CODEX_REQUIRE_IMAGE === "1" && !seenImage) {',
        '    process.stderr.write("missing --image input\\n");',
        "    process.exit(2);",
        "  }",
        "  const mustContain = process.env.T3_FAKE_CODEX_STDIN_MUST_CONTAIN;",
        '  if (mustContain && !stdinContent.includes(mustContain)) {',
        '    process.stderr.write("stdin missing expected content\\n");',
        "    process.exit(3);",
        "  }",
        "  const mustNotContain = process.env.T3_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN;",
        '  if (mustNotContain && stdinContent.includes(mustNotContain)) {',
        '    process.stderr.write("stdin contained forbidden content\\n");',
        "    process.exit(4);",
        "  }",
        "  if (process.env.T3_FAKE_CODEX_STDERR) {",
        '    process.stderr.write(`${process.env.T3_FAKE_CODEX_STDERR}\\n`);',
        "  }",
        "  if (outputPath) {",
        '    fs.writeFileSync(outputPath, Buffer.from(process.env.T3_FAKE_CODEX_OUTPUT_B64 ?? "e30=", "base64"));',
        "  }",
        '  process.exit(Number(process.env.T3_FAKE_CODEX_EXIT_CODE ?? "0"));',
        "})().catch((error) => {",
        '  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\\n`);',
        "  process.exit(1);",
        "});",
        "",
      ].join("\n"),
    );

    yield* fs.writeFileString(
      launcherPath,
      process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
    );
    yield* fs.chmod(launcherPath, 0o755);
    return binDir;
  });
}

function withFakeCodexEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    requireImage?: boolean;
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
      const previousStdinMustContain = process.env.T3_FAKE_CODEX_STDIN_MUST_CONTAIN;
      const previousStdinMustNotContain = process.env.T3_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN;
      const pathDelimiter = process.platform === "win32" ? ";" : ":";

      yield* Effect.sync(() => {
        process.env.PATH =
          previousPath && previousPath.length > 0 ? `${binDir}${pathDelimiter}${previousPath}` : binDir;
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

const CodexTextGenerationTestLayer = makeCodexTextGenerationTestLayer(process.cwd());

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
        });

        expect(generated.subject.length).toBeLessThanOrEqual(72);
        expect(generated.subject.endsWith(".")).toBe(false);
        expect(generated.body).toBe("- added migration\n- updated tests");
        expect(generated.branch).toBeUndefined();
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
        const attachmentId = `thread-branch-image-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const attachmentPath = path.join(process.cwd(), "attachments", `${attachmentId}.png`);
        yield* fs.makeDirectory(path.join(process.cwd(), "attachments"), { recursive: true });
        yield* fs.writeFile(attachmentPath, Buffer.from("hello"));

        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration
          .generateBranchName({
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
          .pipe(Effect.ensuring(fs.remove(attachmentPath).pipe(Effect.catch(() => Effect.void))));

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
        const attachmentId =
          `thread-1-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const imagePath = path.join(process.cwd(), "attachments", `${attachmentId}.png`);
        yield* fs.makeDirectory(path.join(process.cwd(), "attachments"), { recursive: true });
        yield* fs.writeFile(imagePath, Buffer.from("hello"));

        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration
          .generateBranchName({
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
            Effect.ensuring(
              fs.remove(imagePath).pipe(Effect.catch(() => Effect.void)),
            ),
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
        const missingAttachmentId = `thread-missing-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const missingPath = path.join(process.cwd(), "attachments", `${missingAttachmentId}.png`);
        yield* fs.remove(missingPath).pipe(Effect.catch(() => Effect.void));

        const textGeneration = yield* TextGeneration;
        const result = yield* textGeneration
          .generateBranchName({
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
          .pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: "Left" as const, left: error }),
              onSuccess: (value) => ({ _tag: "Right" as const, right: value }),
            }),
          );

        expect(result._tag).toBe("Left");
        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(TextGenerationError);
          expect(result.left.message).toContain("missing --image input");
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
            expect(result.left.message).toContain("Codex returned invalid structured output");
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
