// This suite builds real mock-agent wrapper scripts and temp directories on
// disk, so direct node: imports are intentional.
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

import { OmpSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeOmpTextGeneration } from "./OmpTextGeneration.ts";
import { execScriptSource, writeFakeCli } from "../testUtils/fakeCli.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

const OmpTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-omp-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpAgentWrapper(
  dir: string,
  env: Record<string, string>,
  argvLogPath?: string,
): string {
  return writeFakeCli({
    directory: NodePath.join(dir, "bin"),
    name: "omp",
    env: { T3_ACP_OMP_SHAPES: "1", ...env },
    source: execScriptSource({
      scriptPath: mockAgentPath,
      expectedArgs: ["acp"],
      ...(argvLogPath === undefined ? {} : { argvLogPath }),
    }),
  });
}

function withFakeAcpAgent<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
  argvLogPath?: string,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-omp-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const agentPath = makeAcpAgentWrapper(tempDir, env, argvLogPath);
    const config = decodeOmpSettings({ binaryPath: agentPath });
    const textGeneration = yield* makeOmpTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

async function waitForFileContent(filePath: string, attempts = 400): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const raw = await NodeFSP.readFile(filePath, "utf8");
      if (raw.trim().length > 0) {
        return raw;
      }
    } catch {}
    // Each attempt awaits real fs I/O, which yields to the event loop and
    // lets the exiting child flush its log — no wall-clock timer needed.
  }
  throw new Error(`Timed out waiting for file content at ${filePath}`);
}

it.layer(OmpTextGenerationTestLayer)("OmpTextGeneration", (it) => {
  it.effect("spawns omp acp with --auto-approve for unattended background generation", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-omp-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");
    const argvLogPath = NodePath.join(requestLogDir, "argv.txt");

    return withFakeAcpAgent(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add generated commit message",
          body: "- verify omp acp text generation",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/omp-text-generation",
            stagedSummary: "M apps/server/src/textGeneration/OmpTextGeneration.ts",
            stagedPatch:
              "diff --git a/apps/server/src/textGeneration/OmpTextGeneration.ts b/apps/server/src/textGeneration/OmpTextGeneration.ts",
            modelSelection: {
              ...createModelSelection(ProviderInstanceId.make("omp"), "openai/gpt-5.4", [
                { id: "reasoning", value: "max" },
              ]),
            },
          });

          expect(generated.subject).toBe("Add generated commit message");
          expect(generated.body).toBe("- verify omp acp text generation");

          // Unattended generation must never hit an approval prompt: the
          // child is spawned with --auto-approve.
          const argvLog = NodeFS.readFileSync(argvLogPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => line.split("\t"));
          expect(argvLog).toEqual([["acp", "--auto-approve"]]);

          const requests = NodeFS.readFileSync(requestLogPath, "utf8")
            .trim()
            .split("\n")
            .filter((line) => line.length > 0)
            .map(
              (line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> },
            );

          // Text generation registers no elicitation handler, so the
          // capability must not be advertised (omp would otherwise queue a
          // select() nobody answers).
          const initializeCapabilities = requests.find((request) => request.method === "initialize")
            ?.params?.clientCapabilities;
          expect(
            typeof initializeCapabilities === "object" &&
              initializeCapabilities !== null &&
              "elicitation" in initializeCapabilities,
          ).toBe(false);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "model" &&
                request.params?.value === "openai/gpt-5.4",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "thinking" &&
                request.params?.value === "max",
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
      argvLogPath,
    );
  });

  it.effect("generates thread titles through omp ACP text generation", () =>
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
              instanceId: ProviderInstanceId.make("omp"),
              model: "zhipu-coding-plan/glm-5.3",
            },
          });

          expect(generated.title).toBe("Trim reconnect spinner status after resume.");
        }),
    ),
  );

  // Windows terminates the child instead of signalling it, so the mock
  // agent never reaches its exit handler and writes no exit log.
  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "closes the ACP child process after text generation completes",
    () => {
      const exitLogDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-omp-text-exit-log-"),
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
              branch: "feature/omp-runtime-close",
              stagedSummary: "M apps/server/src/textGeneration/OmpTextGeneration.ts",
              stagedPatch:
                "diff --git a/apps/server/src/textGeneration/OmpTextGeneration.ts b/apps/server/src/textGeneration/OmpTextGeneration.ts",
              modelSelection: {
                instanceId: ProviderInstanceId.make("omp"),
                model: "openai/gpt-5.4",
              },
            });

            expect(generated.subject).toBe("Close runtime after generation");

            const exitLog = yield* Effect.promise(() => waitForFileContent(exitLogPath));
            expect(exitLog).toContain("exit:0");

            NodeFS.rmSync(exitLogDir, { recursive: true, force: true });
          }),
      );
    },
  );
});
