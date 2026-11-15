import { ProviderInstanceId } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { beforeEach, expect } from "vite-plus/test";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";
import * as OpenCode2Client from "./OpenCode2Client.ts";
import * as OpenCode2Server from "./OpenCode2Server.ts";
import * as OpenCode2TextGeneration from "./textGeneration.ts";

const SESSION_ID = "ses_blind_evaluation";
const OWNED_SERVER_URL = "http://127.0.0.1:4302";

const state = {
  startEnvironments: [] as Array<NodeJS.ProcessEnv | undefined>,
  closeCalls: [] as string[],
  connectUrls: [] as string[],
  sessionInputs: [] as unknown[],
  promptInputs: [] as unknown[],
  permissionReplies: [] as unknown[],
  events: [] as OpenCode2Client.OpenCode2StreamEvent[],
};

let promptSent = Promise.withResolvers<void>();
const runtime = {
  startOpenCodeServerProcess: ({
    environment,
    verify,
  }: {
    environment?: NodeJS.ProcessEnv;
    verify?: (url: string) => Effect.Effect<string, OpenCodeRuntime.OpenCodeRuntimeError>;
  }) =>
    Effect.gen(function* () {
      state.startEnvironments.push(environment);
      if (verify !== undefined) yield* verify(OWNED_SERVER_URL);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          state.closeCalls.push(OWNED_SERVER_URL);
        }),
      );
      return {
        url: OWNED_SERVER_URL,
        version: "2.2.6",
        isRunning: Effect.succeed(true),
        exitCode: Effect.never,
      };
    }),
  connectToOpenCodeServer: () => Effect.die(new Error("A shared server must not be used")),
  runOpenCodeCommand: () => Effect.die(new Error("Not used")),
  createOpenCodeSdkClient: () => Effect.die(new Error("Not used")),
  loadOpenCodeInventory: () => Effect.die(new Error("Not used")),
  loadOpenCodeSkills: () => Effect.die(new Error("Not used")),
} as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"];

const client = {
  connect: ({ baseUrl }: { baseUrl: string }) => {
    state.connectUrls.push(baseUrl);
    return Effect.succeed({
      client: {
        server: { info: () => Effect.succeed({ version: "2.2.6" }) },
        session: {
          create: (input: unknown) =>
            Effect.sync(() => {
              state.sessionInputs.push(input);
              return {
                id: SESSION_ID,
                model: { providerID: "openai", id: "gpt-5", variant: "high" },
              };
            }),
          prompt: (input: unknown) =>
            Effect.sync(() => {
              state.promptInputs.push(input);
              promptSent.resolve();
            }),
          remove: () => Effect.void,
          interrupt: () => Effect.void,
        },
        permission: {
          reply: (input: unknown) =>
            Effect.sync(() => {
              state.permissionReplies.push(input);
            }),
        },
      },
      events: Effect.succeed(
        Stream.unwrap(
          Effect.map(
            Effect.promise(() => promptSent.promise),
            () => Stream.fromIterable(state.events),
          ),
        ),
      ),
      imageJobs: () => Effect.succeed([]),
      readImage: () => Effect.die(new Error("Not used")),
    } as unknown as OpenCode2Client.OpenCode2Api);
  },
} satisfies OpenCode2Client.OpenCode2Client["Service"];

const sharedServer = OpenCode2Server.OpenCode2Server.of({
  withConnection: () => Effect.die(new Error("A shared server must not be used")),
});

const layer = Layer.mergeAll(
  Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, runtime),
  Layer.succeed(OpenCode2Client.OpenCode2Client, client),
  Layer.succeed(OpenCode2Server.OpenCode2Server, sharedServer),
).pipe(
  Layer.provideMerge(TestProviderHost.layer()),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

const evaluationInput = {
  cwd: "/isolated-evaluator",
  modelSelection: {
    instanceId: ProviderInstanceId.make("opencode"),
    model: "openai/gpt-5",
    options: [{ id: "variant", value: "high" }],
  },
  packet: {
    scope: "turn" as const,
    runOutcome: "completed" as const,
    request: { ref: "U1" as const, text: "Fix the issue." },
    context: [],
    evidence: [{ ref: "E1", kind: "assistant" as const, text: "Fixed." }],
    truncated: false,
    omittedItems: 0,
    missingArtifacts: false,
  },
};
const validEvaluation = {
  outcome: "scored",
  taskCategory: "coding",
  scores: { taskCompletion: 4, correctness: 4, instructionFollowing: 4, verification: 4 },
  confidence: "high",
  rationale: { text: "The requested fix is complete.", citations: ["U1", "E1"] },
  strengths: [],
  weaknesses: [],
  promptAdvice: [],
};

const make = (
  configPath = "/user-config/opencode.json",
  serverUrl = "",
  environment: NodeJS.ProcessEnv = {},
  directory = process.cwd(),
) =>
  OpenCode2TextGeneration.make({
    binaryPath: "fake-opencode",
    serverUrl,
    directory,
    environment: {
      HOME: "/original-home",
      XDG_CONFIG_HOME: "/user-config",
      OPENCODE_CONFIG: configPath,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        providers: { custom: { options: { baseURL: "http://model.internal" } } },
        instructions: ["/secret/instructions.md"],
        plugins: ["secret-plugin"],
        mcp: { private: { type: "remote", url: "http://private" } },
      }),
      ...environment,
    },
  }).pipe(Effect.provideService(OpenCode2Server.OpenCode2Server, sharedServer));

beforeEach(() => {
  promptSent = Promise.withResolvers<void>();
  state.startEnvironments.length = 0;
  state.closeCalls.length = 0;
  state.connectUrls.length = 0;
  state.sessionInputs.length = 0;
  state.promptInputs.length = 0;
  state.permissionReplies.length = 0;
  state.events = [
    {
      type: "session.step.started",
      data: {
        sessionID: SESSION_ID,
        model: { providerID: "openai", id: "gpt-5", variant: "high" },
      },
    },
    {
      type: "session.text.ended",
      data: {
        sessionID: SESSION_ID,
        assistantMessageID: "msg_blind_evaluation",
        ordinal: 0,
        text: JSON.stringify(validEvaluation),
      },
    },
    {
      type: "session.execution.succeeded",
      data: { sessionID: SESSION_ID },
    },
  ] as OpenCode2Client.OpenCode2StreamEvent[];
});

it.layer(layer)("OpenCode2TextGeneration blind evaluation", (it) => {
  it.effect.each([
    "configured overrides",
    "empty file override",
    "empty directory override",
    "empty inline override",
  ])("uses an owned deny-all server and the exact requested model variant (%s)", (overrides) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-routing-" });
      const configHome = `${directory}/global`;
      const configDirectory = `${directory}/override`;
      const configPath = `${directory}/explicit.json`;
      yield* fs.makeDirectory(`${configHome}/opencode`, { recursive: true });
      yield* fs.makeDirectory(configDirectory);
      yield* fs.writeFileString(
        `${configHome}/opencode/opencode.json`,
        JSON.stringify({ providers: { ambient: { settings: { apiKey: "ignored-global-key" } } } }),
      );
      yield* fs.writeFileString(
        `${configDirectory}/config.json`,
        JSON.stringify({
          providers: { ignored: { settings: { apiKey: "ignored-directory-key" } } },
        }),
      );
      yield* fs.writeFileString(
        `${directory}/opencode.json`,
        JSON.stringify({ providers: { cwd: { settings: { apiKey: "ignored-cwd-key" } } } }),
      );
      yield* fs.writeFileString(
        `${configDirectory}/opencode.json`,
        JSON.stringify({
          providers: {
            custom: {
              settings: {
                baseURL: "http://directory.internal",
                headers: { "x-config-source": "directory" },
              },
            },
          },
        }),
      );
      yield* fs.writeFileString(
        configPath,
        JSON.stringify({
          providers: {
            custom: {
              settings: { apiKey: "{file:./key}", baseURL: "http://explicit.internal" },
            },
          },
        }),
      );
      const textGeneration = yield* make(
        overrides === "empty file override" ? "" : configPath,
        "",
        {
          XDG_CONFIG_HOME: configHome,
          OPENCODE_CONFIG_DIR: overrides === "empty directory override" ? "" : configDirectory,
          ...(overrides === "empty inline override" ? { OPENCODE_CONFIG_CONTENT: "" } : {}),
        },
        directory,
      );
      const verdict = yield* textGeneration.generateModelEvaluation(evaluationInput);

      expect(verdict).toEqual(validEvaluation);
      expect(textGeneration.supportedOperations).toContain("generateModelEvaluation");
      expect(state.connectUrls).toEqual([OWNED_SERVER_URL]);
      expect(state.sessionInputs[0]).toMatchObject({
        model: { providerID: "openai", id: "gpt-5", variant: "high" },
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      });
      const environment = state.startEnvironments[0];
      expect(environment?.HOME).not.toBe("/original-home");
      expect(environment?.XDG_DATA_HOME).toBe("/original-home/.local/share");
      expect(environment?.XDG_CONFIG_HOME).not.toBe(configHome);
      expect(environment?.OPENCODE_CONFIG).toBeUndefined();
      expect(JSON.parse(environment?.OPENCODE_CONFIG_CONTENT ?? "null")).toEqual({
        providers: {
          ...(overrides === "empty directory override"
            ? { ambient: { settings: { apiKey: "ignored-global-key" } } }
            : {}),
          custom: {
            ...(overrides === "empty inline override"
              ? {}
              : { options: { baseURL: "http://model.internal" } }),
            settings: {
              ...(overrides === "empty file override" ? {} : { apiKey: `{file:${directory}/key}` }),
              baseURL:
                overrides === "empty file override"
                  ? "http://directory.internal"
                  : "http://explicit.internal",
              ...(overrides === "empty directory override"
                ? {}
                : { headers: { "x-config-source": "directory" } }),
            },
          },
        },
      });
      expect(state.closeCalls).toEqual([OWNED_SERVER_URL]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not advertise judges from an external server with separate credentials", () =>
    Effect.gen(function* () {
      const textGeneration = yield* make(undefined, "https://remote.example.com");
      expect(textGeneration.supportedOperations).not.toContain("generateModelEvaluation");
      const error = yield* textGeneration
        .generateModelEvaluation(evaluationInput)
        .pipe(Effect.flip);
      expect(error.detail).toContain("cannot isolate");
      expect(state.connectUrls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("fails when execution reports a different model", () =>
    Effect.gen(function* () {
      state.events[0] = {
        type: "session.step.started",
        data: {
          sessionID: SESSION_ID,
          model: { providerID: "openai", id: "gpt-5-mini", variant: "high" },
        },
      } as OpenCode2Client.OpenCode2StreamEvent;
      const textGeneration = yield* make();

      const error = yield* textGeneration
        .generateModelEvaluation(evaluationInput)
        .pipe(Effect.flip);

      expect(error.detail).toContain("different model or variant");
    }).pipe(Effect.scoped),
  );

  it.effect("fails when a tool event is observed", () =>
    Effect.gen(function* () {
      state.events.splice(1, 0, {
        type: "session.tool.called",
        data: {
          sessionID: SESSION_ID,
          id: "tool_read",
          assistantMessageID: "msg_blind_evaluation",
          input: { filePath: "/secret" },
          executed: true,
        },
      } as unknown as OpenCode2Client.OpenCode2StreamEvent);
      const textGeneration = yield* make();

      const error = yield* textGeneration
        .generateModelEvaluation(evaluationInput)
        .pipe(Effect.flip);

      expect(error.detail).toContain("tool activity");
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a permission request and fails the evaluation", () =>
    Effect.gen(function* () {
      state.events.splice(1, 0, {
        type: "permission.asked",
        data: { sessionID: SESSION_ID, id: "permission_read" },
      } as unknown as OpenCode2Client.OpenCode2StreamEvent);
      const textGeneration = yield* make();

      const error = yield* textGeneration
        .generateModelEvaluation(evaluationInput)
        .pipe(Effect.flip);

      expect(error.detail).toContain("permission");
      expect(state.permissionReplies).toEqual([
        {
          sessionID: SESSION_ID,
          requestID: "permission_read",
          decision: "reject",
          message: "Tools are not available while generating text.",
        },
      ]);
    }).pipe(Effect.scoped),
  );
});
