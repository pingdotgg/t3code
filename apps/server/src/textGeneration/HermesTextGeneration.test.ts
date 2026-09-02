// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";

import { HermesSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeHermesTextGeneration } from "./HermesTextGeneration.ts";
const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const HermesTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-hermes-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpAgentWrapper(dir: string, env: Record<string, string>): string {
  const binDir = NodePath.join(dir, "bin");
  const agentPath = NodePath.join(binDir, "agent");
  NodeFS.mkdirSync(binDir, { recursive: true });
  NodeFS.writeFileSync(
    agentPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      'if [ "$1" != "acp" ]; then',
      '  printf "%s\\n" "unexpected args: $*" >&2',
      "  exit 11",
      "fi",
      `exec node ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(agentPath, 0o755);
  return agentPath;
}

function withFakeAcpAgent<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-hermes-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const agentPath = makeAcpAgentWrapper(tempDir, env);
    const config = decodeHermesSettings({ binaryPath: agentPath });
    const textGeneration = yield* makeHermesTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

function waitForFileContent(path: string): Effect.Effect<string> {
  return Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + 5_000;
    for (;;) {
      const result = yield* Effect.exit(Effect.sync(() => NodeFS.readFileSync(path, "utf8")));
      if (Exit.isSuccess(result)) {
        return result.value;
      }
      {
        if ((yield* Clock.currentTimeMillis) >= deadline) {
          return yield* Effect.die(result.cause);
        }
      }
      yield* Effect.sleep(25);
    }
  });
}

it.layer(HermesTextGenerationTestLayer)("HermesTextGeneration", (it) => {
  it.effect("forwards the requested model id to the ACP session verbatim", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-hermes-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpAgent(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add generated commit message",
          body: "- verify hermes acp model selection path",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/hermes-text-generation",
            stagedSummary: "M apps/server/src/textGeneration/HermesTextGeneration.ts",
            stagedPatch:
              "diff --git a/apps/server/src/textGeneration/HermesTextGeneration.ts b/apps/server/src/textGeneration/HermesTextGeneration.ts",
            // The shared acp-mock-agent only allowlists grok-* ids for
            // session/set_model, so Hermes tests reuse them.
            modelSelection: createModelSelection(
              ProviderInstanceId.make("hermes"),
              "grok-mock-alt",
            ),
          });

          expect(generated.subject).toBe("Add generated commit message");
          expect(generated.body).toBe("- verify hermes acp model selection path");

          const requests = NodeFS.readFileSync(requestLogPath, "utf8")
            .trim()
            .split("\n")
            .filter((line) => line.length > 0)
            .map(
              (line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> },
            );

          expect(
            requests.find((request) => request.method === "initialize")?.params?.clientCapabilities,
          ).toMatchObject({
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          });
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_model" &&
                request.params?.modelId === "grok-mock-alt",
            ),
          ).toBe(true);
          expect(
            requests.find((request) => request.method === "session/prompt")?.params?.prompt,
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("Staged patch:"),
              }),
            ]),
          );

          NodeFS.rmSync(requestLogDir, { recursive: true, force: true });
        }),
    );
  });

  it.effect("accepts json objects with extra assistant text around them", () =>
    withFakeAcpAgent(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT:
          'Sure, here is the JSON:\n```json\n{\n  "subject": "Update README dummy comment with attribution and date",\n  "body": ""\n}\n```\nDone.',
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/hermes-noisy-json",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              instanceId: ProviderInstanceId.make("hermes"),
              model: "grok-4.6",
            },
          });

          expect(generated.subject).toBe("Update README dummy comment with attribution and date");
          expect(generated.body).toBe("");
        }),
    ),
  );

  it.effect("generates thread titles through Hermes ACP text generation", () =>
    withFakeAcpAgent(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          title: '"Trim reconnect spinner status after resume."',
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Fix the reconnect spinner after a resumed session.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("hermes"),
              model: "grok-4.6",
            },
          });

          expect(generated.title).toBe("Trim reconnect spinner status after resume.");
        }),
    ),
  );

  it.effect("closes the ACP child process after text generation completes", () => {
    const exitLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-hermes-text-exit-log-"),
    );
    const exitLogPath = NodePath.join(exitLogDir, "exit.log");

    return withFakeAcpAgent(
      {
        T3_ACP_EXIT_LOG_PATH: exitLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Close runtime after generation",
          body: "",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/hermes-runtime-close",
            stagedSummary: "M apps/server/src/textGeneration/HermesTextGeneration.ts",
            stagedPatch:
              "diff --git a/apps/server/src/textGeneration/HermesTextGeneration.ts b/apps/server/src/textGeneration/HermesTextGeneration.ts",
            modelSelection: {
              instanceId: ProviderInstanceId.make("hermes"),
              model: "grok-4.6",
            },
          });

          expect(generated.subject).toBe("Close runtime after generation");

          const exitLog = yield* waitForFileContent(exitLogPath);
          expect(exitLog).toContain("exit:0");

          NodeFS.rmSync(exitLogDir, { recursive: true, force: true });
        }),
    );
  });
});
