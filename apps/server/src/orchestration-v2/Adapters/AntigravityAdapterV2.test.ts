import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ChatFileAttachment,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  compactDynamicToolOutput,
  htmlRenderFromToolItem,
  previewRecordingIdFromToolItem,
  sentMessageFromToolItem,
} from "@t3tools/shared/toolOutput";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeAcpAdapterV2 } from "@t3tools/provider-acp/server/adapter";
import { makeAntigravityAcpRuntime } from "../../provider/acp/AntigravityAcpSupport.ts";
import { normalizeAntigravitySessionUpdate } from "../../provider/acp/AntigravityProtocol.ts";
import { ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE } from "../../provider/antigravityAuthSupport.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  type AntigravityAdapterV2Options,
  type AntigravityAdapterV2RuntimeInput,
  makeAntigravityAcpAdapterFlavor,
  makeAntigravityAdapterV2,
} from "./AntigravityAdapterV2.ts";

const flavor = makeAntigravityAcpAdapterFlavor({
  instanceId: ProviderInstanceId.make("antigravity-test"),
  random: undefined as never,
  fileSystem: undefined as never,
  path: undefined as never,
  host: undefined as never,
  selfInvocation: undefined as never,
  makeRuntime: () => Effect.die("not spawned in this test"),
  withProcess: (_stop, task) => task,
  defaultModel: Effect.undefined,
});

function permissionRequest(
  toolCallId: string,
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
): EffectAcpSchema.RequestPermissionRequest {
  return {
    sessionId: "session-1",
    options,
    toolCall: { toolCallId, title: "Which branch?" },
  };
}

describe("AntigravityAdapterV2 flavor", () => {
  it("keeps a successful subagent launch running until the parent turn becomes idle", () => {
    const batch = flavor.extractSubagentUpdate?.({
      toolCallId: "trajectory:4",
      title: "Running start_subagent",
      kind: "other",
      status: "completed",
      data: { rawOutput: "Started two agents." },
    });
    assert.equal(batch?.status, "running");
    assert.equal(batch?.prompt, "Started two agents.");
    assert.isNull(batch?.result);
    assert.isTrue(flavor.subagentsIdleOnTurnCompletion);

    // Permission prompts carry the launch; later updates for the same call do not.
    const launch = flavor.extractSubagentUpdate?.({
      toolCallId: "35bea692fa95447fbdae6333fec5515f",
      title: "Run invoke_subagent?",
      kind: "other",
      status: "pending",
      data: {
        rawInput: {
          Subagents: [{ TypeName: "research", Role: "Readme Reader", Prompt: "Read README.md" }],
        },
      },
    });
    assert.equal(launch?.title, "Readme Reader");
    assert.equal(launch?.prompt, "Read README.md");

    // agy 1.5.x auto-approves one subagent per call with a flat input.
    const single = flavor.extractSubagentUpdate?.({
      toolCallId: "call_16976942396429577770",
      title: "Run invoke_subagent",
      kind: "other",
      status: "completed",
      data: {
        rawInput: { TypeName: "research", Role: "Codebase Researcher", Prompt: "Read README.md" },
      },
    });
    assert.equal(single?.status, "running");
    assert.equal(single?.title, "Codebase Researcher");
    assert.equal(single?.prompt, "Read README.md");
  });

  it("routes interaction_* permission requests to the question card", () => {
    const question = flavor.extractPermissionQuestion?.(
      permissionRequest("interaction_1", [
        { optionId: "main", name: "main", kind: "allow_once" },
        { optionId: "dev", name: "dev", kind: "allow_once" },
      ]),
    );
    assert.isDefined(question);
    assert.deepEqual(
      question?.question.options.map((option) => option.label),
      ["main", "dev"],
    );
    assert.deepEqual(question?.respond({ interaction_1: "dev" }), {
      outcome: { outcome: "selected", optionId: "dev" },
    });
    assert.isUndefined(question?.respond({ interaction_1: "nope" }));
    assert.isUndefined(
      flavor.extractPermissionQuestion?.(
        permissionRequest("tool_1", [{ optionId: "allow", name: "Allow", kind: "allow_once" }]),
      ),
    );
  });

  it("keeps the question card to the agent's own options so a typed answer cannot be sent", () => {
    const question = flavor.extractPermissionQuestion?.(
      permissionRequest("interaction_2", [
        { optionId: "opt-main", name: "main", kind: "allow_once" },
        { optionId: "opt-dev", name: "dev", kind: "allow_once" },
      ]),
    );
    assert.strictEqual(question?.question.allowCustomAnswer, false);
    assert.deepEqual(
      question?.question.options.map((option) => option.value),
      ["opt-main", "opt-dev"],
    );
    assert.deepEqual(question?.respond({ interaction_2: "opt-dev" }), {
      outcome: { outcome: "selected", optionId: "opt-dev" },
    });
  });

  it("shows each ask_question question as the question body, not the generic form message", () => {
    // agy's ask_question puts each question in its field's title, with no description,
    // and a generic count in the form message.
    const choice = (title: string) => ({
      type: "string",
      title,
      oneOf: [
        { const: "npm", title: "npm" },
        { const: "pnpm", title: "pnpm" },
      ],
    });
    const form = flavor.extractElicitationForm?.({
      sessionId: "session-1",
      mode: "form",
      message: "The agent has 2 questions.",
      requestedSchema: {
        type: "object",
        properties: {
          q0: choice("Which package manager should this new TypeScript project use?"),
          q0_other: { type: "string", title: "Other" },
          q1: choice("Which package manager should the docs site use?"),
          q1_other: { type: "string", title: "Other" },
        },
      },
    } as EffectAcpSchema.CreateElicitationRequest);
    assert.deepEqual(
      form?.questions.map((question) => question.question),
      [
        "Which package manager should this new TypeScript project use?",
        "Which package manager should the docs site use?",
      ],
    );
    for (const question of form?.questions ?? []) {
      assert.notStrictEqual(question.header, question.question);
    }
  });
});

const layerSession = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

describe("AntigravityAdapterV2 compaction", () => {
  it.live.each([
    { nativeGoals: false, compact: false },
    { nativeGoals: true, compact: false },
    { nativeGoals: false, compact: true },
  ])(
    "negotiates native goals ($nativeGoals) and advertised compaction ($compact)",
    ({ nativeGoals, compact }) =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* SecureRandom.SecureRandom;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const logs = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-compact-" });
        const requestLog = path.join(logs, "requests.ndjson");
        const instanceId = ProviderInstanceId.make("antigravity-compaction-test");
        const goalSupport = yield* Ref.make(false);
        const startupMilestone = yield* Deferred.make<void>();
        const consumeStartupCommands = yield* Deferred.make<void>();
        const workspaceCommands = yield* Ref.make<{
          readonly names: ReadonlyArray<string>;
          readonly cwd: string;
        } | null>(null);
        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: {
                  T3_ACP_ANTIGRAVITY: "1",
                  T3_ACP_AVAILABLE_COMMANDS: compact ? "compact" : "",
                  T3_ACP_REQUEST_LOG_PATH: requestLog,
                },
              },
            }).pipe(
              Effect.provideService(SecureRandom.SecureRandom, crypto),
              Effect.map((runtime) => ({
                ...runtime,
                drainEvents: Deferred.succeed(startupMilestone, undefined).pipe(
                  Effect.andThen(runtime.drainEvents),
                ),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
          supportsNativeGoals: Ref.get(goalSupport).pipe(
            Effect.tap(() => Deferred.succeed(startupMilestone, undefined)),
          ),
          onSessionEvent: (event, cwd) =>
            event._tag === "AvailableCommandsUpdated"
              ? Deferred.await(consumeStartupCommands).pipe(
                  Effect.andThen(Ref.set(goalSupport, nativeGoals)),
                  Effect.andThen(
                    Ref.set(workspaceCommands, {
                      names: event.availableCommands.map((command) => command.name),
                      cwd,
                    }),
                  ),
                )
              : Effect.void,
        });
        const threadId = ThreadId.make("thread-antigravity-compaction");
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const opening = yield* adapter
          .openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("provider-session-antigravity-compaction"),
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(startupMilestone);
        yield* Deferred.succeed(consumeStartupCommands, undefined);
        const session = yield* Fiber.join(opening);
        assert.deepEqual(yield* Ref.get(workspaceCommands), {
          names: compact ? ["compact"] : ["plan", "logout"],
          cwd: process.cwd(),
        });
        const compactThread = session.compactThread;
        assert.isDefined(compactThread);
        assert.equal(session.providerSession.capabilities.turns.supportsNativeGoals, nativeGoals);
        assert.equal((yield* adapter.getCapabilities()).turns.supportsNativeGoals, nativeGoals);
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const turnInput = makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          modelSelection,
          runtimePolicy,
          now: yield* DateTime.now,
          messageText: "Compact the conversation.",
        });
        if (compact) {
          yield* compactThread!(turnInput);
          const events = yield* session.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          );
          assert.isTrue(
            events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "compaction" &&
                event.turnItem.status === "completed",
            ),
          );
        } else {
          const error = yield* compactThread!(turnInput).pipe(Effect.flip);
          assert.instanceOf(error, ProviderAdapter.ProviderAdapterTurnStartError);
          assert.instanceOf(error.cause, ProviderAdapter.ProviderCompactionUnsupportedError);
        }
        const prompts = (yield* fileSystem.readFileString(requestLog))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { method?: string; params?: { prompt?: unknown } })
          .filter((request) => request.method === "session/prompt")
          .map((request) => request.params?.prompt);
        assert.deepEqual(prompts, compact ? [[{ type: "text", text: "/compact" }]] : []);
      }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 session open", () => {
  it.effect.each([
    {
      name: "browser sign-in",
      cause: new EffectAcpErrors.AcpTransportError({
        detail: ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
        cause: undefined,
      }),
      requiresSignIn: true,
    },
    {
      name: "ACP authentication required",
      cause: EffectAcpErrors.AcpRequestError.authRequired(),
      requiresSignIn: true,
    },
    {
      name: "transport failure",
      cause: new EffectAcpErrors.AcpTransportError({
        detail: "Connection closed",
        cause: undefined,
      }),
      requiresSignIn: undefined,
    },
  ] as const)("classifies $name during session open", ({ cause, requiresSignIn }) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("antigravity-sign-in-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: () => Effect.fail(cause),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const threadId = ThreadId.make("thread-antigravity-sign-in");
      const error = yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-sign-in"),
          modelSelection: { instanceId, model: "gemini-test-low" },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
          }),
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "ProviderAdapterOpenSessionError");
      assert.equal(
        error._tag === "ProviderAdapterOpenSessionError" && error.requiresSignIn,
        requiresSignIn,
      );
    }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 client file system", () => {
  it.effect("serves confined reads and leaves edits to the agent's diff tools", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      // effect-acp keeps the last handler registered per method; so does this.
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      let writeTextFile: Parameters<RuntimeService["handleWriteTextFile"]>[0] | undefined;
      const logs = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-log-" });
      const requestLog = path.join(logs, "requests.ndjson");
      const crypto = yield* SecureRandom.SecureRandom;
      const instanceId = ProviderInstanceId.make("antigravity-containment-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1", T3_ACP_REQUEST_LOG_PATH: requestLog },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleReadTextFile: (handler) =>
                Effect.sync(() => {
                  readTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
              handleWriteTextFile: (handler) =>
                Effect.sync(() => {
                  writeTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleWriteTextFile(handler))),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-workspace-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-outside-",
      });
      const outsideFile = path.join(outside, "secret.txt");
      yield* fileSystem.writeFileString(outsideFile, "secret");
      const attachment = path.join(host.paths.attachmentsDir, "pasted.txt");
      yield* fileSystem.writeFileString(attachment, "pasted");

      const threadId = ThreadId.make("thread-antigravity-containment");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-containment"),
        modelSelection,
        runtimePolicy,
      });
      yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
      const requests = (yield* fileSystem.readFileString(requestLog))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              params?: {
                clientCapabilities?: { fs?: unknown };
                clientInfo?: { name?: string };
                additionalDirectories?: unknown;
              };
            },
        );
      const initialize = requests.find((request) => request.method === "initialize");
      // agy runs shell commands from its lexicographically first root, so attachments
      // must reach it through client reads, never as an extra workspace root.
      assert.isUndefined(
        requests.find((request) => request.method === "session/new")?.params?.additionalDirectories,
      );
      assert.deepEqual(initialize?.params?.clientCapabilities?.fs, {
        readTextFile: true,
        writeTextFile: false,
      });
      assert.equal(initialize?.params?.clientInfo?.name, "t3-code");
      assert.isUndefined(writeTextFile);
      if (readTextFile === undefined) {
        return yield* Effect.die("Antigravity sessions must serve client file reads");
      }
      const context = (method: string) => ({ requestId: `test-${method}`, method });

      const insidePath = path.join(workspace, "src", "inside.ts");
      yield* fileSystem.makeDirectory(path.dirname(insidePath), { recursive: true });
      yield* fileSystem.writeFileString(insidePath, "inside");
      const pasted = yield* readTextFile(
        { sessionId: "mock-session-1", path: attachment },
        context("fs/read_text_file"),
      );
      assert.equal(pasted.content, "pasted");
      yield* fileSystem.writeFileString(insidePath, "\uFEFFfirst\né中🙂\nlast");
      const sliced = yield* readTextFile(
        { sessionId: "mock-session-1", path: insidePath, line: 2, limit: 1 },
        context("fs/read_text_file"),
      );
      assert.equal(sliced.content, "é中🙂");
      yield* fileSystem.writeFileString(insidePath, "inside");
      for (const [name, bytes] of [
        ["image.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        ["data.bin", new Uint8Array([0x61, 0, 0x62])],
      ] as const) {
        const binaryPath = path.join(workspace, name);
        yield* fileSystem.writeFile(binaryPath, bytes);
        const binaryRead = yield* readTextFile(
          { sessionId: "mock-session-1", path: binaryPath },
          context("fs/read_text_file"),
        ).pipe(Effect.flip);
        assert.propertyVal(binaryRead, "code", -32602, `${name} is refused as binary`);
      }

      const outsideRead = yield* readTextFile(
        { sessionId: "mock-session-1", path: outsideFile },
        context("fs/read_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(outsideRead));
      const linkPath = path.join(workspace, "linked-secret.txt");
      yield* fileSystem.symlink(outsideFile, linkPath);
      const linkedRead = yield* readTextFile(
        { sessionId: "mock-session-1", path: linkPath },
        context("fs/read_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(linkedRead), "a read through an escaping symlink is denied");
      const insideLink = path.join(workspace, "inside-link.ts");
      yield* fileSystem.symlink(insidePath, insideLink);
      const viaInsideLink = yield* readTextFile(
        { sessionId: "mock-session-1", path: insideLink },
        context("fs/read_text_file"),
      );
      assert.equal(viaInsideLink.content, "inside");
    }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 workspace changes", () => {
  it.effect("confines file requests to the workspace of the turn in progress", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const promptReceived = yield* Deferred.make<Parameters<RuntimeService["prompt"]>[0]>();
      const host = yield* ProviderHost.ProviderHost;
      const document = ChatFileAttachment.make({
        type: "file",
        id: "native-pdf",
        name: "diagram.pdf",
        mimeType: "application/pdf",
        sizeBytes: 9,
      });
      const documentPath = host.resolveAttachmentPath(document)!;
      yield* fileSystem.writeFileString(documentPath, "%PDF-1.7");
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-workspace-change-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1", T3_ACP_HANG_PROMPT_FOREVER: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              prompt: (request) =>
                Deferred.succeed(promptReceived, request).pipe(
                  Effect.andThen(runtime.prompt(request)),
                ),
              start: () =>
                runtime.start().pipe(
                  Effect.map((started) => ({
                    ...started,
                    initializeResult: {
                      ...started.initializeResult,
                      agentCapabilities: {
                        ...started.initializeResult.agentCapabilities,
                        promptCapabilities: { image: true, audio: true, embeddedContext: true },
                      },
                    },
                  })),
                ),
              handleReadTextFile: (handler) =>
                Effect.sync(() => {
                  readTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const workspaceA = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-a-" });
      const workspaceB = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-b-" });
      yield* fileSystem.writeFileString(path.join(workspaceA, "a.txt"), "from a");
      yield* fileSystem.writeFileString(path.join(workspaceB, "b.txt"), "from b");
      const policyFor = (cwd: string) =>
        ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd,
        });
      const threadId = ThreadId.make("thread-antigravity-workspace-change");
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-workspace-change"),
        modelSelection,
        runtimePolicy: policyFor(workspaceA),
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policyFor(workspaceA),
      });
      const now = yield* DateTime.now;
      yield* session
        .startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project-antigravity-workspace-change"),
            title: "Antigravity workspace change",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: workspaceB,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make("run-antigravity-workspace-change"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("attempt-antigravity-workspace-change"),
          rootNodeId: NodeId.make("node-antigravity-workspace-change"),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-antigravity-workspace-change"),
            text: "read b.txt",
            attachments: [document],
          },
          modelSelection,
          runtimePolicy: policyFor(workspaceB),
        })
        .pipe(Effect.forkScoped);
      yield* session.events.pipe(
        Stream.filter((event) => event.type === "provider_turn.updated"),
        Stream.runHead,
      );
      const sent = yield* Deferred.await(promptReceived);
      assert.deepEqual(
        sent.prompt.filter((block) => block.type === "resource_link"),
        [
          {
            type: "resource_link",
            uri: (yield* path.toFileUrl(documentPath)).href,
            name: "diagram.pdf",
            mimeType: "application/pdf",
            size: 8,
          },
        ],
      );
      assert.include(JSON.stringify(sent.prompt), JSON.stringify(documentPath).slice(1, -1));
      if (readTextFile === undefined) {
        return yield* Effect.die("Antigravity sessions must serve client file requests");
      }
      const context = { requestId: "test-read", method: "fs/read_text_file" };
      const fromB = yield* readTextFile(
        { sessionId: "mock-session-1", path: path.join(workspaceB, "b.txt") },
        context,
      );
      assert.equal(fromB.content, "from b");
      const fromA = yield* readTextFile(
        { sessionId: "mock-session-1", path: path.join(workspaceA, "a.txt") },
        context,
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(fromA), "the previous workspace is no longer readable");
    }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 html_render pages", () => {
  it.effect("shows the page html_render published when the agent reports only a summary", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-html-render-test");
      const threadId = ThreadId.make("thread-antigravity-html-render");
      yield* mcpSessions.set({
        environmentId: EnvironmentId.make("env-antigravity-html-render"),
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-html-render"),
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer antigravity-html-render-token",
        browserToolsAvailable: true,
      });
      const page = (name: string) => ({
        attachmentId: `${threadId}-${name}-html`,
        title: "Revenue",
        height: 240,
      });
      // Long enough that Antigravity bounds the html the adapter sees.
      const rows = Array.from({ length: 500 }, (_, row) => `<tr><td>Row ${row}</td></tr>`);
      const report = { html: `<table>${rows.join("")}</table>`, title: "Revenue", height: 240 };
      const failed = { ...report, html: "<p>Revenue</p>" };
      const errored = { ...report, html: "<p>Revenue error</p>" };
      const telemetry = {
        html: `<ul>${rows.join("").replaceAll("tr", "li")}</ul>`,
        title: "Telemetry",
        height: 411,
      };
      const proxied = {
        html: "<p>Proxied chart</p>",
        title: "Proxied",
        height: 300,
      };
      let capturedMcpServers:
        | {
            readonly stdio: ReadonlyArray<EffectAcpSchema.McpServer>;
            readonly http: ReadonlyArray<EffectAcpSchema.McpServer>;
          }
        | undefined;
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) => {
          capturedMcpServers = {
            stdio: input.mcpServers ?? [],
            http: input.httpMcpServers ?? [],
          };
          return makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdate = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              // agy_acp_server 1.3/1.4 without a permission prompt: the call is
              // titled "Running <tool>" and completes with the step's summary
              // in place of the MCP result.
              prompt: () =>
                Effect.gen(function* () {
                  const send = (update: EffectAcpSchema.SessionUpdate) =>
                    sessionUpdate === undefined
                      ? Effect.die("the adapter must handle session updates")
                      : sessionUpdate(
                          normalizeAntigravitySessionUpdate({
                            sessionId: "mock-session-1",
                            update,
                          }),
                        );
                  const calls = [
                    ["published", report],
                    ["unpublished", { ...report, html: "<p>Costs</p>" }],
                    ["failed", failed],
                    ["error", errored],
                  ] as const;
                  for (const [toolCallId, rawInput] of calls) {
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title: "Running html_render",
                      kind: "other",
                      status: "in_progress",
                      rawInput,
                    });
                  }
                  yield* mcpSessions.recordHtmlRender(threadId, report, page("report"));
                  yield* mcpSessions.recordHtmlRender(threadId, failed, page("failed"));
                  yield* mcpSessions.recordHtmlRender(threadId, errored, page("error"));
                  for (const [toolCallId, status] of [
                    ["unpublished", "completed"],
                    ["failed", "failed"],
                    ["published", "completed"],
                    ["published", "completed"],
                  ] as const) {
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status,
                      rawOutput: `Summary of ${toolCallId}`,
                    });
                  }
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "error",
                    status: "completed",
                    rawOutput: { result: { isError: true, content: [] } },
                  });
                  for (const [name, rawInput] of [
                    ["failed", failed],
                    ["error", errored],
                  ] as const) {
                    const toolCallId = `${name}-retry`;
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title: "Running html_render",
                      kind: "other",
                      status: "in_progress",
                      rawInput,
                    });
                    yield* mcpSessions.recordHtmlRender(threadId, rawInput, page(toolCallId));
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId: name,
                      status: name === "failed" ? "failed" : "completed",
                      rawOutput:
                        name === "failed"
                          ? "Summary of failed"
                          : { result: { isError: true, content: [] } },
                    });
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status: "completed",
                      rawOutput: `Summary of ${toolCallId}`,
                    });
                  }
                  yield* mcpSessions.recordHtmlRender(threadId, report, page("replacement"));
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "published",
                    status: "completed",
                    rawOutput: { htmlRender: page("replacement") },
                  });
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "published",
                    status: "completed",
                    rawOutput: "Summary of published",
                  });
                  // agy 1.5.8 titles the call with its MCP name and completes without any output.
                  yield* send({
                    sessionUpdate: "tool_call",
                    toolCallId: "agy-1.5.8",
                    title: "Run mcp_t3-code_html_render",
                    kind: "other",
                    status: "in_progress",
                    rawInput: { ...telemetry, toolSummary: "Render telemetry" },
                  });
                  yield* mcpSessions.recordHtmlRender(threadId, telemetry, page("agy-1.5.8"));
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "agy-1.5.8",
                    status: "completed",
                  });
                  // Deferred-proxy calls wrap html_render inside `tool_call`.
                  yield* send({
                    sessionUpdate: "tool_call",
                    toolCallId: "tool-call-proxy",
                    title: "Run mcp_t3-code_tool_call",
                    kind: "other",
                    status: "in_progress",
                    rawInput: {
                      name: "html_render",
                      arguments: proxied,
                      toolSummary: "Render proxied",
                    },
                  });
                  yield* mcpSessions.recordHtmlRender(threadId, proxied, page("tool-call-proxy"));
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "tool-call-proxy",
                    status: "completed",
                  });
                  return { stopReason: "end_turn" as const };
                }),
            })),
          );
        },
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-html-render"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* session.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project-antigravity-html-render"),
          title: "Antigravity html_render",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make("run-antigravity-html-render"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-antigravity-html-render"),
        rootNodeId: NodeId.make("node-antigravity-html-render"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-antigravity-html-render"),
          text: "chart the revenue",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      const events = Array.from(
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const tool = (nativeId: string) => {
        const event = events.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId,
        );
        if (event?.type !== "turn_item.updated" || event.turnItem.type !== "dynamic_tool") {
          return undefined;
        }
        const item = event.turnItem;
        return {
          status: item.status,
          toolName: item.toolName,
          page: htmlRenderFromToolItem(item),
          output: item.output,
        };
      };

      assert.deepEqual(tool("published"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: page("replacement"),
        output: { htmlRender: page("replacement") },
      });
      assert.deepEqual(tool("unpublished"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: "Summary of unpublished",
      });
      assert.deepEqual(tool("failed"), {
        status: "failed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: "Summary of failed",
      });
      assert.deepEqual(tool("error"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: [],
      });
      assert.deepEqual(
        events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.nativeItemRef?.nativeId === "published" &&
          event.turnItem.status === "completed"
            ? [htmlRenderFromToolItem(event.turnItem)]
            : [],
        ),
        [page("report"), page("report"), page("replacement"), page("replacement")],
      );
      for (const name of ["failed-retry", "error-retry", "agy-1.5.8", "tool-call-proxy"]) {
        assert.deepEqual(tool(name), {
          status: "completed",
          toolName: "t3-code.html_render",
          page: page(name),
          output: { htmlRender: page(name) },
        });
      }
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, report), undefined);
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, failed), undefined);
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, errored), undefined);
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, telemetry), undefined);
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, proxied), undefined);
      assert.isDefined(capturedMcpServers);
      const stdioServer = capturedMcpServers!.stdio[0];
      const httpServer = capturedMcpServers!.http[0];
      const stdioEnv =
        stdioServer !== undefined && !("type" in stdioServer) ? (stdioServer.env ?? []) : [];
      const httpHeaders =
        httpServer !== undefined &&
        "type" in httpServer &&
        httpServer.type === "http" &&
        Array.isArray(httpServer.headers)
          ? httpServer.headers
          : [];
      assert.isTrue(
        stdioEnv.some(
          (entry) => entry.name === "T3_ACP_MCP_TOOL_EXPOSURE" && entry.value === "deferred-proxy",
        ),
      );
      assert.isTrue(
        httpHeaders.some(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            "name" in entry &&
            entry.name === "t3-tool-exposure" &&
            "value" in entry &&
            entry.value === "deferred-proxy",
        ),
      );
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect(
    "recovers T3 MCP tool results across omitted outputs, replays, errors, and turn boundaries",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const path = yield* Path.Path;
        const crypto = yield* SecureRandom.SecureRandom;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
        let promptIndex = 0;
        let turn1Epoch = 0;
        const instanceId = ProviderInstanceId.make("antigravity-mcp-result-test");
        const threadId = ThreadId.make("thread-antigravity-mcp-result");
        const statusUpdate = "### Current Status\n\nAll checks are passing.";
        const inProgressText = "Streamed while running.";
        const lateText = "Confirmed on a later completion.";
        const lateErrorText = "Late explicit error.";
        const unfinishedText = "Still running when turn ended.";
        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: { T3_ACP_ANTIGRAVITY: "1" },
              },
            }).pipe(
              Effect.provideService(SecureRandom.SecureRandom, crypto),
              Effect.map((runtime): RuntimeService => ({
                ...runtime,
                handleSessionUpdate: (handler) =>
                  Effect.sync(() => {
                    sessionUpdate = handler;
                  }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
                prompt: () =>
                  Effect.gen(function* () {
                    promptIndex += 1;
                    const send = (update: EffectAcpSchema.SessionUpdate) =>
                      sessionUpdate === undefined
                        ? Effect.die("the adapter must handle session updates")
                        : sessionUpdate(
                            normalizeAntigravitySessionUpdate({
                              sessionId: "mock-session-1",
                              update,
                            }),
                          );
                    const startTool = (
                      toolCallId: string,
                      toolName: string,
                      rawInput: Record<string, unknown>,
                    ) =>
                      send({
                        sessionUpdate: "tool_call",
                        toolCallId,
                        title: `Run mcp_t3-code_${toolName}`,
                        kind: "other",
                        status: "in_progress",
                        rawInput,
                      });
                    const updateTool = (
                      toolCallId: string,
                      status: "in_progress" | "completed" | "failed",
                      rawOutput?: unknown,
                    ) =>
                      send({
                        sessionUpdate: "tool_call_update",
                        toolCallId,
                        status,
                        ...(rawOutput === undefined ? {} : { rawOutput }),
                      });
                    const recordSend = (message: string) =>
                      mcpSessions.recordToolResult(
                        threadId,
                        "send_to_user",
                        { message },
                        { sentMessage: message },
                      );

                    if (promptIndex === 2) {
                      // A Turn 1 handler finishing after Turn 1 closed must be rejected by epoch.
                      yield* mcpSessions.recordToolResult(
                        threadId,
                        "send_to_user",
                        { message: unfinishedText },
                        { sentMessage: unfinishedText },
                        { epoch: turn1Epoch },
                      );
                      yield* startTool("turn2-leaked-check", "send_to_user", {
                        message: unfinishedText,
                      });
                      yield* updateTool("turn2-leaked-check", "completed", "Summary of turn 2");
                      return { stopReason: "end_turn" as const };
                    }

                    turn1Epoch = yield* mcpSessions.toolResultEpoch(threadId);

                    // agy 1.5.x adds toolSummary and omits output on completion, then may replay.
                    yield* startTool("send-empty", "send_to_user", {
                      message: statusUpdate,
                      toolSummary: "Send status update",
                    });
                    yield* recordSend(statusUpdate);
                    yield* updateTool("send-empty", "completed");
                    yield* updateTool("send-empty", "in_progress");
                    yield* updateTool("send-empty", "completed", "Summary replay");

                    // Streaming output during in_progress still drains on completion.
                    yield* startTool("send-streaming", "send_to_user", { message: inProgressText });
                    yield* recordSend(inProgressText);
                    yield* updateTool("send-streaming", "in_progress", {
                      sentMessage: inProgressText,
                    });
                    yield* updateTool("send-streaming", "completed", {
                      sentMessage: inProgressText,
                    });
                    yield* startTool("send-streaming-unpublished", "send_to_user", {
                      message: inProgressText,
                    });
                    yield* updateTool("send-streaming-unpublished", "completed");

                    // Explicit MCP error preserves diagnostic content across summary replays.
                    yield* startTool("send-errored", "send_to_user", { message: "Denied" });
                    yield* updateTool("send-errored", "completed", {
                      result: {
                        isError: true,
                        structuredContent: { sentMessage: "Denied" },
                        content: [{ type: "text", text: "Denied by policy" }],
                      },
                    });
                    yield* updateTool("send-errored", "completed", "Summary of denied");

                    // Initial miss -> late explicit success or error still drains its new record.
                    yield* startTool("send-late", "send_to_user", { message: lateText });
                    yield* updateTool("send-late", "completed");
                    yield* recordSend(lateText);
                    yield* updateTool("send-late", "completed", { sentMessage: lateText });
                    yield* startTool("send-late-unpublished", "send_to_user", {
                      message: lateText,
                    });
                    yield* updateTool("send-late-unpublished", "completed");

                    yield* startTool("send-late-error", "send_to_user", { message: lateErrorText });
                    yield* updateTool("send-late-error", "completed");
                    yield* mcpSessions.recordToolResult(
                      threadId,
                      "send_to_user",
                      { message: lateErrorText },
                      { isError: true },
                    );
                    yield* updateTool("send-late-error", "completed", {
                      result: { isError: true, content: [{ type: "text", text: "Denied late" }] },
                    });
                    yield* startTool("send-late-error-sibling", "send_to_user", {
                      message: lateErrorText,
                    });
                    yield* updateTool("send-late-error-sibling", "completed");

                    // Empty-input completion that misses still recovers once a later completion brings arguments,
                    // and replacing arguments on the same call ID re-matches against the new arguments.
                    yield* startTool("send-late-args", "send_to_user", {});
                    yield* recordSend("First args");
                    yield* updateTool("send-late-args", "completed");
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId: "send-late-args",
                      status: "completed",
                      rawInput: { message: "First args" },
                    });
                    yield* recordSend("Second args");
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId: "send-late-args",
                      status: "completed",
                      rawInput: { message: "Second args" },
                      rawOutput: "Summary of second",
                    });

                    // Bare failure without reported output must not consume a sibling call's cached result.
                    yield* startTool("send-bare-fail", "send_to_user", { message: "Shared ready" });
                    yield* startTool("send-bare-fail-sibling", "send_to_user", {
                      message: "Shared ready",
                    });
                    yield* recordSend("Shared ready");
                    yield* updateTool("send-bare-fail", "failed");
                    yield* updateTool("send-bare-fail-sibling", "completed");

                    // preview_recording_stop recovers its recording id.
                    yield* startTool("recording-stop", "preview_recording_stop", {
                      toolSummary: "Stop preview recording",
                    });
                    yield* mcpSessions.recordToolResult(
                      threadId,
                      "preview_recording_stop",
                      {},
                      { id: `${threadId}-rec-1` },
                    );
                    yield* updateTool("recording-stop", "completed");

                    // Unfinished call projected at turn end must not claim or leak to Turn 2.
                    yield* startTool("send-unfinished", "send_to_user", {
                      message: unfinishedText,
                    });
                    yield* recordSend(unfinishedText);

                    return { stopReason: "end_turn" as const };
                  }),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-mcp-result"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        const runTurn = (ordinal: number) =>
          Effect.gen(function* () {
            yield* session.startTurn(
              makeTurnInput({
                threadId,
                providerThread,
                instanceId,
                runtimePolicy,
                now,
                ordinal,
                modelSelection,
              }),
            );
            return Array.from(
              yield* session.events.pipe(
                Stream.takeUntil((event) => event.type === "turn.terminal"),
                Stream.runCollect,
              ),
            );
          });
        const turn1Events = yield* runTurn(1);
        const turn2Events = yield* runTurn(2);
        const toolIn = (events: ReadonlyArray<(typeof turn1Events)[number]>, nativeId: string) => {
          const event = events.findLast(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId === nativeId,
          );
          return event?.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
            ? event.turnItem
            : undefined;
        };
        const tool = (nativeId: string) => toolIn(turn1Events, nativeId);

        const sendEmptyUpdates = turn1Events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.nativeItemRef?.nativeId === "send-empty" &&
          event.turnItem.status === "completed"
            ? [event.turnItem]
            : [],
        );
        assert.deepEqual(
          sendEmptyUpdates.map((update) => sentMessageFromToolItem(update)),
          [statusUpdate, statusUpdate],
        );
        assert.strictEqual(sentMessageFromToolItem(tool("send-streaming")!), inProgressText);
        assert.strictEqual(sentMessageFromToolItem(tool("send-streaming-unpublished")!), undefined);
        const erroredUpdates = turn1Events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.nativeItemRef?.nativeId === "send-errored" &&
          event.turnItem.status === "completed"
            ? [event.turnItem]
            : [],
        );
        assert.strictEqual(erroredUpdates.length, 2);
        for (const update of erroredUpdates) {
          assert.strictEqual(compactDynamicToolOutput(update.output)?.isError, true);
          assert.include(JSON.stringify(update.output), "Denied by policy");
          assert.strictEqual(sentMessageFromToolItem(update), undefined);
        }
        assert.strictEqual(sentMessageFromToolItem(tool("send-late")!), lateText);
        assert.strictEqual(sentMessageFromToolItem(tool("send-late-unpublished")!), undefined);
        const lateErrorSibling = tool("send-late-error-sibling");
        assert.isDefined(lateErrorSibling);
        assert.strictEqual(lateErrorSibling.status, "completed");
        assert.strictEqual(lateErrorSibling.output, undefined);
        assert.strictEqual(sentMessageFromToolItem(tool("send-late-args")!), "Second args");
        assert.strictEqual(
          sentMessageFromToolItem(tool("send-bare-fail-sibling")!),
          "Shared ready",
        );
        assert.strictEqual(sentMessageFromToolItem(tool("send-unfinished")!), undefined);
        assert.strictEqual(
          sentMessageFromToolItem(toolIn(turn2Events, "turn2-leaked-check")!),
          undefined,
        );
        assert.strictEqual(
          previewRecordingIdFromToolItem(tool("recording-stop")!),
          `${threadId}-rec-1`,
        );
      }).pipe(Effect.provide(layerSession)),
  );
});

/**
 * A session whose prompt reports one running command and returns end_turn, as agy 1.5.11 does
 * for `run_command` once `WaitMsBeforeAsync` passes. The test sends every later frame.
 */
const openSessionWithRunningCommand = Effect.fn("openSessionWithRunningCommand")(function* (
  commandInput: Record<string, unknown>,
  /** The prompt launches one agy 1.5 subagent instead; its records live below this profile. */
  detachedChildProfile?: string,
  /** agy 1.5.11 answers a steered prompt once the next one arrives, which runs to `releaseSteer`. */
  steering?: { readonly agentVersion: string; readonly holdsFirstPrompt: boolean },
  options?: {
    readonly profileDirectory?: string;
    readonly initialToolCalls?: ReadonlyArray<EffectAcpSchema.SessionUpdate>;
  },
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const crypto = yield* SecureRandom.SecureRandom;
  const mockAgentPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
  let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
  let requestPermission: Parameters<RuntimeService["handleRequestPermission"]>[0] | undefined;
  const send = (update: EffectAcpSchema.SessionUpdate) =>
    sessionUpdate === undefined
      ? Effect.die("the adapter must handle session updates")
      : sessionUpdate(normalizeAntigravitySessionUpdate({ sessionId: "mock-session-1", update }));
  const command = {
    toolCallId: "call_fetch",
    kind: "execute",
    title: "node fetch_throughput.mjs",
    rawInput: { CommandLine: "node fetch_throughput.mjs", ...commandInput },
  } as const;
  let cancels = 0;
  const prompts: Array<{
    readonly prompt: ReadonlyArray<EffectAcpSchema.ContentBlock>;
    readonly released: Deferred.Deferred<void> | undefined;
  }> = [];
  const steered = yield* Deferred.make<void>();
  const releaseSteer = yield* Deferred.make<void>();
  let terminate: AntigravityAdapterV2RuntimeInput["onTermination"];
  const usage = { sessionUpdate: "usage_update", used: 9000, size: 1048576 } as const;
  const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
  const scheduledFinalizes = yield* Queue.unbounded<Duration.Input>();
  const instanceId = ProviderInstanceId.make("antigravity-wake-test");
  const threadId = ThreadId.make("thread-antigravity-wake");
  const selfInvocation = yield* resolveSelfInvocation();
  const profileDirectory = options?.profileDirectory ?? detachedChildProfile;
  const adapterOptions: AntigravityAdapterV2Options = {
    instanceId,
    selfInvocation,
    continuationRequests: { offer: (request) => Effect.sync(() => void offers.push(request)) },
    makeRuntime: (input) => {
      terminate = input.onTermination;
      return makeAntigravityAcpRuntime({
        ...input,
        childProcessSpawner,
        spawn: {
          command: process.execPath,
          args: [mockAgentPath],
          cwd: input.cwd,
          env: {
            T3_ACP_ANTIGRAVITY: "1",
            ...(steering === undefined ? {} : { T3_ACP_AGENT_VERSION: steering.agentVersion }),
          },
        },
      }).pipe(
        Effect.provideService(SecureRandom.SecureRandom, crypto),
        Effect.map((runtime): RuntimeService => ({
          ...runtime,
          cancel: Effect.sync(() => {
            cancels += 1;
          }),
          handleSessionUpdate: (handler) =>
            Effect.sync(() => {
              sessionUpdate = handler;
            }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
          handleRequestPermission: (handler) =>
            Effect.sync(() => {
              requestPermission = handler;
            }).pipe(Effect.andThen(runtime.handleRequestPermission(handler))),
          prompt: (payload, promptOptions) =>
            Effect.gen(function* () {
              prompts.push({ prompt: payload.prompt, released: promptOptions?.released });
              if (promptOptions?.dispatched !== undefined) {
                yield* Deferred.succeed(promptOptions.dispatched, undefined);
              }
              if (prompts.length > 1) {
                yield* Deferred.succeed(steered, undefined);
                yield* Deferred.await(releaseSteer);
                return { stopReason: "end_turn" as const };
              }
              if (options?.initialToolCalls !== undefined) {
                for (const toolUpdate of options.initialToolCalls) {
                  yield* send(toolUpdate);
                }
              } else {
                yield* send(
                  detachedChildProfile === undefined
                    ? { sessionUpdate: "tool_call", ...command, status: "in_progress" }
                    : {
                        sessionUpdate: "tool_call",
                        toolCallId: "call_research",
                        kind: "other",
                        title: "Run invoke_subagent",
                        status: "completed",
                        rawInput: { TypeName: "research", Role: "Researcher", Prompt: "Read it" },
                      },
                );
              }
              yield* send({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "I'll render once the fetch finishes." },
              });
              yield* send(usage);
              if (steering?.holdsFirstPrompt === true) yield* Deferred.await(steered);
              return { stopReason: "end_turn" as const };
            }),
        })),
      );
    },
    withProcess: (_stop, task) => task,
    defaultModel: Effect.undefined,
    ...(profileDirectory === undefined ? {} : { profileDirectory }),
  };
  const adapter =
    options === undefined
      ? yield* makeAntigravityAdapterV2(adapterOptions)
      : yield* makeAcpAdapterV2({
          instanceId,
          flavor: makeAntigravityAcpAdapterFlavor({
            ...adapterOptions,
            random: crypto,
            fileSystem: yield* FileSystem.FileSystem,
            path,
            host: yield* ProviderHost.ProviderHost,
          }),
          selfInvocation,
          ...(adapterOptions.continuationRequests === undefined
            ? {}
            : { continuationRequests: adapterOptions.continuationRequests }),
          testHooks: {
            onDeferredFinalizeScheduled: (debounce) => Queue.offer(scheduledFinalizes, debounce),
          },
        });
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: process.cwd(),
  });
  const modelSelection = { instanceId, model: "gemini-test-low" } as const;
  const session = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-antigravity-wake"),
    modelSelection,
    runtimePolicy,
  });
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* session.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const until = (done: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      while (true) {
        const event = yield* Queue.take(events);
        seen.push(event);
        if (done(event)) return seen;
      }
    });
  const providerThread = yield* session.ensureThread({
    threadId,
    modelSelection,
    runtimePolicy,
  });
  const now = yield* DateTime.now;
  const startTurn = (ordinal: number, continuation: boolean) =>
    session.startTurn({
      appThread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project-antigravity-wake"),
        title: "Antigravity wake",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make(`run-antigravity-wake-${ordinal}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`attempt-antigravity-wake-${ordinal}`),
      rootNodeId: NodeId.make(`node-antigravity-wake-${ordinal}`),
      providerThread,
      message: {
        ...(continuation
          ? { createdBy: "agent" as const, creationSource: "provider" as const }
          : { createdBy: "user" as const, creationSource: "web" as const }),
        messageId: MessageId.make(`message-antigravity-wake-${ordinal}`),
        text: "chart the throughput",
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
    });

  return {
    session,
    providerThread,
    command,
    usage,
    offers,
    scheduledFinalizes,
    send,
    startTurn,
    until,
    throughTerminal: until((event) => event.type === "turn.terminal"),
    // The reply before end_turn closes when the prompt settles, held open or not.
    throughPromptSettled: until(
      (event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "assistant_message" &&
        event.turnItem.status === "completed",
    ),
    requestPermission: (...args: Parameters<NonNullable<typeof requestPermission>>) =>
      requestPermission === undefined
        ? Effect.die("the adapter must handle permission requests")
        : requestPermission(...args),
    cancels: () => cancels,
    prompts,
    releaseSteer: Deferred.succeed(releaseSteer, undefined),
    runtimeDies: Effect.suspend(
      () =>
        terminate?.(
          new EffectAcpErrors.AcpTransportError({ detail: "agent exited", cause: "exit" }),
        ) ?? Effect.die("the adapter must watch its runtime"),
    ),
  };
});

describe("AntigravityAdapterV2 work after the prompt ends", () => {
  // agy sets `IsDaemon` on a command it does not wait for. When it exits, the agent replies
  // with no prompt open.
  it.effect("continues in one run when a finished daemon wakes the agent", () =>
    Effect.gen(function* () {
      const { command, usage, offers, send, startTurn, throughTerminal, requestPermission } =
        yield* openSessionWithRunningCommand({ IsDaemon: true, WaitMsBeforeAsync: 500 });
      yield* startTurn(1, false);
      const promptTerminal = (yield* throughTerminal).at(-1);
      assert.equal(promptTerminal?.type === "turn.terminal" && promptTerminal.status, "completed");

      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      assert.lengthOf(offers, 1, "the finished daemon must wake the thread");
      // The agent can ask before the app has started the continuation run.
      const followUp = { toolCallId: "call_analyze", kind: "execute", title: "node analyze.mjs" };
      const permission = yield* requestPermission(
        {
          sessionId: "mock-session-1",
          toolCall: { ...followUp, status: "pending" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
        { requestId: "permission-1", method: "session/request_permission" },
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* offers[0]!.dispatchIfCurrent!(Effect.void);
      yield* startTurn(2, true);
      assert.deepEqual(yield* Fiber.join(permission), {
        outcome: { outcome: "selected", optionId: "allow" },
      });

      // The model took 6.7 s to answer the finished command; the run must outlast that silence.
      yield* TestClock.adjust("10 seconds");
      yield* send({ sessionUpdate: "tool_call", ...followUp, status: "completed" });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Here is the chart." },
      });
      yield* TestClock.adjust("10 seconds");
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const continued = yield* throughTerminal;
      const continuedTerminal = continued.at(-1);
      assert.equal(
        continuedTerminal?.type === "turn.terminal" && continuedTerminal.status,
        "completed",
      );
      assert.isTrue(
        continued.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.runId === RunId.make("run-antigravity-wake-2"),
        ),
        "the reply belongs to the continuation run",
      );
      const finished = continued.findLast(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === command.toolCallId,
      );
      assert.equal(finished?.type === "turn_item.updated" && finished.turnItem.status, "completed");
      assert.lengthOf(offers, 1, "one wake is one run");
    }).pipe(Effect.provide(layerSession)),
  );

  // Frames as agy 1.5.11 sent them for `run_command` with `WaitMsBeforeAsync`: the prompt returns
  // end_turn while the command runs, and the agent replies when the command finishes.
  it.effect("keeps the run open while a command the agent waits for still runs", () =>
    Effect.gen(function* () {
      const { command, usage, offers, send, startTurn, until, throughPromptSettled } =
        yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
      yield* startTurn(1, false);
      yield* throughPromptSettled;
      // Progress keeps a command past the post-settle hold bound, which counts silence only.
      for (const minute of [10, 20, 30]) {
        yield* TestClock.adjust("10 minutes");
        yield* send({
          sessionUpdate: "tool_call_update",
          ...command,
          status: "in_progress",
          rawOutput: { output: `fetched ${minute} pages` },
        });
      }
      yield* TestClock.adjust("10 minutes");
      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      yield* TestClock.adjust("10 seconds");
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Here is the chart." },
      });
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const run = yield* until((event) => event.type === "turn.terminal");
      const terminal = run.at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
      assert.include(JSON.stringify(run), "Here is the chart.", "the reply is part of the run");
      assert.lengthOf(offers, 0, "the open run needs no continuation");
    }).pipe(Effect.provide(layerSession)),
  );

  // A command whose terminal update never arrives would hold the run in Working forever with
  // an empty pending list and a finished reply above Stop.
  it.effect("settles a silent background command after the post-settle hold timeout", () =>
    Effect.gen(function* () {
      const { command, offers, startTurn, until, throughPromptSettled } =
        yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
      yield* startTurn(1, false);
      const prompt = yield* throughPromptSettled;

      // A running tool keeps the inactivity watchdog re-armed, so 20 silent minutes do not
      // settle this run on their own.
      yield* TestClock.adjust("20 minutes");
      yield* TestClock.adjust("11 minutes");
      const run = yield* until((event) => event.type === "turn.terminal");
      const terminal = run.at(-1);
      assert.equal(
        terminal?.type === "turn.terminal" && terminal.status,
        "completed",
        "the bounded hold finalizes the turn instead of leaving it running forever",
      );
      assert.equal(terminal?.type === "turn.terminal" && terminal.failure, null);
      assert.lengthOf(offers, 0, "a silent command produces no wake on its own");
      const commandItem = [...prompt, ...run].findLast(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === command.toolCallId,
      );
      assert.isTrue(
        commandItem?.type === "turn_item.updated" && commandItem.turnItem.status === "completed",
        "the silent command is no longer left as live activity on a settled run",
      );
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect("keeps a silent scheduled wake in its run past the command hold bound", () =>
    Effect.gen(function* () {
      const { usage, offers, send, startTurn, until, throughPromptSettled } =
        yield* openSessionWithRunningCommand({}, undefined, undefined, {
          initialToolCalls: [
            {
              sessionUpdate: "tool_call",
              toolCallId: "call_schedule",
              kind: "other",
              title: "Run schedule",
              status: "in_progress",
              rawInput: { DurationSeconds: 3600, Prompt: "Continue the task" },
            },
          ],
        });
      yield* startTurn(1, false);
      yield* throughPromptSettled;
      yield* TestClock.adjust("61 minutes");
      yield* send({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_schedule",
        status: "completed",
      });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Picked the task back up." },
      });
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const run = yield* until((event) => event.type === "turn.terminal");
      assert.include(
        JSON.stringify(run),
        "Picked the task back up.",
        "the wake reply stays in the run",
      );
      assert.lengthOf(offers, 0);
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect("keeps an unanswered question open past the command hold bound", () =>
    Effect.gen(function* () {
      const { command, usage, send, startTurn, until, throughPromptSettled, requestPermission } =
        yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
      yield* startTurn(1, false);
      yield* throughPromptSettled;
      const question = yield* requestPermission(
        {
          sessionId: "mock-session-1",
          toolCall: { toolCallId: "interaction_1", kind: "other", title: "Which port?" },
          options: [
            { optionId: "3000", name: "3000", kind: "allow_once" },
            { optionId: "8080", name: "8080", kind: "allow_once" },
          ],
        },
        { requestId: "question-1", method: "session/request_permission" },
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* TestClock.adjust("31 minutes");
      yield* Fiber.interrupt(question);
      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Here is the chart." },
      });
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const run = yield* until((event) => event.type === "turn.terminal");
      assert.include(JSON.stringify(run), "Here is the chart.", "the question kept the run open");
    }).pipe(Effect.provide(layerSession)),
  );

  // Command 2 finishes during reply 1; agy dequeues command 2 after reply 1's usage_update and
  // needs >3 s before streaming reply 2. Wait for reply 2 (bounded by the 2-minute quiet limit),
  // but still finalize at 3 s when both commands were batched into reply 1.
  it.effect.each([
    { case: "separate second wake", batched: false, stalls: false },
    { case: "batched into one wake reply", batched: true, stalls: false },
    { case: "stalled second wake hits quiet limit", batched: false, stalls: true },
  ])(
    "handles two parallel background commands finishing 500 ms apart ($case)",
    ({ batched, stalls }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profile = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agy-race-" });
        const generated = (kind: string) =>
          path.join(
            profile,
            "antigravity-acp",
            "brain",
            "mock-session-1",
            ".system_generated",
            kind,
          );
        const writeFile = (directory: string, name: string, body: string) =>
          fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(Effect.andThen(fileSystem.writeFileString(path.join(directory, name), body)));
        const cmd1 = {
          toolCallId: "call_gates",
          kind: "execute",
          title: "bin/gates back",
          rawInput: { CommandLine: "bin/gates back", WaitMsBeforeAsync: 10000 },
        } as const;
        const cmd2 = {
          toolCallId: "call_tests",
          kind: "execute",
          title: "bin/session test",
          rawInput: { CommandLine: "bin/session test", WaitMsBeforeAsync: 10000 },
        } as const;
        const { usage, offers, scheduledFinalizes, send, startTurn, until, throughPromptSettled } =
          yield* openSessionWithRunningCommand({}, undefined, undefined, {
            profileDirectory: profile,
            initialToolCalls: [
              { sessionUpdate: "tool_call", ...cmd1, status: "in_progress" },
              { sessionUpdate: "tool_call", ...cmd2, status: "in_progress" },
            ],
          });
        yield* startTurn(1, false);
        yield* throughPromptSettled;

        // Command 1 finishes and wakes the model.
        yield* writeFile(
          generated("messages"),
          "msg-1.json",
          JSON.stringify({
            id: "msg-1",
            priority: "MESSAGE_PRIORITY_HIGH",
            sender: "mock-session-1/task-1",
          }),
        );
        yield* writeFile(generated("messages"), "read.json", JSON.stringify({ "msg-1": true }));
        yield* writeFile(
          generated("logs"),
          "transcript.jsonl",
          `${JSON.stringify({ step_index: 1, type: "SYSTEM_MESSAGE", status: "DONE", content: "priority=MESSAGE_PRIORITY_HIGH task-1" })}\n`,
        );
        yield* send({
          sessionUpdate: "tool_call_update",
          ...cmd1,
          status: "completed",
          rawOutput: { output: "ok larastan", exit_code: 0 },
        });

        // 500 ms later, command 2 also finishes while reply 1 is still in flight.
        yield* TestClock.adjust("500 millis");
        yield* writeFile(
          generated("messages"),
          "msg-2.json",
          JSON.stringify({
            id: "msg-2",
            priority: "MESSAGE_PRIORITY_HIGH",
            sender: "mock-session-1/task-2",
          }),
        );
        yield* send({
          sessionUpdate: "tool_call_update",
          ...cmd2,
          status: "completed",
          rawOutput: { output: "34 passed", exit_code: 0 },
        });
        assert.equal((yield* Queue.takeAll(scheduledFinalizes)).at(-1), "2 minutes");

        // Reply 1 streams and ends with usage_update #1.
        yield* TestClock.adjust("8 seconds");
        yield* send({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: batched ? "gates and tests both passed." : "gates passed; waiting for tests.",
          },
        });
        assert.equal((yield* Queue.takeAll(scheduledFinalizes)).at(-1), "2 minutes");
        yield* writeFile(
          generated("messages"),
          "read.json",
          JSON.stringify({ "msg-1": true, "msg-2": true }),
        );
        yield* writeFile(
          generated("logs"),
          "transcript.jsonl",
          (batched
            ? [
                JSON.stringify({
                  step_index: 1,
                  type: "SYSTEM_MESSAGE",
                  status: "DONE",
                  content: "priority=MESSAGE_PRIORITY_HIGH task-1 + task-2",
                }),
                JSON.stringify({
                  step_index: 2,
                  type: "PLANNER_RESPONSE",
                  status: "DONE",
                  content: "gates and tests both passed.",
                }),
              ]
            : [
                JSON.stringify({
                  step_index: 1,
                  type: "SYSTEM_MESSAGE",
                  status: "DONE",
                  content: "priority=MESSAGE_PRIORITY_HIGH task-1",
                }),
                JSON.stringify({
                  step_index: 2,
                  type: "PLANNER_RESPONSE",
                  status: "DONE",
                  content: "gates passed; waiting for tests.",
                }),
                JSON.stringify({
                  step_index: 3,
                  type: "SYSTEM_MESSAGE",
                  status: "DONE",
                  content: "priority=MESSAGE_PRIORITY_HIGH task-2",
                }),
              ]
          ).join("\n") + "\n",
        );
        yield* send(usage);
        assert.equal(yield* Queue.take(scheduledFinalizes), "3000 millis");

        // Advance past the 3-second debounce.
        yield* TestClock.adjust("3 seconds");
        if (batched) {
          const run = yield* until((event) => event.type === "turn.terminal");
          const terminal = run.at(-1);
          assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
          assert.include(JSON.stringify(run), "gates and tests both passed.");
          assert.lengthOf(offers, 0);
          return;
        }

        // Pending wake for command 2 must extend into the 2-minute quiet window before finalizing.
        assert.equal(yield* Queue.take(scheduledFinalizes), "2 minutes");
        if (stalls) {
          yield* TestClock.adjust("2 minutes");
          const run = yield* until((event) => event.type === "turn.terminal");
          const terminal = run.at(-1);
          assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
          assert.lengthOf(offers, 0);
          return;
        }

        // Reply 2 arrives 6 seconds later (9 seconds after usage_update #1).
        yield* TestClock.adjust("6 seconds");
        yield* send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "All 34 tests passed." },
        });
        assert.equal((yield* Queue.takeAll(scheduledFinalizes)).at(-1), "2 minutes");
        yield* writeFile(
          generated("logs"),
          "transcript.jsonl",
          [
            JSON.stringify({
              step_index: 1,
              type: "SYSTEM_MESSAGE",
              status: "DONE",
              content: "priority=MESSAGE_PRIORITY_HIGH task-1",
            }),
            JSON.stringify({
              step_index: 2,
              type: "PLANNER_RESPONSE",
              status: "DONE",
              content: "gates passed; waiting for tests.",
            }),
            JSON.stringify({
              step_index: 3,
              type: "SYSTEM_MESSAGE",
              status: "DONE",
              content: "priority=MESSAGE_PRIORITY_HIGH task-2",
            }),
            JSON.stringify({
              step_index: 4,
              type: "PLANNER_RESPONSE",
              status: "DONE",
              content: "All 34 tests passed.",
            }),
          ].join("\n") + "\n",
        );
        yield* send(usage);
        assert.equal(yield* Queue.take(scheduledFinalizes), "3000 millis");
        yield* TestClock.adjust("3 seconds");

        const run = yield* until((event) => event.type === "turn.terminal");
        const terminal = run.at(-1);
        assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
        assert.include(
          JSON.stringify(run),
          "All 34 tests passed.",
          "reply 2 must stay in the same run",
        );
        assert.lengthOf(offers, 0, "the open run needs no continuation");
      }).pipe(Effect.provide(layerSession)),
  );

  // A background command can finish while the initial prompt's final reply is still in flight,
  // so the tool is already `completed` when session/prompt returns end_turn while its wake sits
  // unread in the inbox.
  it.effect(
    "keeps the run open when a background command finishes before end_turn with an unread wake",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profile = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agy-pre-settle-" });
        const generated = (kind: string) =>
          path.join(
            profile,
            "antigravity-acp",
            "brain",
            "mock-session-1",
            ".system_generated",
            kind,
          );
        const writeFile = (directory: string, name: string, body: string) =>
          fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(Effect.andThen(fileSystem.writeFileString(path.join(directory, name), body)));
        const cmd = {
          toolCallId: "call_mix",
          kind: "execute",
          title: "python3 voice.py mix",
          rawInput: { CommandLine: "python3 voice.py mix", WaitMsBeforeAsync: 10000 },
        } as const;
        yield* writeFile(
          generated("messages"),
          "msg-1.json",
          JSON.stringify({
            id: "msg-1",
            priority: "MESSAGE_PRIORITY_HIGH",
            sender: "mock-session-1/task-1",
          }),
        );
        const { usage, offers, scheduledFinalizes, send, startTurn, until, throughPromptSettled } =
          yield* openSessionWithRunningCommand({}, undefined, undefined, {
            profileDirectory: profile,
            initialToolCalls: [
              { sessionUpdate: "tool_call", ...cmd, status: "in_progress" },
              {
                sessionUpdate: "tool_call_update",
                ...cmd,
                status: "completed",
                rawOutput: { output: "mixed.mp4", exit_code: 0 },
              },
            ],
          });
        yield* startTurn(1, false);
        yield* throughPromptSettled;
        assert.equal(yield* Queue.take(scheduledFinalizes), "2 minutes");

        yield* TestClock.adjust("9 seconds");
        yield* send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Mix finished." },
        });
        assert.equal(yield* Queue.take(scheduledFinalizes), "2 minutes");
        yield* writeFile(generated("messages"), "read.json", JSON.stringify({ "msg-1": true }));
        yield* writeFile(
          generated("logs"),
          "transcript.jsonl",
          `${JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", content: "Mix finished." })}\n`,
        );
        yield* send(usage);
        assert.equal(yield* Queue.take(scheduledFinalizes), "3000 millis");
        yield* TestClock.adjust("3 seconds");

        const run = yield* until((event) => event.type === "turn.terminal");
        const terminal = run.at(-1);
        assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
        assert.include(JSON.stringify(run), "Mix finished.");
        assert.lengthOf(offers, 0);
      }).pipe(Effect.provide(layerSession)),
  );

  // agy names its background commands `<session>/task-<n>`; the agent passes that to
  // t3_background_wait, which must not fail since the adapter already holds the run open.
  it.effect("accepts t3_background_wait for a command it already tracks", () =>
    Effect.gen(function* () {
      const { session, providerThread, startTurn, throughPromptSettled } =
        yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
      yield* startTurn(1, false);
      yield* throughPromptSettled;
      const taskIds = ["mock-session-1/task-2"];
      assert.isDefined(session.awaitBackgroundTasks, "t3_background_wait must not be unsupported");
      const result = yield* session.awaitBackgroundTasks!({
        providerThread,
        taskIds,
        awaited: true,
      });
      assert.deepEqual(result.matched, taskIds);
    }).pipe(Effect.provide(layerSession)),
  );

  // agy 1.5.11 reads a prompt sent mid-turn as a steer: it answers the running prompt end_turn
  // and goes on under the new one. session/cancel would end its running commands and subagents.
  it.effect("steers a running prompt with the next one and leaves its work running", () =>
    Effect.gen(function* () {
      const opened = yield* openSessionWithRunningCommand({}, undefined, {
        agentVersion: "1.5.11",
        holdsFirstPrompt: true,
      });
      const { session, providerThread, command, usage, send, startTurn, until } = opened;
      assert.isTrue(session.providerSession.capabilities.turns.supportsActiveSteering);
      yield* startTurn(1, false);
      const started = yield* until(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === command.toolCallId,
      );
      const providerTurnId = started.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
      )[0]!;
      yield* send({
        sessionUpdate: "tool_call",
        toolCallId: "call_artist",
        kind: "other",
        title: "Run invoke_subagent",
        status: "completed",
        rawInput: { Role: "Artist", Prompt: "Paint the scooter" },
      });

      yield* session.steerTurn({
        threadId: ThreadId.make("thread-antigravity-wake"),
        runId: RunId.make("run-antigravity-wake-1"),
        providerThread,
        providerTurnId,
        message: {
          messageId: MessageId.make("message-antigravity-steer"),
          text: "Use opus subagents from now on",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      assert.equal(opened.cancels(), 0, "a steer must not cancel the agent's work");
      assert.lengthOf(opened.prompts, 2);
      assert.deepEqual(opened.prompts[1]!.prompt, [
        { type: "text", text: "Use opus subagents from now on" },
      ]);
      assert.isTrue(
        yield* Deferred.isDone(opened.prompts[0]!.released!),
        "the steered prompt frees the runtime for the steer",
      );
      // The steered prompt has answered end_turn; the turn must outlast the finalize debounce.
      yield* TestClock.adjust("10 seconds");

      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Switching to opus subagents." },
      });
      yield* send(usage);
      yield* opened.releaseSteer;
      const run = [...started, ...(yield* until((event) => event.type === "turn.terminal"))];
      const terminal = run.at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
      assert.include(JSON.stringify(run), "Switching to opus subagents.");
      const finished = run.findLast(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === command.toolCallId,
      );
      assert.equal(finished?.type === "turn_item.updated" && finished.turnItem.status, "completed");
      const subagentStatuses = run.flatMap((event) =>
        event.type === "subagent.updated" ? [event.subagent.status] : [],
      );
      assert.notInclude(subagentStatuses, "interrupted");
      assert.equal(subagentStatuses.at(-1), "idle");
    }).pipe(Effect.provide(layerSession)),
  );

  // A wake run has no prompt of its own, yet agy can keep working in it for minutes.
  it.effect("steers a continuation run that keeps working after its wake", () =>
    Effect.gen(function* () {
      const opened = yield* openSessionWithRunningCommand(
        { IsDaemon: true, WaitMsBeforeAsync: 500 },
        undefined,
        { agentVersion: "1.5.11", holdsFirstPrompt: false },
      );
      const { session, providerThread, command, offers, send, startTurn, until, throughTerminal } =
        opened;
      yield* startTurn(1, false);
      yield* throughTerminal;
      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      assert.lengthOf(offers, 1, "the finished daemon must wake the thread");
      yield* offers[0]!.dispatchIfCurrent!(Effect.void);
      yield* startTurn(2, true);
      const followUp = { toolCallId: "call_build", kind: "execute", title: "vp run build" };
      yield* send({ sessionUpdate: "tool_call", ...followUp, status: "in_progress" });
      const continued = yield* until(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === followUp.toolCallId,
      );
      const providerTurnId = continued.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
      )[0]!;

      const steer = yield* session
        .steerTurn({
          threadId: ThreadId.make("thread-antigravity-wake"),
          runId: RunId.make("run-antigravity-wake-2"),
          providerThread,
          providerTurnId,
          message: {
            messageId: MessageId.make("message-antigravity-steer"),
            text: "Skip the build",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        })
        .pipe(Effect.exit);
      assert.isTrue(
        Exit.isSuccess(steer),
        `a working wake run must accept a steer: ${String(Exit.isFailure(steer) && steer.cause)}`,
      );
      assert.equal(opened.cancels(), 0, "a steer must not cancel the agent's work");
      assert.lengthOf(opened.prompts, 2);
      assert.deepEqual(opened.prompts[1]!.prompt, [{ type: "text", text: "Skip the build" }]);

      yield* send({ sessionUpdate: "tool_call_update", ...followUp, status: "completed" });
      yield* TestClock.adjust("16 minutes");
      const silent = yield* until((event) => event.type === "turn.terminal");
      const terminal = silent.at(-1);
      assert.equal(
        terminal?.type === "turn.terminal" && terminal.status,
        "failed",
        "a silent steer prompt must still hit the inactivity timeout",
      );
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect("steers a run held open by a detached subagent without stopping it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profile = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-kids-" });
      const records = (conversationId: string, kind: string) =>
        path.join(profile, "antigravity-acp", "brain", conversationId, ".system_generated", kind);
      const write = (directory: string, name: string, value: unknown) =>
        fileSystem
          .makeDirectory(directory, { recursive: true })
          .pipe(
            Effect.andThen(
              fileSystem.writeFileString(path.join(directory, name), JSON.stringify(value)),
            ),
          );
      yield* write(records("mock-session-1", "subagents"), "child-1.json", {});
      yield* write(records("child-1", "messages"), "launch.json", {
        sender: "mock-session-1",
        sourceMetadata: { tool: { toolCall: { id: "call_research", name: "invoke_subagent" } } },
      });
      const opened = yield* openSessionWithRunningCommand({}, profile, {
        agentVersion: "1.5.11",
        holdsFirstPrompt: false,
      });
      const { session, providerThread, usage, send, startTurn, until, throughPromptSettled } =
        opened;
      yield* startTurn(1, false);
      const prompt = yield* throughPromptSettled;
      const providerTurnId = prompt.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
      )[0]!;
      yield* TestClock.adjust("10 minutes");

      yield* session.steerTurn({
        threadId: ThreadId.make("thread-antigravity-wake"),
        runId: RunId.make("run-antigravity-wake-1"),
        providerThread,
        providerTurnId,
        message: {
          messageId: MessageId.make("message-antigravity-steer"),
          text: "Also check the footnotes",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      assert.equal(opened.cancels(), 0, "a steer must not cancel the agent's subagents");
      assert.lengthOf(opened.prompts, 2);
      yield* write(records("mock-session-1", "messages"), "report.json", { sender: "child-1" });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "I'll have the footnotes checked too." },
      });
      yield* send(usage);
      yield* opened.releaseSteer;
      const run = [...prompt, ...(yield* until((event) => event.type === "turn.terminal"))];
      const terminal = run.at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
      assert.include(JSON.stringify(run), "I'll have the footnotes checked too.");
      const subagentStatuses = run.flatMap((event) =>
        event.type === "subagent.updated" ? [event.subagent.status] : [],
      );
      assert.notInclude(subagentStatuses, "interrupted");
      assert.equal(subagentStatuses.at(-1), "idle");
    }).pipe(Effect.provide(layerSession)),
  );

  // Files as agy 1.5.12 wrote them: the launch sits in the child's inbox, and the child's report
  // lands in the parent's inbox with no session update. Only the agent's own reply follows.
  it.effect.each([
    { reports: "after the prompt ends", duringPrompt: false },
    { reports: "while the prompt runs", duringPrompt: true },
  ])("keeps a detached subagent running until it reports $reports", ({ duringPrompt }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profile = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-kids-" });
      const records = (conversationId: string, kind: string) =>
        path.join(profile, "antigravity-acp", "brain", conversationId, ".system_generated", kind);
      const write = (directory: string, name: string, value: unknown) =>
        fileSystem
          .makeDirectory(directory, { recursive: true })
          .pipe(
            Effect.andThen(
              fileSystem.writeFileString(path.join(directory, name), JSON.stringify(value)),
            ),
          );
      yield* write(records("mock-session-1", "subagents"), "child-1.json", {});
      yield* write(records("child-1", "messages"), "launch.json", {
        sender: "mock-session-1",
        sourceMetadata: { tool: { toolCall: { id: "call_research", name: "invoke_subagent" } } },
      });
      const report = write(records("mock-session-1", "messages"), "report.json", {
        sender: "child-1",
      });
      if (duringPrompt) yield* report;

      const { usage, offers, send, startTurn, until, throughPromptSettled } =
        yield* openSessionWithRunningCommand({}, profile);
      yield* startTurn(1, false);
      const statuses = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
        events.flatMap((event) =>
          event.type === "subagent.updated" ? [event.subagent.status] : [],
        );
      const prompt = yield* throughPromptSettled;
      assert.equal(statuses(prompt).at(-1), duringPrompt ? "idle" : "running");
      if (!duringPrompt) {
        yield* TestClock.adjust("10 minutes");
        yield* report;
        yield* send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "The researcher found it." },
        });
        yield* send(usage);
        yield* TestClock.adjust("3 seconds");
      }
      const run = yield* until((event) => event.type === "turn.terminal");
      const terminal = run.at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
      assert.equal(statuses([...prompt, ...run]).at(-1), "idle");
      assert.equal(
        JSON.stringify(run).includes("The researcher found it."),
        !duringPrompt,
        "the reply about the report is part of the run",
      );
      assert.lengthOf(offers, 0, "the open run needs no continuation");
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect(
    "projects Antigravity subagent transcript thinking, typed tools, and assistant reply live and keeps them when Idle",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profile = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-antigravity-subagent-live-",
        });
        const records = (conversationId: string, kind: string) =>
          path.join(profile, "antigravity-acp", "brain", conversationId, ".system_generated", kind);
        const writeJson = (directory: string, name: string, value: unknown) =>
          fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(
              Effect.andThen(
                fileSystem.writeFileString(path.join(directory, name), JSON.stringify(value)),
              ),
            );
        const writeTranscript = (lines: ReadonlyArray<unknown>) => {
          const directory = records("child-1", "logs");
          return fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(
              Effect.andThen(
                fileSystem.writeFileString(
                  path.join(directory, "transcript.jsonl"),
                  `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
                ),
              ),
            );
        };

        yield* writeJson(records("mock-session-1", "subagents"), "child-1.json", {
          conversationId: "child-1",
          subagentDescriptor: { role: "Codebase Researcher" },
        });
        yield* writeJson(records("child-1", "messages"), "launch.json", {
          sender: "mock-session-1",
          content: "Read README.md",
          sourceMetadata: {
            tool: { toolCall: { id: "call_research", name: "invoke_subagent" } },
          },
        });
        // While running, the child has written thinking, a completed read_file, an edit_file, and a running command.
        yield* writeTranscript([
          { step_index: 0, type: "SYSTEM_MESSAGE", status: "DONE", content: "Read README.md" },
          {
            step_index: 1,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            thinking: "Checking README.md and applying the fix.",
            tool_calls: [
              { name: "read_file", args: { Path: '"/project/README.md"' } },
              {
                name: "edit_file",
                args: {
                  Path: '"/project/README.md"',
                  Target: '"old"',
                  Replacement: '"new"',
                },
              },
              {
                name: "run_command",
                args: { CommandLine: '"pnpm test"', toolSummary: '"Run tests"' },
              },
            ],
          },
          {
            step_index: 2,
            type: "GENERIC",
            status: "DONE",
            content: "Created At: 2026-11-26T02:00:00+01:00\n1: old line",
          },
          {
            step_index: 3,
            type: "GENERIC",
            status: "DONE",
            content: "Updated README.md",
          },
        ]);

        const { usage, send, startTurn, until, throughPromptSettled } =
          yield* openSessionWithRunningCommand({}, profile);
        yield* startTurn(1, false);
        const promptEvents = yield* throughPromptSettled;

        const childThread = promptEvents.find((event) => event.type === "app_thread.created");
        assert.isDefined(childThread);
        const childThreadId =
          childThread?.type === "app_thread.created" ? childThread.appThread.id : undefined;
        assert.isDefined(childThreadId);

        // Give the live transcript follower a poll tick while the subagent is still running.
        yield* TestClock.adjust("1 second");

        // Now the child completes its command, writes its final assistant reply, and reports back to parent.
        yield* writeTranscript([
          { step_index: 0, type: "SYSTEM_MESSAGE", status: "DONE", content: "Read README.md" },
          {
            step_index: 1,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            thinking: "Checking README.md and applying the fix.",
            tool_calls: [
              { name: "read_file", args: { Path: '"/project/README.md"' } },
              {
                name: "edit_file",
                args: {
                  Path: '"/project/README.md"',
                  Target: '"old"',
                  Replacement: '"new"',
                },
              },
              {
                name: "run_command",
                args: { CommandLine: '"pnpm test"', toolSummary: '"Run tests"' },
              },
            ],
          },
          {
            step_index: 2,
            type: "GENERIC",
            status: "DONE",
            content: "Created At: 2026-11-26T02:00:00+01:00\n1: old line",
          },
          {
            step_index: 3,
            type: "GENERIC",
            status: "DONE",
            content: "Updated README.md",
          },
          {
            step_index: 4,
            type: "GENERIC",
            status: "DONE",
            content: "All tests passed.",
          },
          {
            step_index: 5,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            content: "Updated README.md and verified all tests pass.",
          },
        ]);
        yield* writeJson(records("mock-session-1", "messages"), "report.json", {
          sender: "child-1",
        });
        yield* send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "The researcher finished." },
        });
        yield* send(usage);
        yield* TestClock.adjust("3 seconds");
        const tailEvents = yield* until((event) => event.type === "turn.terminal");
        const allEvents = [...promptEvents, ...tailEvents];

        const childItemsById = new Map<
          string,
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn_item.updated" }>["turnItem"]
        >();
        for (const event of allEvents) {
          if (event.type === "turn_item.updated" && event.turnItem.threadId === childThreadId) {
            childItemsById.set(String(event.turnItem.id), event.turnItem);
          }
        }
        const childItems = [...childItemsById.values()].toSorted((a, b) => a.ordinal - b.ordinal);
        assert.deepEqual(
          childItems.map((item) => item.type),
          [
            "user_message",
            "reasoning",
            "dynamic_tool",
            "file_change",
            "command_execution",
            "assistant_message",
          ],
        );
        const reasoning = childItems[1];
        assert.equal(
          reasoning?.type === "reasoning" ? reasoning.text : null,
          "Checking README.md and applying the fix.",
        );
        const readItem = childItems[2];
        assert.equal(readItem?.type === "dynamic_tool" ? readItem.toolName : null, "Read");
        assert.equal(readItem?.type === "dynamic_tool" ? readItem.output : null, "1: old line");
        const fileChange = childItems[3];
        assert.equal(
          fileChange?.type === "file_change" ? fileChange.fileName : null,
          "/project/README.md",
        );
        assert.include(
          fileChange?.type === "file_change" ? (fileChange.diffStr ?? "") : "",
          "-old",
        );
        assert.include(
          fileChange?.type === "file_change" ? (fileChange.diffStr ?? "") : "",
          "+new",
        );
        const command = childItems[4];
        assert.equal(command?.type === "command_execution" ? command.input : null, "pnpm test");
        assert.equal(
          command?.type === "command_execution" ? command.output : null,
          "All tests passed.",
        );
        assert.equal(command?.status, "completed");
        const assistant = childItems[5];
        assert.equal(
          assistant?.type === "assistant_message" ? assistant.text : null,
          "Updated README.md and verified all tests pass.",
        );

        const lastSubagent = allEvents.findLast((event) => event.type === "subagent.updated");
        assert.equal(
          lastSubagent?.type === "subagent.updated" ? lastSubagent.subagent.status : null,
          "idle",
        );
        assert.equal(
          lastSubagent?.type === "subagent.updated" ? lastSubagent.subagent.result : null,
          "Updated README.md and verified all tests pass.",
        );
      }).pipe(Effect.provide(layerSession)),
  );

  it.effect(
    "captures a subagent's closing assistant reply written shortly after send_message marks it Idle",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profile = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-antigravity-subagent-trailing-",
        });
        const records = (conversationId: string, kind: string) =>
          path.join(profile, "antigravity-acp", "brain", conversationId, ".system_generated", kind);
        const writeJson = (directory: string, name: string, value: unknown) =>
          fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(
              Effect.andThen(
                fileSystem.writeFileString(path.join(directory, name), JSON.stringify(value)),
              ),
            );
        const writeTranscript = (lines: ReadonlyArray<unknown>) => {
          const directory = records("child-1", "logs");
          return fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(
              Effect.andThen(
                fileSystem.writeFileString(
                  path.join(directory, "transcript.jsonl"),
                  `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
                ),
              ),
            );
        };

        yield* writeJson(records("mock-session-1", "subagents"), "child-1.json", {
          conversationId: "child-1",
          subagentDescriptor: { role: "Rich Format Tester" },
        });
        yield* writeJson(records("child-1", "messages"), "launch.json", {
          sender: "mock-session-1",
          content: "Format a markdown summary",
          sourceMetadata: {
            tool: { toolCall: { id: "call_research", name: "invoke_subagent" } },
          },
        });
        const preReplySteps = [
          {
            step_index: 0,
            type: "SYSTEM_MESSAGE",
            status: "DONE",
            content: "Format a markdown summary",
          },
          {
            step_index: 1,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            tool_calls: [{ name: "send_message", args: { Message: '"Done!"' } }],
          },
          { step_index: 2, type: "GENERIC", status: "DONE", content: "Message sent." },
        ];
        yield* writeTranscript(preReplySteps);
        yield* writeJson(records("mock-session-1", "messages"), "report.json", {
          sender: "child-1",
        });

        const { startTurn, until, throughPromptSettled, session, providerThread } =
          yield* openSessionWithRunningCommand({}, profile);
        const runKeepsIngesting = session.hasPendingBackgroundWorkForThread!(providerThread);
        yield* startTurn(1, false);
        const promptEvents = yield* throughPromptSettled;
        const childThread = promptEvents.find((event) => event.type === "app_thread.created");
        const childThreadId =
          childThread?.type === "app_thread.created" ? childThread.appThread.id : undefined;
        assert.isDefined(childThreadId);

        // Child became Idle as soon as report.json landed, before its closing PLANNER_RESPONSE flushed.
        const idleSubagent = promptEvents.findLast((event) => event.type === "subagent.updated");
        assert.equal(
          idleSubagent?.type === "subagent.updated" ? idleSubagent.subagent.status : null,
          "idle",
        );
        // The run reads this probe once the root ends; it must already hold the drain at Idle.
        assert.isTrue(yield* runKeepsIngesting);

        // Closing reply lands in transcript.jsonl after Idle.
        yield* writeTranscript([
          ...preReplySteps,
          {
            step_index: 3,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            content: "## Summary\n\n| Check | Status |\n| --- | --- |\n| Diff | Passed |",
          },
        ]);
        yield* TestClock.adjust("2 seconds");
        const trailingEvents = yield* until(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.threadId === childThreadId &&
            event.turnItem.type === "assistant_message",
        );
        const assistantItem = trailingEvents.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.threadId === childThreadId &&
            event.turnItem.type === "assistant_message",
        );
        assert.equal(
          assistantItem?.type === "turn_item.updated" &&
            assistantItem.turnItem.type === "assistant_message"
            ? assistantItem.turnItem.text
            : null,
          "## Summary\n\n| Check | Status |\n| --- | --- |\n| Diff | Passed |",
        );
        // The drain ends with a subagent event, so the run re-checks and stops ingesting.
        let pending = true;
        for (let attempt = 0; attempt < 2 && pending; attempt += 1) {
          yield* until((event) => event.type === "subagent.updated");
          pending = yield* runKeepsIngesting;
        }
        assert.isFalse(pending);
      }).pipe(Effect.provide(layerSession)),
  );

  it.effect("ends a continuation run whose replayed reply launched a subagent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      // No records: nothing proves a child is at work, so none may hold a run open.
      const profile = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-kids-" });
      const { usage, offers, send, startTurn, throughTerminal } =
        yield* openSessionWithRunningCommand({}, profile);
      yield* startTurn(1, false);
      yield* throughTerminal;
      yield* send({
        sessionUpdate: "tool_call",
        toolCallId: "call_follow_up",
        kind: "other",
        title: "Run invoke_subagent",
        status: "completed",
        rawInput: { TypeName: "research", Role: "Checker", Prompt: "Check it" },
      });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Started a checker." },
      });
      yield* send(usage);
      assert.lengthOf(offers, 1, "the agent's own reply must wake the thread");
      yield* offers[0]!.dispatchIfCurrent!(Effect.void);
      yield* startTurn(2, true);
      yield* TestClock.adjust("3 seconds");
      const terminal = (yield* throughTerminal).at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect.each([
    // session/cancel ends the agent's commands, so only Stop may send it.
    { ending: "Stop", cancels: 1, status: "interrupted" },
    { ending: "a new message", cancels: 0, status: "interrupted" },
    { ending: "the agent exiting", cancels: 0, status: "failed" },
  ] as const)(
    "ends a run held open by a running command on $ending",
    ({ ending, cancels, status }) =>
      Effect.gen(function* () {
        const opened = yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
        yield* opened.startTurn(1, false);
        const started = yield* opened.throughPromptSettled;
        const turn = started.find((event) => event.type === "provider_turn.updated");
        if (turn?.type !== "provider_turn.updated") return assert.fail("the turn must start");
        if (ending === "the agent exiting") {
          yield* opened.runtimeDies;
        } else {
          yield* opened.session.interruptTurn({
            providerThread: opened.providerThread,
            providerTurnId: turn.providerTurn.id,
            ...(ending === "Stop" ? { requestRuntimeRestart: true } : {}),
          });
        }
        const terminal = (yield* opened.throughTerminal).at(-1);
        assert.equal(terminal?.type === "turn.terminal" && terminal.status, status);
        assert.equal(opened.cancels(), cancels);
      }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 subagent reads", () => {
  it.effect("completes a read T3 served when the agent later fails it with a step error", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-reads-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-reads-outside-",
      });
      const served = path.join(workspace, "served.ts");
      yield* fileSystem.writeFileString(served, "export {};");
      const denied = path.join(outside, "secret.txt");
      yield* fileSystem.writeFileString(denied, "secret");
      const unseen = path.join(workspace, "unseen.ts");
      const retried = path.join(workspace, "retried.ts");
      const stepError = 'Model produced invalid output. ("model output error")';
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-subagent-reads-test");
      const threadId = ThreadId.make("thread-antigravity-subagent-reads");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdate = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              handleReadTextFile: (handler) =>
                Effect.sync(() => {
                  readTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
              // agy_acp_server announces a subagent's client_view_file on the parent session,
              // never completes it, then fails every open call with the next step error.
              prompt: () =>
                Effect.gen(function* () {
                  if (sessionUpdate === undefined || readTextFile === undefined) {
                    return yield* Effect.die("the adapter must handle updates and reads");
                  }
                  const send = sessionUpdate;
                  const handleRead = readTextFile;
                  const update = (update: EffectAcpSchema.SessionUpdate) =>
                    send(
                      normalizeAntigravitySessionUpdate({ sessionId: "mock-session-1", update }),
                    );
                  // The agent's own view_file never reaches T3, so it must not take a served read.
                  const reads = [
                    ["call_native", served, "Running view_file"],
                    ["call_served", served, "Running client_view_file"],
                    ["call_missing", retried, "Running client_view_file"],
                    ["call_retried", retried, "Running client_view_file"],
                    ["call_denied", denied, "Running client_view_file"],
                    ["call_unseen", unseen, "Running client_view_file"],
                  ] as const;
                  for (const [toolCallId, target, title] of reads) {
                    yield* update({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title,
                      kind: "read",
                      status: "in_progress",
                      rawInput: { absolute_path: target },
                      locations: [{ path: target }],
                    });
                  }
                  const serve = (target: string) =>
                    handleRead(
                      { sessionId: "subagent-conversation", path: target },
                      { requestId: `read-${target}`, method: "fs/read_text_file" },
                    ).pipe(Effect.exit);
                  yield* serve(served);
                  yield* serve(retried);
                  yield* fileSystem.writeFileString(retried, "export {};").pipe(Effect.orDie);
                  yield* serve(retried);
                  yield* serve(denied);
                  for (const [toolCallId] of reads) {
                    yield* update({
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status: "failed",
                      rawOutput: stepError,
                    });
                  }
                  return { stopReason: "end_turn" as const };
                }),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-subagent-reads"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* session.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project-antigravity-subagent-reads"),
          title: "Antigravity subagent reads",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: workspace,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make("run-antigravity-subagent-reads"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-antigravity-subagent-reads"),
        rootNodeId: NodeId.make("node-antigravity-subagent-reads"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-antigravity-subagent-reads"),
          text: "review the codebase",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      const events = Array.from(
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const read = (nativeId: string) => {
        const event = events.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId,
        );
        return event?.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
          ? { status: event.turnItem.status, output: event.turnItem.output }
          : undefined;
      };

      const firstEvent = (nativeId: string, status: string) =>
        events.findIndex(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId &&
            event.turnItem.status === status,
        );
      // T3 completes a served read itself instead of leaving it running until the flush.
      assert.isAbove(firstEvent("call_served", "completed"), -1);
      assert.isBelow(firstEvent("call_served", "completed"), firstEvent("call_native", "failed"));
      const failed = { status: "failed" as const, output: stepError };
      assert.deepEqual(read("call_served"), { status: "completed", output: undefined });
      assert.deepEqual(read("call_retried"), { status: "completed", output: undefined });
      assert.deepEqual(read("call_native"), failed);
      assert.deepEqual(read("call_missing"), failed);
      assert.deepEqual(read("call_denied"), failed);
      assert.deepEqual(read("call_unseen"), failed);
    }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 runtime mode ceiling", () => {
  const modesSetFor = (
    pickedMode: string,
    modes: Pick<ProviderAdapter.ProviderAdapterV2RuntimePolicy, "runtimeMode" | "maxRuntimeMode">,
  ) =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const modesSet: Array<string> = [];
      const instanceId = ProviderInstanceId.make("antigravity-ceiling-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              setMode: (modeId) =>
                Effect.sync(() => {
                  modesSet.push(modeId);
                }).pipe(Effect.andThen(runtime.setMode(modeId))),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const threadId = ThreadId.make("thread-antigravity-ceiling");
      yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-ceiling"),
        modelSelection: {
          instanceId,
          model: "gemini-test-low",
          options: [{ id: "_t3/session-mode", value: pickedMode }],
        },
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          ...modes,
          interactionMode: "default",
          cwd: process.cwd(),
        }),
      });
      return modesSet;
    }).pipe(Effect.provide(layerSession), Effect.scoped);

  it.effect("does not apply a picked session mode above the thread's runtime mode", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* modesSetFor("yolo", { runtimeMode: "approval-required" }), [
        "default",
      ]);
      assert.deepEqual(
        yield* modesSetFor("auto_edit", {
          runtimeMode: "approval-required",
          maxRuntimeMode: "auto-accept-edits",
        }),
        ["default"],
      );
      // A narrower mode is still the user's to pick.
      assert.deepEqual(yield* modesSetFor("default", { runtimeMode: "auto-accept-edits" }), [
        "auto_edit",
        "default",
      ]);
    }),
  );

  it.effect("leaving Plan keeps the permission mode the thread has now", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      let runtime: AcpSessionRuntime.AcpSessionRuntime["Service"] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-plan-exit-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.tap((made) =>
              Effect.sync(() => {
                runtime = made;
              }),
            ),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const threadId = ThreadId.make("thread-antigravity-plan-exit");
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const planPolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "plan",
        cwd: process.cwd(),
      });
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-plan-exit"),
        modelSelection,
        runtimePolicy: planPolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* session.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: planPolicy,
      });
      const supervisedPolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      yield* session.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy: supervisedPolicy,
          modelSelection,
          now: yield* DateTime.now,
        }),
      );
      yield* Stream.fromQueue(events).pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.equal((yield* runtime!.getModeState)?.currentModeId, "default");
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 session system prompt", () => {
  it.effect.each(["1.5.1"])(
    "carries PR linking once per turn on %s, which does not advertise a system prompt append",
    (agentVersion) =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* SecureRandom.SecureRandom;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const logs = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-log-" });
        const requestLog = path.join(logs, "requests.ndjson");
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        const promptReceived = yield* Deferred.make<Parameters<RuntimeService["prompt"]>[0]>();
        const instanceId = ProviderInstanceId.make("antigravity-system-prompt-test");
        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: {
                  T3_ACP_ANTIGRAVITY: "1",
                  T3_ACP_AGENT_VERSION: agentVersion,
                  T3_ACP_REQUEST_LOG_PATH: requestLog,
                  T3_ACP_HANG_PROMPT_FOREVER: "1",
                },
              },
            }).pipe(
              Effect.provideService(SecureRandom.SecureRandom, crypto),
              Effect.map((runtime): RuntimeService => ({
                ...runtime,
                prompt: (request) =>
                  Deferred.succeed(promptReceived, request).pipe(
                    Effect.andThen(runtime.prompt(request)),
                  ),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
        });
        const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-sp-" });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const threadId = ThreadId.make("thread-antigravity-system-prompt");
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-system-prompt"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* session
          .startTurn({
            appThread: {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId: ProjectId.make("project-antigravity-system-prompt"),
              title: "Antigravity system prompt",
              providerInstanceId: instanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: providerThread.id,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
            threadId,
            runId: RunId.make("run-antigravity-system-prompt"),
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId: RunAttemptId.make("attempt-antigravity-system-prompt"),
            rootNodeId: NodeId.make("node-antigravity-system-prompt"),
            providerThread,
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: MessageId.make("message-antigravity-system-prompt"),
              text: "open a PR",
              attachments: [],
            },
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.forkScoped);
        const sent = JSON.stringify((yield* Deferred.await(promptReceived)).prompt);
        const sessionNew = (yield* fileSystem.readFileString(requestLog))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { method?: string; params?: { _meta?: unknown } })
          .find((request) => request.method === "session/new");
        const append = JSON.stringify(sessionNew?.params?._meta ?? null);
        // Identity stays per turn either way.
        assert.include(sent, "through the Antigravity harness, as gemini-test-low");
        assert.notInclude(append, "systemPrompt");
        assert.include(sent, "<pull_request_linking>");
      }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 update_steps checklist", () => {
  it.effect("shows agy's update_steps calls as the thread's task list, not tool rows", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-update-steps-test");
      const threadId = ThreadId.make("thread-antigravity-update-steps");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdate = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              // agy 1.5.15/1.5.16 report the checklist only as tool calls, never as ACP `plan`.
              prompt: () =>
                Effect.gen(function* () {
                  const send = (update: EffectAcpSchema.SessionUpdate) =>
                    sessionUpdate === undefined
                      ? Effect.die("the adapter must handle session updates")
                      : sessionUpdate(
                          normalizeAntigravitySessionUpdate({
                            sessionId: "mock-session-1",
                            update,
                          }),
                        );
                  const calls = [
                    [
                      { title: "Create a.txt", status: "in_progress" },
                      { title: "Create b.txt", status: "pending" },
                    ],
                    [
                      { title: "Create a.txt", status: "done" },
                      { title: "Create b.txt", status: "in_progress" },
                    ],
                  ];
                  for (const [index, steps] of calls.entries()) {
                    const toolCallId = `update-steps-${index + 1}`;
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title: "Run update_steps",
                      kind: "other",
                      status: "in_progress",
                      rawInput: { steps },
                    });
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status: "completed",
                    });
                  }
                  return { stopReason: "end_turn" as const };
                }),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-update-steps"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* session.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project-antigravity-update-steps"),
          title: "Antigravity update_steps",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make("run-antigravity-update-steps"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-antigravity-update-steps"),
        rootNodeId: NodeId.make("node-antigravity-update-steps"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-antigravity-update-steps"),
          text: "create a.txt and b.txt",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      const events = Array.from(
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );

      const toolRows = events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
          ? [event.turnItem.toolName]
          : [],
      );
      assert.deepEqual(toolRows, []);
      const plans = events.flatMap((event) =>
        event.type === "plan.updated" && event.plan.kind === "todo_list"
          ? [event.plan.steps.map((step) => [step.text, step.status])]
          : [],
      );
      assert.deepEqual(plans.at(-1), [
        ["Create a.txt", "completed"],
        ["Create b.txt", "running"],
      ]);
    }).pipe(Effect.provide(layerSession)),
  );
});
