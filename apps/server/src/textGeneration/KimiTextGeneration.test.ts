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
import { KimiSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeKimiTextGeneration } from "./KimiTextGeneration.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);
const isWin = process.platform === "win32";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

const KimiTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kimi-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpKimiWrapper(dir: string, env: Record<string, string>): string {
  const binDir = NodePath.join(dir, "bin");
  NodeFS.mkdirSync(binDir, { recursive: true });
  const jsPath = NodePath.join(binDir, "kimi.mjs");
  const envJson = JSON.stringify(env);
  NodeFS.writeFileSync(
    jsPath,
    [
      "import { spawnSync } from 'node:child_process';",
      `const env = ${envJson};`,
      "const args = process.argv.slice(2);",
      'if (args[0] !== "acp") {',
      "  process.stderr.write(`unexpected args: ${args.join(' ')}\\n`);",
      "  process.exit(11);",
      "}",
      `const result = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(mockAgentPath)}], {`,
      "  stdio: 'inherit',",
      "  env: { ...process.env, ...env },",
      "});",
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    "utf8",
  );

  if (isWin) {
    const cmdPath = NodePath.join(binDir, "kimi.cmd");
    NodeFS.writeFileSync(
      cmdPath,
      ["@echo off", `node "${jsPath.replaceAll("/", "\\")}" %*`, ""].join("\r\n"),
      "utf8",
    );
    return cmdPath;
  }

  const shPath = NodePath.join(binDir, "kimi");
  NodeFS.writeFileSync(
    shPath,
    [
      "#!/bin/sh",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(jsPath)} "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(shPath, 0o755);
  return shPath;
}

function withFakeAcpKimi<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-kimi-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const binaryPath = makeAcpKimiWrapper(tempDir, env);
    const config = decodeKimiSettings({ binaryPath });
    const textGeneration = yield* makeKimiTextGeneration(config);
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

it.layer(KimiTextGenerationTestLayer)("KimiTextGeneration", (it) => {
  it.effect("uses ACP with disabled tool capabilities and forwards the requested model id", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-kimi-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpKimi(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add Kimi provider",
          body: "Wire up the ACP runtime and headless text generation path.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          // Short ids are resolved to kimi-code/* by resolveKimiAcpBaseModelId.
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/kimi",
            stagedSummary: "M apps/server/src/provider/Drivers/KimiDriver.ts",
            stagedPatch: "diff --git a/.../KimiDriver.ts b/.../KimiDriver.ts",
            modelSelection: createModelSelection(ProviderInstanceId.make("kimi"), "grok-mock-alt"),
          });

          expect(generated.subject).toBe("Add Kimi provider");
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
                request.method === "session/set_model" &&
                request.params?.modelId === "kimi-code/grok-mock-alt",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.method === "authenticate" && request.params?.methodId === "login",
            ),
          ).toBe(true);
        }),
    );
  });

  it.effect("extracts the JSON object when Kimi wraps it in conversational text", () =>
    withFakeAcpKimi(
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
            modelSelection: createModelSelection(ProviderInstanceId.make("kimi"), "grok-build"),
          });
          expect(generated.title).toBe("Investigate failing CI");
        }),
    ),
  );

  it.effect("surfaces ACP request failures as text generation errors", () =>
    withFakeAcpKimi(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ branch: "unreachable" }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateBranchName({
              cwd: process.cwd(),
              message: "wire up kimi",
              modelSelection: createModelSelection(
                ProviderInstanceId.make("kimi"),
                "missing-kimi-model",
              ),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toContain("Kimi ACP base model");
        }),
    ),
  );

  it.effect("fails with TextGenerationError when output is empty", () =>
    withFakeAcpKimi(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: "   \n  ",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: createModelSelection(ProviderInstanceId.make("kimi"), "grok-build"),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/empty/i);
        }),
    ),
  );
});
