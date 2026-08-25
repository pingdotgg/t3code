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
import { FxSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeFxTextGeneration } from "./FxTextGeneration.ts";
const decodeFxSettings = Schema.decodeSync(FxSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const FxTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-fx-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpFxWrapper(dir: string, env: Record<string, string>): string {
  const binDir = NodePath.join(dir, "bin");
  const fxPath = NodePath.join(binDir, "fx");
  NodeFS.mkdirSync(binDir, { recursive: true });
  NodeFS.writeFileSync(
    fxPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      'if [ "$1" != "acp" ] || [ "$#" != "1" ]; then',
      '  printf "%s\\n" "unexpected args: $*" >&2',
      "  exit 11",
      "fi",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(fxPath, 0o755);
  return fxPath;
}

function withFakeAcpFx<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-fx-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const binaryPath = makeAcpFxWrapper(tempDir, env);
    const config = decodeFxSettings({ binaryPath });
    const textGeneration = yield* makeFxTextGeneration(config);
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

it.layer(FxTextGenerationTestLayer)("FxTextGeneration", (it) => {
  it.effect("uses ACP with disabled tool capabilities and forwards the requested model id", () => {
    const requestLogDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-fx-text-log-"));
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpFx(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add Fx provider",
          body: "Wire up the ACP runtime and headless text generation path.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/fx",
            stagedSummary: "M apps/server/src/provider/Drivers/FxDriver.ts",
            stagedPatch: "diff --git a/.../FxDriver.ts b/.../FxDriver.ts",
            modelSelection: createModelSelection(ProviderInstanceId.make("fx"), "composer-2"),
          });

          expect(generated.subject).toBe("Add Fx provider");
          expect(generated.body).toBe("Wire up the ACP runtime and headless text generation path.");

          const requests = readJsonRpcRequests(requestLogPath);
          expect(
            requests.find((request) => request.method === "initialize")?.params?.clientCapabilities,
          ).toMatchObject({
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          });
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "model" &&
                request.params?.value === "composer-2",
            ),
          ).toBe(true);
        }),
    );
  });

  it.effect("sends image attachments as ACP content blocks", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-fx-image-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpFx(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ branch: "fix/image-context" }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const attachmentId = "fx-text-image";
          NodeFS.mkdirSync(attachmentsDir, { recursive: true });
          NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${attachmentId}.png`), "hello");

          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "fix the screenshot regression",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "regression.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            modelSelection: createModelSelection(ProviderInstanceId.make("fx"), "composer-2"),
          });

          expect(generated.branch).toBe("fix/image-context");
          const promptRequest = readJsonRpcRequests(requestLogPath).find(
            (request) => request.method === "session/prompt",
          );
          const prompt = promptRequest?.params?.prompt as
            | ReadonlyArray<Record<string, unknown>>
            | undefined;
          expect(prompt).toContainEqual({
            type: "image",
            data: Buffer.from("hello").toString("base64"),
            mimeType: "image/png",
          });
        }),
    );
  });

  it.effect("extracts the JSON object when Fx wraps it in conversational text", () =>
    withFakeAcpFx(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT:
          "Sure! Here's a thread title:\n\n" +
          JSON.stringify({ title: "Investigate failing CI" }) +
          "\n\nLet me know if you need anything else.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "the lint job is red",
            modelSelection: createModelSelection(ProviderInstanceId.make("fx"), "composer-2"),
          });
          expect(generated.title).toBe("Investigate failing CI");
        }),
    ),
  );

  it.effect("surfaces ACP request failures as text generation errors", () =>
    withFakeAcpFx(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ branch: "unreachable" }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateBranchName({
              cwd: process.cwd(),
              message: "wire up fx",
              modelSelection: createModelSelection(
                ProviderInstanceId.make("fx"),
                "missing-fx-model",
              ),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toContain("Fx ACP base model");
        }),
    ),
  );

  it.effect("fails with TextGenerationError when output is empty", () =>
    withFakeAcpFx(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: "   \n  ",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: createModelSelection(ProviderInstanceId.make("fx"), "composer-2"),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/empty/i);
        }),
    ),
  );

  it.effect("decodes a structured PR title + body", () =>
    withFakeAcpFx(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          title: "feat(fx): wire up model configuration",
          body: "## Summary\n- Select models with ACP `session/set_config_option`.\n- Preserve raw model ids from the active fx catalog.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feat/fx-provider",
            commitSummary: "feat: add fx provider",
            diffSummary: "M apps/server/src/provider/Drivers/FxDriver.ts",
            diffPatch: "diff --git a/.../FxDriver.ts b/.../FxDriver.ts",
            modelSelection: createModelSelection(ProviderInstanceId.make("fx"), "composer-2"),
          });

          expect(generated.title).toBe("feat(fx): wire up model configuration");
          expect(generated.body).toContain("Preserve raw model ids");
        }),
    ),
  );

  it.effect("fails with TextGenerationError when output is unparseable JSON", () =>
    withFakeAcpFx(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: "totally not json output from a confused model",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: createModelSelection(ProviderInstanceId.make("fx"), "composer-2"),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/invalid structured output/i);
        }),
    ),
  );
});
