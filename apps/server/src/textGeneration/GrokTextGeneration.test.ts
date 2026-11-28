// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import { GrokSettings } from "@t3tools/provider-grok/settings";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeGrokTextGeneration } from "@t3tools/provider-grok/testing";
import { execScriptSource, writeFakeCli } from "@t3tools/provider-testing/fakeCli";
const decodeGrokSettings = Schema.decodeSync(GrokSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../provider/testFixtures/grok-text-mock-agent.mjs");

const layerGrokTextGenerationTest = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-grok-text-generation-test-",
}).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

function makeAcpGrokWrapper(dir: string, env: Record<string, string>): string {
  return writeFakeCli({
    directory: NodePath.join(dir, "bin"),
    name: "grok",
    env,
    source: execScriptSource({
      scriptPath: mockAgentPath,
      expectedArgs: ["--permission-mode", "default", "agent", "stdio"],
    }),
  });
}

function withFakeAcpGrok<A, E, R>(
  env: Record<string, string>,
  effectFn: (
    textGeneration: TextGeneration.TextGeneration["Service"],
    grokHome: string,
    projectDir: string,
  ) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-grok-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    makeAcpGrokWrapper(tempDir, env);
    // Relative to the request cwd, which Grok no longer runs in.
    const config = decodeGrokSettings({ binaryPath: "./bin/grok" });
    const grokHome = NodePath.join(tempDir, "grok-home");
    const textGeneration = yield* makeGrokTextGeneration(config, {
      ...process.env,
      // Relative, so Grok running in a temporary cwd must still get this folder.
      GROK_HOME: NodePath.relative(process.cwd(), grokHome),
    });
    return yield* effectFn(textGeneration, grokHome, tempDir);
  }).pipe(Effect.scoped);
}

function readJsonRpcRequests(filePath: string): ReadonlyArray<{
  readonly id?: unknown;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}> {
  return NodeFS.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map(
      (line) =>
        JSON.parse(line) as { id?: unknown; method?: string; params?: Record<string, unknown> },
    );
}

it.layer(layerGrokTextGenerationTest)("GrokTextGeneration", (it) => {
  it.effect("uses ACP with disabled tool capabilities and forwards the requested model id", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-grok-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");
    const sessionDirLogPath = NodePath.join(requestLogDir, "session-dirs.log");

    return withFakeAcpGrok(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_GROK_SESSION_DIR_LOG_PATH: sessionDirLogPath,
        T3_ACP_REQUEST_PERMISSION: "1",
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add Grok provider",
          body: "Wire up the ACP runtime and headless text generation path.",
        }),
      },
      (textGeneration, grokHome, projectDir) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: projectDir,
            branch: "feature/grok",
            stagedSummary: "M apps/server/src/provider/Drivers/GrokDriver.ts",
            stagedPatch: "diff --git a/.../GrokDriver.ts b/.../GrokDriver.ts",
            modelSelection: createModelSelection(ProviderInstanceId.make("grok"), "grok-mock-alt"),
          });

          expect(generated.subject).toBe("Add Grok provider");
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
                request.params?.modelId === "grok-mock-alt",
            ),
          ).toBe(true);
          expect(requests.find((request) => request.id === 9001)).toMatchObject({
            result: { outcome: { outcome: "cancelled" } },
          });

          const sessionCwd = String(
            requests.find((request) => request.method === "session/new")?.params?.cwd ?? "",
          );
          expect(NodePath.isAbsolute(sessionCwd)).toBe(true);
          expect(sessionCwd).not.toBe(projectDir);
          expect(NodeFS.existsSync(sessionCwd)).toBe(false);
          const sessionDir = NodePath.join(grokHome, "sessions", encodeURIComponent(sessionCwd));
          expect(NodeFS.readFileSync(sessionDirLogPath, "utf8")).toBe(`${sessionDir}\n`);
          expect(NodeFS.existsSync(sessionDir)).toBe(false);
          const promptText = (
            requests.find((request) => request.method === "session/prompt")?.params?.prompt as
              | ReadonlyArray<{ text?: string }>
              | undefined
          )?.[0]?.text;
          expect(promptText).toMatch(/^Use only the input below\. Do not use tools/);
        }),
    );
  });

  it.effect("extracts the JSON object when Grok wraps it in conversational text", () =>
    withFakeAcpGrok(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT:
          "Sure! Here's a thread title:\n\n" +
          JSON.stringify({ title: "Investigate failing CI" }) +
          "\n\nLet me know if you need anything else.",
      },
      (textGeneration, _grokHome, projectDir) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: projectDir,
            message: "the lint job is red",
            modelSelection: createModelSelection(ProviderInstanceId.make("grok"), "grok-mock-alt"),
          });
          expect(generated.title).toBe("Investigate failing CI");
        }),
    ),
  );
});
