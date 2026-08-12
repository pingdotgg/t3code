// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { CopilotSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { makeCopilotTextGeneration } from "./CopilotTextGeneration.ts";
import * as TextGeneration from "./TextGeneration.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const CopilotTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-copilot-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpCopilotWrapper(dir: string, env: Record<string, string>): string {
  const binDir = NodePath.join(dir, "bin");
  const copilotPath = NodePath.join(binDir, "copilot");
  NodeFS.mkdirSync(binDir, { recursive: true });
  NodeFS.writeFileSync(
    copilotPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      'if [ "$1" != "--acp" ] || [ "$2" != "--stdio" ] || [ "$3" != "--no-auto-update" ]; then',
      '  printf "%s\\n" "unexpected args: $*" >&2',
      "  exit 11",
      "fi",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(copilotPath, 0o755);
  return copilotPath;
}

function withFakeAcpCopilot<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-copilot-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const binaryPath = makeAcpCopilotWrapper(tempDir, env);
    const config = decodeCopilotSettings({ binaryPath });
    const textGeneration = yield* makeCopilotTextGeneration(config);
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

it.layer(CopilotTextGenerationTestLayer)("CopilotTextGeneration", (it) => {
  it.effect("uses Copilot ACP for structured commit messages", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-copilot-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpCopilot(
      {
        T3_ACP_AUTH_METHOD_ID: "copilot-login",
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add GitHub Copilot provider",
          body: "Run Copilot through the shared ACP runtime.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/copilot",
            stagedSummary: "M apps/server/src/provider/Drivers/CopilotDriver.ts",
            stagedPatch: "diff --git a/.../CopilotDriver.ts b/.../CopilotDriver.ts",
            modelSelection: createModelSelection(ProviderInstanceId.make("copilot"), "auto"),
          });

          expect(generated).toEqual({
            subject: "Add GitHub Copilot provider",
            body: "Run Copilot through the shared ACP runtime.",
          });
          const requests = readJsonRpcRequests(requestLogPath);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "model",
            ),
          ).toBe(false);
        }),
    );
  });

  it.effect("extracts structured output from conversational text", () =>
    withFakeAcpCopilot(
      {
        T3_ACP_AUTH_METHOD_ID: "copilot-login",
        T3_ACP_PROMPT_RESPONSE_TEXT:
          "Here is the title:\n" + JSON.stringify({ title: "Investigate Copilot ACP" }) + "\nDone.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "the copilot provider needs a title",
            modelSelection: createModelSelection(ProviderInstanceId.make("copilot"), "auto"),
          });
          expect(generated.title).toBe("Investigate Copilot ACP");
        }),
    ),
  );
});
