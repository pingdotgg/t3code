// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";
import { AntigravitySettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeAntigravityTextGeneration } from "./AntigravityTextGeneration.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

const AntigravityTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-agy-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeFakeAgyWrapper(dir: string, outputJson: string): string {
  const binDir = NodePath.join(dir, "bin");
  const agyPath = NodePath.join(binDir, "agy");
  NodeFS.mkdirSync(binDir, { recursive: true });

  const streamLine = JSON.stringify({
    event: "step_update",
    step_update: {
      step_index: 0,
      step_type: "agent_response",
      text_delta: outputJson,
    },
  });

  NodeFS.writeFileSync(
    agyPath,
    ["#!/bin/sh", `printf '%s\\n' '${streamLine}'`, "exit 0", ""].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(agyPath, 0o755);
  return agyPath;
}

function withFakeAgy<A, E, R>(
  outputJson: string,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-agy-text-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const binaryPath = makeFakeAgyWrapper(tempDir, outputJson);
    const config = decodeAntigravitySettings({ binaryPath });
    const textGeneration = yield* makeAntigravityTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(AntigravityTextGenerationTestLayer)("AntigravityTextGeneration", (it) => {
  it.effect("generates commit message from structured output", () =>
    withFakeAgy(
      JSON.stringify({
        subject: "feat(provider): add Antigravity CLI support",
        body: "Integrate agy binary and stream-json runtime events.",
      }),
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "main",
            stagedSummary: "M apps/server/src/provider/Drivers/AntigravityDriver.ts",
            stagedPatch: "diff --git a/... b/...",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("antigravity"),
              "gemini-3.7-flash-high",
            ),
          });

          expect(generated.subject).toBe("feat(provider): add Antigravity CLI support");
          expect(generated.body).toBe("Integrate agy binary and stream-json runtime events.");
        }),
    ),
  );

  it.effect("extracts JSON object when Antigravity wraps it in markdown code fences", () =>
    withFakeAgy(
      "Here is the generated title:\n```json\n" +
        JSON.stringify({ title: "Fix Antigravity stream decoding" }) +
        "\n```\n",
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Stream decoding fails on large chunks",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("antigravity"),
              "gemini-3.7-flash-high",
            ),
          });

          expect(generated.title).toBe("Fix Antigravity stream decoding");
        }),
    ),
  );

  it.effect("generates PR content", () =>
    withFakeAgy(
      JSON.stringify({
        title: "feat: add Google Antigravity provider",
        body: "## Summary\n- Adds Antigravity driver, adapter, and settings.",
      }),
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feat/antigravity",
            commitSummary: "feat: add antigravity",
            diffSummary: "M ...",
            diffPatch: "diff ...",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("antigravity"),
              "gemini-3.7-flash-high",
            ),
          });

          expect(generated.title).toBe("feat: add Google Antigravity provider");
          expect(generated.body).toContain("Adds Antigravity driver");
        }),
    ),
  );

  it.effect("generates branch name", () =>
    withFakeAgy(JSON.stringify({ branch: "feat/antigravity-support" }), (textGeneration) =>
      Effect.gen(function* () {
        const generated = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Add Antigravity support",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("antigravity"),
            "gemini-3.7-flash-high",
          ),
        });

        expect(generated.branch).toBe("feat/antigravity-support");
      }),
    ),
  );

  it.effect("handles final NDJSON result emitted without trailing newline", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-agy-text-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(tempDir, { recursive: true, force: true });
        }),
      );
      const binDir = NodePath.join(tempDir, "bin");
      const agyPath = NodePath.join(binDir, "agy");
      NodeFS.mkdirSync(binDir, { recursive: true });

      const streamLine = JSON.stringify({
        event: "result",
        result: {
          response: JSON.stringify({ title: "No newline final title" }),
        },
      });

      NodeFS.writeFileSync(
        agyPath,
        ["#!/bin/sh", `printf '%s' '${streamLine}'`, "exit 0", ""].join("\n"),
        "utf8",
      );
      NodeFS.chmodSync(agyPath, 0o755);

      const config = decodeAntigravitySettings({ binaryPath: agyPath });
      const textGeneration = yield* makeAntigravityTextGeneration(config);

      const generated = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Test stream without newline",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("antigravity"),
          "gemini-3.7-flash-high",
        ),
      });

      expect(generated.title).toBe("No newline final title");
    }).pipe(Effect.scoped),
  );
});
