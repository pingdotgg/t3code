// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

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

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

const AntigravityTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-agy-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

/**
 * Creates a direct Node-executable launcher script (.mjs) for the mock agent with top-level await.
 */
async function makeMockAgyWrapper(mockEnv: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agy-text-mock-"));
  const launcherPath = NodePath.join(dir, "mock-launcher.mjs");
  const envAssignments = Object.entries(mockEnv)
    .map(([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};`)
    .join("\n");
  const script = `${envAssignments}
await import(${JSON.stringify(NodeURL.pathToFileURL(mockAgentPath).href)});
`;
  await NodeFSP.writeFile(launcherPath, script, "utf8");
  return launcherPath;
}

function withFakeAgy<A, E, R>(
  mockEnv: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const launcherPath = yield* Effect.promise(() => makeMockAgyWrapper(mockEnv));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        try {
          NodeFS.rmSync(NodePath.dirname(launcherPath), { recursive: true, force: true });
        } catch {
          // ignore
        }
      }),
    );
    const config = decodeAntigravitySettings({ binaryPath: launcherPath });
    const textGenEnv = { ...process.env, T3_AGY_BRIDGE_COMMAND: launcherPath };
    const textGeneration = yield* makeAntigravityTextGeneration(config, textGenEnv);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

const testModel = createModelSelection(
  ProviderInstanceId.make("antigravity"),
  "gemini-3.1-pro-high",
);

it.layer(AntigravityTextGenerationTestLayer)("AntigravityTextGeneration", (it) => {
  it.effect("generates a commit message and extracts subject + body from JSON output", () =>
    withFakeAgy(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "feat(agy): add Antigravity provider bridge",
          body: "Wire up the ACP bridge and connect it to the provider registry.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feat/antigravity",
            stagedSummary: "M apps/server/src/provider/Drivers/AntigravityDriver.ts",
            stagedPatch: "diff --git a/.../AntigravityDriver.ts b/.../AntigravityDriver.ts",
            modelSelection: testModel,
          });

          expect(generated.subject).toBe("feat(agy): add Antigravity provider bridge");
          expect(generated.body).toBe(
            "Wire up the ACP bridge and connect it to the provider registry.",
          );
        }),
    ),
  );

  it.effect("extracts JSON when the model wraps it in conversational text", () =>
    withFakeAgy(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT:
          "Sure! Here's a thread title:\n\n" +
          JSON.stringify({ title: "Investigate Antigravity bridge latency" }) +
          "\n\nLet me know if you need anything else.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "the agy bridge is slow on first invocation and needs latency analysis",
            modelSelection: testModel,
          });
          expect(generated.title).toBe("Investigate Antigravity bridge latency");
        }),
    ),
  );

  it.effect("fails with TextGenerationError when output is empty", () =>
    withFakeAgy(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: "   \n  ",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message:
                "this is a long thread prompt message that is way longer than thirty five characters",
              modelSelection: testModel,
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/empty/i);
        }),
    ),
  );

  it.effect("fails with TextGenerationError when output is unparseable JSON", () =>
    withFakeAgy(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: "totally not json output from a confused model",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message:
                "this is a long thread prompt message that is way longer than thirty five characters",
              modelSelection: testModel,
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/invalid structured output/i);
        }),
    ),
  );

  it.effect("decodes a structured PR title + body", () =>
    withFakeAgy(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          title: "feat(agy): add ACP bridge for Antigravity CLI",
          body: "## Summary\n- Adds `t3 agy-acp` bridge subcommand.\n- Synthesizes ACP events from hooks + transcript.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feat/antigravity-provider",
            commitSummary: "feat: add antigravity provider",
            diffSummary: "M apps/server/src/provider/Drivers/AntigravityDriver.ts",
            diffPatch: "diff --git a/.../AntigravityDriver.ts b/.../AntigravityDriver.ts",
            modelSelection: testModel,
          });

          expect(generated.title).toBe("feat(agy): add ACP bridge for Antigravity CLI");
          expect(generated.body).toContain("agy-acp");
        }),
    ),
  );

  it.effect("generates a short thread title directly when input is short enough", () =>
    withFakeAgy({}, (textGeneration) =>
      Effect.gen(function* () {
        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Fix the agy bridge",
          modelSelection: testModel,
        });
        expect(generated.title).toBe("Fix the agy bridge");
      }),
    ),
  );

  it.effect("generates a branch name and sanitizes the output", () =>
    withFakeAgy(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          branch: "feat/antigravity-bridge",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "add the antigravity ACP bridge",
            modelSelection: testModel,
          });
          expect(generated.branch).toMatch(/^feat[\/-]/);
        }),
    ),
  );
});
