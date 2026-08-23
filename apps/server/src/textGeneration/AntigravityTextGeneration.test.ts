// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
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

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const AntigravityTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-antigravity-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpAntigravityWrapper(dir: string, env: Record<string, string>): string {
  const binDir = NodePath.join(dir, "bin");
  const agyPath = NodePath.join(binDir, "antigravity-acp-server");
  NodeFS.mkdirSync(binDir, { recursive: true });
  NodeFS.writeFileSync(
    agyPath,
    [
      "#!/bin/sh",
      "export T3_PROVIDER=antigravity",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(agyPath, 0o755);
  return agyPath;
}

function withFakeAcpAntigravity<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-antigravity-text-acp-"),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const binaryPath = makeAcpAntigravityWrapper(tempDir, env);
    const config = decodeAntigravitySettings({ binaryPath });
    const textGeneration = yield* makeAntigravityTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(AntigravityTextGenerationTestLayer)("AntigravityTextGeneration", (it) => {
  it.effect("generates commit message via ACP", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-antigravity-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpAntigravity(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add Antigravity provider",
          body: "Wire up the ACP runtime and headless text generation path.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feat/antigravity",
            stagedSummary: "1 file changed",
            stagedPatch: "+ const x = 1;",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("antigravity"),
              "gemini-3.7-flash",
            ),
          });

          expect(generated.subject).toBe("Add Antigravity provider");
          expect(generated.body).toBe("Wire up the ACP runtime and headless text generation path.");
        }),
    );
  });

  it.effect("generates thread title via ACP", () =>
    withFakeAcpAntigravity(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          title: "Antigravity Integration",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Help me add Antigravity provider support",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("antigravity"),
              "gemini-3.7-flash",
            ),
          });

          expect(generated.title).toBe("Antigravity Integration");
        }),
    ),
  );
});
