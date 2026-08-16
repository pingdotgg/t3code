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
import { KiroSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeKiroTextGeneration } from "./KiroTextGeneration.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");
const KIRO_INSTANCE = ProviderInstanceId.make("kiro");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const KiroTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kiro-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

/**
 * Stand-in `kiro-cli` that refuses anything but `acp`, so the test also pins
 * the subcommand text generation launches with.
 */
function makeAcpKiroWrapper(dir: string, env: Record<string, string>): string {
  const binDir = NodePath.join(dir, "bin");
  const kiroPath = NodePath.join(binDir, "kiro-cli");
  NodeFS.mkdirSync(binDir, { recursive: true });
  NodeFS.writeFileSync(
    kiroPath,
    [
      "#!/bin/sh",
      ...Object.entries({
        // Mirrors kiro-cli: no auth method, snake_case option ids, dotted models.
        T3_ACP_FAIL_AUTHENTICATE: "1",
        T3_ACP_MODEL_IDS: "auto,claude-haiku-4.5",
        ...env,
      }).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      'if [ "$1" != "acp" ]; then',
      '  printf "%s\\n" "unexpected args: $*" >&2',
      "  exit 11",
      "fi",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(kiroPath, 0o755);
  return kiroPath;
}

function withFakeAcpKiro<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-kiro-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const binaryPath = makeAcpKiroWrapper(tempDir, env);
    const textGeneration = yield* makeKiroTextGeneration(
      decodeKiroSettings({ enabled: true, binaryPath }),
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

it.layer(KiroTextGenerationTestLayer)("KiroTextGeneration", (it) => {
  it.effect("generates a commit message over ACP with tool capabilities disabled", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-kiro-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpKiro(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add Kiro provider",
          body: "Wire the Kiro CLI up over ACP.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/kiro",
            stagedSummary: "M apps/server/src/provider/Drivers/KiroDriver.ts",
            stagedPatch: "diff --git a/.../KiroDriver.ts b/.../KiroDriver.ts",
            modelSelection: createModelSelection(KIRO_INSTANCE, "claude-haiku-4.5"),
          });

          expect(generated.subject).toBe("Add Kiro provider");
          expect(generated.body).toBe("Wire the Kiro CLI up over ACP.");

          const requests = readJsonRpcRequests(requestLogPath);
          // Text generation must not hand Kiro filesystem or terminal access.
          expect(
            requests.find((request) => request.method === "initialize")?.params?.clientCapabilities,
          ).toMatchObject({
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          });
          // No `authenticate`, matching kiro-cli's missing implementation.
          expect(requests.some((request) => request.method === "authenticate")).toBe(false);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_model" &&
                request.params?.modelId === "claude-haiku-4.5",
            ),
          ).toBe(true);
        }),
    );
  });

  it.effect("resolves a model alias to Kiro's dotted id before requesting it", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-kiro-text-alias-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpKiro(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Investigate failing CI" }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "the lint job is red",
            modelSelection: createModelSelection(KIRO_INSTANCE, "claude-haiku-4-5"),
          });

          expect(
            readJsonRpcRequests(requestLogPath).some(
              (request) =>
                request.method === "session/set_model" &&
                request.params?.modelId === "claude-haiku-4.5",
            ),
          ).toBe(true);
        }),
    );
  });

  it.effect("extracts the JSON object when Kiro wraps it in conversational text", () =>
    withFakeAcpKiro(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT:
          "Sure! Here's the title:\n\n" +
          JSON.stringify({ title: "Fix flaky provider test" }) +
          "\n\nAnything else?",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "the provider test keeps failing",
            modelSelection: createModelSelection(KIRO_INSTANCE, "auto"),
          });
          expect(generated.title).toBe("Fix flaky provider test");
        }),
    ),
  );

  it.effect("ignores Kiro's reasoning chunks when collecting structured output", () =>
    withFakeAcpKiro(
      {
        // Reasoning must not be concatenated into the JSON payload.
        T3_ACP_EMIT_THOUGHT_CHUNKS: "1",
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ branch: "feature/kiro-provider" }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "add the kiro provider",
            modelSelection: createModelSelection(KIRO_INSTANCE, "auto"),
          });
          expect(generated.branch).toBe("feature/kiro-provider");
        }),
    ),
  );

  it.effect("reports invalid structured output as a text generation error", () =>
    withFakeAcpKiro(
      { T3_ACP_PROMPT_RESPONSE_TEXT: "I am afraid I cannot do that." },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: createModelSelection(KIRO_INSTANCE, "auto"),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toContain("invalid structured output");
        }),
    ),
  );

  it.effect("surfaces a failed model switch as a text generation error", () =>
    withFakeAcpKiro(
      { T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ branch: "unreachable" }) },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateBranchName({
              cwd: process.cwd(),
              message: "wire up kiro",
              modelSelection: createModelSelection(KIRO_INSTANCE, "no-such-kiro-model"),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
        }),
    ),
  );
});
