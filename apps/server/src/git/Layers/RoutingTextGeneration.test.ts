import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";

import {
  ClaudeTextGenerationBackend,
  CodexTextGenerationBackend,
} from "../Services/TextGenerationBackends.ts";
import { type TextGenerationShape, TextGeneration } from "../Services/TextGeneration.ts";
import { RoutingTextGenerationLive } from "./RoutingTextGeneration.ts";

function makeBackend(label: "codex" | "claude", calls: string[]): TextGenerationShape {
  return {
    generateCommitMessage: (input) =>
      Effect.sync(() => {
        calls.push(`${label}:commit:${input.model ?? "default"}`);
        return { subject: `${label} commit`, body: "" };
      }),
    generatePrContent: (input) =>
      Effect.sync(() => {
        calls.push(`${label}:pr:${input.model ?? "default"}`);
        return { title: `${label} pr`, body: "## Summary\n- routed\n\n## Testing\n- Not run" };
      }),
    generateBranchName: (input) =>
      Effect.sync(() => {
        calls.push(`${label}:branch:${input.model ?? "default"}`);
        return { branch: `${label}-branch` };
      }),
  };
}

it.effect("routes Claude commit and PR generation to the Claude backend", () => {
  const calls: string[] = [];
  const layer = RoutingTextGenerationLive.pipe(
    Layer.provide(Layer.succeed(CodexTextGenerationBackend, makeBackend("codex", calls))),
    Layer.provide(Layer.succeed(ClaudeTextGenerationBackend, makeBackend("claude", calls))),
  );

  return Effect.gen(function* () {
    const textGeneration = yield* TextGeneration;
    const commit = yield* textGeneration.generateCommitMessage({
      cwd: process.cwd(),
      branch: "main",
      stagedSummary: "M file.ts",
      stagedPatch: "diff --git a/file.ts b/file.ts",
      model: "claude-opus-4-6",
    });
    const pr = yield* textGeneration.generatePrContent({
      cwd: process.cwd(),
      baseBranch: "main",
      headBranch: "feature/claude",
      commitSummary: "feat: route claude",
      diffSummary: "1 file changed",
      diffPatch: "diff --git a/file.ts b/file.ts",
      model: "claude-sonnet-4-6",
    });

    expect(commit.subject).toBe("claude commit");
    expect(pr.title).toBe("claude pr");
    expect(calls).toEqual(["claude:commit:claude-opus-4-6", "claude:pr:claude-sonnet-4-6"]);
  }).pipe(Effect.provide(layer));
});

it.effect("keeps attachment-based branch naming on the Codex backend", () => {
  const calls: string[] = [];
  const layer = RoutingTextGenerationLive.pipe(
    Layer.provide(Layer.succeed(CodexTextGenerationBackend, makeBackend("codex", calls))),
    Layer.provide(Layer.succeed(ClaudeTextGenerationBackend, makeBackend("claude", calls))),
  );

  return Effect.gen(function* () {
    const textGeneration = yield* TextGeneration;
    const generated = yield* textGeneration.generateBranchName({
      cwd: process.cwd(),
      message: "Use the screenshot to suggest a branch",
      attachments: [
        {
          type: "image",
          id: "branch-image",
          name: "preview.png",
          mimeType: "image/png",
          sizeBytes: 1024,
        },
      ],
      model: "claude-sonnet-4-6",
    });

    expect(generated.branch).toBe("codex-branch");
    expect(calls).toEqual(["codex:branch:claude-sonnet-4-6"]);
  }).pipe(Effect.provide(layer));
});
