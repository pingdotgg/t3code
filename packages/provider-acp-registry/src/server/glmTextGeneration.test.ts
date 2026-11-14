import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { type AcpError } from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/compat";
import { expect } from "vite-plus/test";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import {
  type GlmTextRuntime,
  type GlmTextRuntimeFactory,
  makeGlmTextGeneration,
} from "./glmTextGeneration.ts";

const requestContext = { requestId: "test-request", method: "test" };
const SESSION_ID = "047c62f6-607b-44db-bfbe-f83b67e9e8b1";
const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const glmSettings = decodeSettings({ agentId: "glm-acp-agent" });
const modelSelection = {
  instanceId: ProviderInstanceId.make("glm-text-test"),
  model: "glm-5.3",
};
const SAFETY_PREFIX =
  "Use only the input below. Do not use tools, read or write files, run commands, or ask questions.\nReturn only the requested JSON object.\n\n";

interface PromptContext {
  readonly emit: (
    update: AcpSchema.SessionNotification["update"],
    sessionId?: string,
  ) => Effect.Effect<void, AcpError>;
  permission: Parameters<GlmTextRuntime["handleRequestPermission"]>[0];
  question: Parameters<GlmTextRuntime["handleElicitation"]>[0];
  readFile: Parameters<GlmTextRuntime["handleReadTextFile"]>[0];
  writeFile: Parameters<GlmTextRuntime["handleWriteTextFile"]>[0];
  createTerminal: Parameters<GlmTextRuntime["handleCreateTerminal"]>[0];
  extension: Parameters<GlmTextRuntime["handleUnknownExtRequest"]>[0];
  readonly cwd: string;
}

const makeFixture = Effect.fn("makeGlmTextGenerationFixture")(function* (
  options: {
    readonly outputs?: ReadonlyArray<string>;
    readonly prompt?: (context: PromptContext) => Effect.Effect<AcpSchema.PromptResponse, AcpError>;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const enteredPrompt = yield* Deferred.make<void>();
  const state = {
    runtimes: [] as Array<{
      readonly cwd: string;
      readonly sessionDirectory: string;
      readonly environment: Readonly<Record<string, string>>;
    }>,
    prompts: [] as Array<Parameters<GlmTextRuntime["prompt"]>[0]>,
    selectedModes: [] as Array<string>,
    configSelections: [] as Array<{ readonly id: string; readonly value: string | boolean }>,
    modesAtPrompt: [] as Array<string>,
    startedSessions: 0,
    cancellations: 0,
    events: [] as Array<string>,
  };
  const outputs = [...(options.outputs ?? ['{"title":"Repair login"}'])];
  const incoming: Omit<PromptContext, "cwd" | "emit"> = {
    permission: () => Effect.die("No permission handler."),
    question: () => Effect.die("No question handler."),
    readFile: () => Effect.die("No file handler."),
    writeFile: () => Effect.die("No file handler."),
    createTerminal: () => Effect.die("No terminal handler."),
    extension: () => Effect.die("No extension handler."),
  };

  const makeRuntime: GlmTextRuntimeFactory = (input) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<AcpSessionRuntime.AcpSessionRuntimeEvent>();
      const environment = { ...input.environment };
      const sessionDirectory = environment.ACP_GLM_SESSION_DIR;
      if (sessionDirectory === undefined) {
        return yield* Effect.die("Missing ACP_GLM_SESSION_DIR.");
      }
      state.runtimes.push({ cwd: input.cwd, sessionDirectory, environment });
      expect(yield* fs.readDirectory(input.cwd).pipe(Effect.orDie)).toEqual([]);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          state.events.push(`runtime-closed:${input.cwd}`);
        }),
      );
      let currentMode = "default";
      let currentModel = "glm-5.3";
      let currentThoughtLevel = "medium";
      let sessionUpdate: Parameters<GlmTextRuntime["handleSessionUpdate"]>[0] = () => Effect.void;
      const configOptions = (): Array<AcpSchema.SessionConfigOption> => [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: currentModel,
          options: [
            { value: "glm-5.3", name: "GLM 5.3" },
            { value: "glm-5.3-flash", name: "GLM 5.3 Flash" },
          ],
        },
        {
          id: "thought_level",
          name: "Thinking",
          category: "thought_level",
          type: "select",
          currentValue: currentThoughtLevel,
          options: ["minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({
            value,
            name: value,
          })),
        },
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: currentMode,
          options: ["default", "accept_edits", "bypass_permissions"].map((value) => ({
            value,
            name: value,
          })),
        },
      ];

      return {
        start: () =>
          Effect.gen(function* () {
            state.startedSessions += 1;
            yield* fs
              .writeFileString(path.join(sessionDirectory, `${SESSION_ID}.json`), "{}")
              .pipe(Effect.orDie);
            return {
              sessionId: SESSION_ID,
              initializeResult: { protocolVersion: 1 },
              sessionSetupResult: { sessionId: SESSION_ID },
              modelConfigId: "model",
            };
          }),
        setMode: (modeId) =>
          Effect.sync(() => {
            state.selectedModes.push(modeId);
            currentMode = modeId;
            return {};
          }),
        getConfigOptions: Effect.sync(configOptions),
        getEvents: () => Stream.fromQueue(events),
        setConfigOption: (configId, value) =>
          Effect.sync(() => {
            state.configSelections.push({ id: configId, value });
            if (configId === "model" && typeof value === "string") currentModel = value;
            if (configId === "thought_level" && typeof value === "string") {
              currentThoughtLevel = value;
            }
            return { configOptions: configOptions() };
          }),
        prompt: (request) =>
          Effect.gen(function* () {
            state.prompts.push(request);
            state.modesAtPrompt.push(currentMode);
            yield* Deferred.succeed(enteredPrompt, undefined);
            const emit: PromptContext["emit"] = (update, sessionId = SESSION_ID) =>
              sessionUpdate({ sessionId, update });
            if (options.prompt) {
              return yield* options.prompt({ emit, ...incoming, cwd: input.cwd });
            }
            const output = outputs.shift() ?? '{"title":"Repair login"}';
            yield* emit({
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "Choose concise text." },
            });
            yield* emit(
              {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "unrelated session" },
              },
              "another-session",
            );
            for (const text of [output.slice(0, 9), output.slice(9)]) {
              yield* emit({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text },
              });
            }
            return { stopReason: "end_turn" };
          }),
        cancel: Effect.gen(function* () {
          state.cancellations += 1;
          const acknowledge = yield* Deferred.make<void>();
          yield* Queue.offer(events, { _tag: "EventStreamBarrier", acknowledge });
          yield* Deferred.await(acknowledge);
        }),
        closeSession: (sessionId) =>
          Effect.sync(() => {
            state.events.push(`session-closed:${sessionId ?? SESSION_ID}`);
            return {};
          }),
        handleSessionUpdate: (handler) =>
          Effect.sync(() => {
            sessionUpdate = handler;
          }),
        handleRequestPermission: (handler) =>
          Effect.sync(() => {
            incoming.permission = handler;
          }),
        handleElicitation: (handler) =>
          Effect.sync(() => {
            incoming.question = handler;
          }),
        handleReadTextFile: (handler) =>
          Effect.sync(() => {
            incoming.readFile = handler;
          }),
        handleWriteTextFile: (handler) =>
          Effect.sync(() => {
            incoming.writeFile = handler;
          }),
        handleCreateTerminal: (handler) =>
          Effect.sync(() => {
            incoming.createTerminal = handler;
          }),
        handleTerminalOutput: () => Effect.void,
        handleTerminalWaitForExit: () => Effect.void,
        handleTerminalKill: () => Effect.void,
        handleTerminalRelease: () => Effect.void,
        handleUnknownExtRequest: (handler) =>
          Effect.sync(() => {
            incoming.extension = handler;
          }),
      } satisfies GlmTextRuntime;
    });

  const textGeneration = yield* makeGlmTextGeneration({
    settings: glmSettings,
    environment: {},
    makeRuntime,
  });
  const titleInput = { cwd: "/workspace/project", message: "Repair Google login", modelSelection };
  const assertCleaned = Effect.gen(function* () {
    for (const runtime of state.runtimes) {
      expect(yield* fs.exists(runtime.cwd)).toBe(false);
      expect(yield* fs.exists(runtime.sessionDirectory)).toBe(false);
    }
    expect(state.events.filter((event) => event.startsWith("session-closed"))).toHaveLength(
      state.startedSessions,
    );
    for (const [index, event] of state.events.entries()) {
      if (!event.startsWith("runtime-closed")) continue;
      expect(state.events[index - 1]).toMatch(/^session-closed:/);
    }
  });
  return { fs, path, state, incoming, enteredPrompt, textGeneration, titleInput, assertCleaned };
});

const unusedCatalog: AcpRegistrySupport.AcpRegistryCatalog["Service"] = {
  search: () => Effect.die("unused search"),
  prepare: () => Effect.die("unused prepare"),
  inspect: () => Effect.die("unused inspect"),
  resolve: () => Effect.die("unused resolve"),
  uninstallManagedBinary: () => Effect.die("unused uninstall"),
};

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    SecureRandom.layerWebCrypto,
    Layer.succeed(AcpRegistrySupport.AcpRegistryCatalog, unusedCatalog),
  ),
)("GlmTextGeneration", (it) => {
  it.effect("turns a JSON reply into a title from a jailed temporary session", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({
        outputs: ['{"title":"  \\"Repair Google login\\"  "}'],
      });
      expect(yield* fixture.textGeneration.generateThreadTitle(fixture.titleInput)).toEqual({
        title: "Repair Google login",
      });
      const runtime = fixture.state.runtimes[0]!;
      expect(runtime.cwd).not.toBe(fixture.titleInput.cwd);
      expect(runtime.environment.ACP_GLM_MAX_TURNS).toBe("1");
      expect(runtime.sessionDirectory.startsWith(runtime.cwd)).toBe(false);
      expect(fixture.state.selectedModes).toEqual(["default"]);
      const prompt = fixture.state.prompts[0]!.prompt[0]!;
      expect(prompt.type === "text" && prompt.text.startsWith(SAFETY_PREFIX)).toBe(true);
      yield* fixture.assertCleaned;
    }).pipe(Effect.scoped),
  );

  it.effect("applies only thought_level selections and never a saved mode", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.textGeneration.generateThreadTitle({
        ...fixture.titleInput,
        modelSelection: {
          ...modelSelection,
          model: "glm-5.3-flash",
          options: [
            { id: "mode", value: "bypass_permissions" },
            { id: "_t3/session-mode", value: "bypass_permissions" },
            { id: "thought_level", value: "low" },
          ],
        },
      });
      expect(fixture.state.selectedModes).toEqual(["default"]);
      expect(fixture.state.configSelections).toEqual([
        { id: "model", value: "glm-5.3-flash" },
        { id: "thought_level", value: "low" },
      ]);
      expect(fixture.state.modesAtPrompt).toEqual(["default"]);
      yield* fixture.assertCleaned;
    }).pipe(Effect.scoped),
  );

  it.effect.each(["tool_call", "tool_call_update"] as const)(
    "aborts on %s even without a permission request",
    (sessionUpdate) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          prompt: ({ emit }) =>
            emit({ sessionUpdate, toolCallId: "tool-1", title: "Read files" }).pipe(
              Effect.andThen(Effect.never),
            ),
        });
        const error = yield* fixture.textGeneration
          .generateThreadTitle(fixture.titleInput)
          .pipe(Effect.flip);
        expect(error.detail).toContain("tool work");
        expect(fixture.state.cancellations).toBe(1);
        yield* fixture.assertCleaned;
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { kind: "permission", reply: { outcome: { outcome: "cancelled" } } },
    { kind: "question", reply: { action: "decline" } },
  ] as const)("refuses a $kind request and fails the request", ({ kind, reply }) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ prompt: () => Effect.never });
      const child = yield* fixture.textGeneration
        .generateThreadTitle(fixture.titleInput)
        .pipe(Effect.forkChild);
      yield* Deferred.await(fixture.enteredPrompt);
      const answer =
        kind === "permission"
          ? yield* fixture.incoming.permission(
              {
                sessionId: SESSION_ID,
                toolCall: { toolCallId: "question-1", title: "Choose a title", kind: "other" },
                options: [
                  { optionId: "first-native-choice", name: "Use this title", kind: "allow_once" },
                  { optionId: "second-native-choice", name: "Use this title", kind: "allow_once" },
                ],
              },
              requestContext,
            )
          : yield* fixture.incoming.question(
              {
                sessionId: SESSION_ID,
                message: "Which title do you prefer?",
                mode: "form",
                requestedSchema: { type: "object", properties: {} },
              },
              requestContext,
            );
      const error = yield* Fiber.join(child).pipe(Effect.flip);
      expect(answer).toEqual(reply);
      expect(error.detail).toContain("user input");
      yield* fixture.assertCleaned;
    }).pipe(Effect.scoped),
  );

  it.effect.each(["readFile", "writeFile", "createTerminal", "extension"] as const)(
    "denies unexpected %s requests and fails the request",
    (kind) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ prompt: () => Effect.never });
        const child = yield* fixture.textGeneration
          .generateThreadTitle(fixture.titleInput)
          .pipe(Effect.forkChild);
        yield* Deferred.await(fixture.enteredPrompt);
        const request =
          kind === "readFile"
            ? fixture.incoming.readFile(
                { sessionId: SESSION_ID, path: "/not-allowed" },
                requestContext,
              )
            : kind === "writeFile"
              ? fixture.incoming.writeFile(
                  { sessionId: SESSION_ID, path: "/not-allowed", content: "no" },
                  requestContext,
                )
              : kind === "createTerminal"
                ? fixture.incoming.createTerminal(
                    { sessionId: SESSION_ID, command: "not-allowed" },
                    requestContext,
                  )
                : fixture.incoming.extension("_ask_user", {}, requestContext);
        const denied = yield* request.pipe(Effect.exit);
        expect(Exit.isFailure(denied)).toBe(true);
        const error = yield* Fiber.join(child).pipe(Effect.flip);
        expect(error.detail).toContain("tool or user input");
        yield* fixture.assertCleaned;
      }).pipe(Effect.scoped),
  );

  it.effect("fails when GLM writes files into the temporary workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture({
        prompt: ({ cwd, emit }) =>
          Effect.gen(function* () {
            yield* fs.writeFileString(`${cwd}/unexpected.txt`, "no").pipe(Effect.orDie);
            yield* emit({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: '{"title":"Ignored output"}' },
            });
            return { stopReason: "end_turn" };
          }),
      });
      const error = yield* fixture.textGeneration
        .generateThreadTitle(fixture.titleInput)
        .pipe(Effect.flip);
      expect(error.detail).toContain("wrote files");
      yield* fixture.assertCleaned;
    }).pipe(Effect.scoped),
  );

  it.effect("cannot generate review guides", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const error = yield* fixture.textGeneration
        .generateReviewGuide({
          cwd: "/workspace/project",
          number: 1,
          title: "Repair login",
          description: "Login is broken.",
          baseBranch: "main",
          baseCommit: "0000000",
          settledReview: "",
          modelSelection,
        })
        .pipe(Effect.flip);
      expect(error.detail).toContain("cannot investigate");
      expect(fixture.state.runtimes).toEqual([]);
      yield* fixture.assertCleaned;
    }).pipe(Effect.scoped),
  );
});
