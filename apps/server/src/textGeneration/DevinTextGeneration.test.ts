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
import { DevinSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeDevinTextGeneration } from "./DevinTextGeneration.ts";
import { execScriptSource, writeFakeCli } from "../testUtils/fakeCli.ts";
const decodeDevinSettings = Schema.decodeSync(DevinSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

const DevinTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-devin-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpDevinWrapper(dir: string, env: Record<string, string>): string {
  return writeFakeCli({
    directory: NodePath.join(dir, "bin"),
    name: "devin",
    env: { T3_ACP_DEVIN: "1", ...env },
    source: execScriptSource({
      scriptPath: mockAgentPath,
      expectedArgs: ["acp"],
    }),
  });
}

function withFakeAcpDevin<A, E, R>(
  env: Record<string, string>,
  environment: NodeJS.ProcessEnv,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-devin-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const binaryPath = makeAcpDevinWrapper(tempDir, env);
    const textGeneration = yield* makeDevinTextGeneration(
      decodeDevinSettings({ enabled: true, binaryPath }),
      environment,
    );
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

function readJsonRpcRequests(
  filePath: string,
): ReadonlyArray<{ readonly method?: string; readonly params?: Record<string, unknown> }> {
  return NodeFS.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

it.layer(DevinTextGenerationTestLayer)("DevinTextGeneration", (it) => {
  it.effect("generates without an authenticate request even when no credentials exist", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-devin-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");
    const fakeHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-devin-home-"));

    return withFakeAcpDevin(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ branch: "fix/login-redirect" }),
      },
      // Signed-out environment: no API key and no credentials file.
      { ...process.env, HOME: fakeHome, WINDSURF_API_KEY: "" },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Fix the login redirect loop",
            modelSelection: createModelSelection(ProviderInstanceId.make("devin"), "swe-2-medium"),
          });

          expect(generated.branch).toBe("fix/login-redirect");

          const requests = readJsonRpcRequests(requestLogPath);
          const methods = requests.map((request) => request.method);
          // Text generation is background work — browserAuth is off, so no
          // authenticate request may be sent even with zero credentials.
          expect(methods).not.toContain("authenticate");
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "model" &&
                request.params?.value === "swe-2-medium",
            ),
          ).toBe(true);
        }),
    );
  });

  it.effect("extracts the JSON object when Devin wraps it in conversational text", () =>
    withFakeAcpDevin(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT:
          "Sure! Here's a thread title:\n\n" +
          JSON.stringify({ title: "Investigate failing CI" }) +
          "\n\nHope that helps.",
      },
      { ...process.env, WINDSURF_API_KEY: "ws-test" },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Figure out why CI is failing",
            modelSelection: createModelSelection(ProviderInstanceId.make("devin"), "swe-2-medium"),
          });

          expect(generated.title).toBe("Investigate failing CI");
        }),
    ),
  );
});
