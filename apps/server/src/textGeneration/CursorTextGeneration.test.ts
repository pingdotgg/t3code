// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";

import { CursorSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeCursorTextGeneration } from "./CursorTextGeneration.ts";
import { execScriptSource, writeFakeCli } from "../testUtils/fakeCli.ts";
const decodeCursorSettings = Schema.decodeSync(CursorSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

const CursorTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-cursor-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpAgentWrapper(dir: string, env: Record<string, string>): string {
  return writeFakeCli({
    directory: NodePath.join(dir, "bin"),
    name: "agent",
    env,
    source: execScriptSource({
      scriptPath: mockAgentPath,
      expectedArgs: ["acp"],
    }),
  });
}

function withFakeAcpAgent<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-cursor-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const agentPath = makeAcpAgentWrapper(tempDir, env);
    const config = decodeCursorSettings({ binaryPath: agentPath });
    const textGeneration = yield* makeCursorTextGeneration(config);
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
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* Effect.die(result.cause);
      }
      yield* Effect.sleep(25);
    }
  });
}

it.layer(CursorTextGenerationTestLayer)("CursorTextGeneration", (it) => {
  it.effect("isolates metadata generation while preserving relative Cursor binaries", () =>
    Effect.gen(function* () {
      const projectCwd = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-cursor-text-project-"),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(projectCwd, { recursive: true, force: true })),
      );
      const requestLogPath = NodePath.join(projectCwd, "requests.ndjson");
      const agentPath = makeAcpAgentWrapper(projectCwd, {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed mock-agent response fixture.
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add generated commit message",
          body: "- verify cursor acp model config path",
        }),
      });
      const relativeAgentPath = `.${NodePath.sep}${NodePath.relative(projectCwd, agentPath)}`;
      const textGeneration = yield* makeCursorTextGeneration(
        decodeCursorSettings({ binaryPath: relativeAgentPath }),
      );

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: projectCwd,
        branch: "feature/cursor-text-generation",
        stagedSummary: "M apps/server/src/textGeneration/CursorTextGeneration.ts",
        stagedPatch:
          "diff --git a/apps/server/src/textGeneration/CursorTextGeneration.ts b/apps/server/src/textGeneration/CursorTextGeneration.ts",
        modelSelection: {
          ...createModelSelection(ProviderInstanceId.make("cursor"), "gpt-5.4", [
            { id: "reasoning", value: "xhigh" },
            { id: "fastMode", value: true },
            { id: "contextWindow", value: "1m" },
          ]),
        },
      });

      expect(generated.subject).toBe("Add generated commit message");
      expect(generated.body).toBe("- verify cursor acp model config path");

      const requests = NodeFS.readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });

      const sessionInput = requests.find((request) => request.method === "session/new")?.params;
      const metadataWorkspace = sessionInput?.cwd;
      expect(typeof metadataWorkspace).toBe("string");
      expect(metadataWorkspace).not.toBe(projectCwd);
      expect(metadataWorkspace).toContain("t3-cursor-metadata-");
      expect(NodeFS.existsSync(String(metadataWorkspace))).toBe(false);

      expect(
        requests.find((request) => request.method === "initialize")?.params?.clientCapabilities,
      ).toMatchObject({
        _meta: {
          parameterizedModelPicker: true,
        },
      });
      expect(
        requests.some(
          (request) =>
            request.method === "session/set_config_option" &&
            request.params?.configId === "model" &&
            request.params?.value === "gpt-5.4",
        ),
      ).toBe(true);
      expect(
        requests.some(
          (request) =>
            request.method === "session/set_config_option" &&
            request.params?.configId === "reasoning" &&
            request.params?.value === "extra-high",
        ),
      ).toBe(true);
      expect(
        requests.some(
          (request) =>
            request.method === "session/set_config_option" &&
            request.params?.configId === "context" &&
            request.params?.value === "1m",
        ),
      ).toBe(true);
      expect(
        requests.some(
          (request) =>
            request.method === "session/set_config_option" &&
            request.params?.configId === "fast" &&
            request.params?.value === "true",
        ),
      ).toBe(true);
      expect(
        requests.find((request) => request.method === "session/prompt")?.params?.prompt,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringMatching(
              /Do not use tools, read or write files, run commands[\s\S]*Staged patch:/,
            ),
          }),
        ]),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("removes the metadata workspace after caller cancellation", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-cursor-text-cancel-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");
    const promptStartedPath = NodePath.join(requestLogDir, "prompt-started");

    return withFakeAcpAgent(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_STARTED_PATH: promptStartedPath,
        T3_ACP_HANG_PROMPT_FOREVER: "1",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.rmSync(requestLogDir, { recursive: true, force: true })),
          );
          const promptStarted = yield* Deferred.make<string>();
          const watcher = NodeFS.watch(requestLogDir, (_event, filename) => {
            if (
              filename !== null &&
              String(filename) !== NodePath.basename(promptStartedPath) &&
              !NodeFS.existsSync(promptStartedPath)
            ) {
              return;
            }
            if (!NodeFS.existsSync(promptStartedPath)) return;
            Deferred.doneUnsafe(
              promptStarted,
              Effect.sync(() => NodeFS.readFileSync(promptStartedPath, "utf8")),
            );
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => watcher.close()));
          const request = yield* textGeneration
            .generateCommitMessage({
              cwd: process.cwd(),
              branch: "feature/cursor-cancel",
              stagedSummary: "M README.md",
              stagedPatch: "diff --git a/README.md b/README.md",
              modelSelection: {
                instanceId: ProviderInstanceId.make("cursor"),
                model: "composer-2",
              },
            })
            .pipe(Effect.forkChild({ startImmediately: true }));
          const metadataWorkspace = yield* Deferred.await(promptStarted);
          expect(NodeFS.existsSync(metadataWorkspace)).toBe(true);

          yield* Fiber.interrupt(request);

          expect(NodeFS.existsSync(metadataWorkspace)).toBe(false);
        }),
    );
  });

  it.effect("keeps generated metadata when workspace cleanup fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-cursor-text-cleanup-"),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const agentPath = makeAcpAgentWrapper(tempDir, {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: '{"title":"Cleanup must not replace this title"}',
      });
      let leakedWorkspace: string | undefined;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (leakedWorkspace) NodeFS.rmSync(leakedWorkspace, { recursive: true, force: true });
        }),
      );
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        remove: (path, options) => {
          if (!path.includes("t3-cursor-metadata-")) return fileSystem.remove(path, options);
          leakedWorkspace = path;
          return Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "remove",
              pathOrDescriptor: path,
              description: "forced metadata workspace cleanup failure",
            }),
          );
        },
      });
      const textGeneration = yield* makeCursorTextGeneration(
        decodeCursorSettings({ binaryPath: agentPath }),
      ).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem));

      const generated = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Keep successful metadata despite cleanup failure.",
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "composer-2",
        },
      });

      expect(generated.title).toBe("Cleanup must not replace this title");
      expect(leakedWorkspace).toContain("t3-cursor-metadata-");
    }).pipe(Effect.scoped),
  );

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
            branch: "feature/cursor-noisy-json",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              instanceId: ProviderInstanceId.make("cursor"),
              model: "composer-2",
            },
          });

          expect(generated.subject).toBe("Update README dummy comment with attribution and date");
          expect(generated.body).toBe("");
        }),
    ),
  );

  it.effect("generates thread titles through Cursor ACP text generation", () =>
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
              instanceId: ProviderInstanceId.make("cursor"),
              model: "composer-2",
            },
          });

          expect(generated.title).toBe("Trim reconnect spinner status after resume.");
        }),
    ),
  );

  // Closing the runtime on Windows is taskkill /F, which never lets the mock
  // agent reach its exit handler, so there is no exit log to assert on.
  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "closes the ACP child process after text generation completes",
    () => {
      const exitLogDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-cursor-text-exit-log-"),
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
              branch: "feature/cursor-runtime-close",
              stagedSummary: "M apps/server/src/textGeneration/CursorTextGeneration.ts",
              stagedPatch:
                "diff --git a/apps/server/src/textGeneration/CursorTextGeneration.ts b/apps/server/src/textGeneration/CursorTextGeneration.ts",
              modelSelection: {
                instanceId: ProviderInstanceId.make("cursor"),
                model: "composer-2",
              },
            });

            expect(generated.subject).toBe("Close runtime after generation");

            const exitLog = yield* waitForFileContent(exitLogPath);
            expect(exitLog).toContain("exit:0");

            NodeFS.rmSync(exitLogDir, { recursive: true, force: true });
          }),
      );
    },
  );
});
