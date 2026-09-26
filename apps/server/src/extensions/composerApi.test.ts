import {
  AuthOrchestrationReadScope,
  ClientProvidersError,
  EnvironmentId,
  ExtensionOperationError,
  ProjectId,
  ThreadId,
  extensionWorkspaceRevision,
} from "@t3tools/contracts";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import type {
  ComposerCapabilities,
  MessagesEnrichmentCapabilities,
} from "@t3tools/extension-sdk/catalogue";
import type { HostApiProvider } from "@t3tools/extension-runtime";
import { it, expect } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/stream";
import type { ClientProviderServerFrame } from "@t3tools/contracts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ClientApiProviders, layer as clientApiProvidersLayer } from "./ClientApiProviders.ts";
import { createComposerApiProviders } from "./composerApi.ts";

const isOperationError = Schema.is(ExtensionOperationError);
const signal = new AbortController().signal;
const WORKSPACE = "/repo/workspace";

const makeContext = (threadId: string | null = "thread"): ViewContext => ({
  resource: {
    namespace: "test.extension",
    id: "surface",
    environmentId: "env",
    projectId: "project",
    ...(threadId === null ? {} : { threadId }),
  },
  client: "test",
  workspaceRevision: extensionWorkspaceRevision(WORKSPACE, null),
});

const noClient = new ClientProvidersError({
  code: "client-provider-unavailable",
  detail: "No connected client hosts this provider; the draft store is client-local.",
});
const resolverDeps: Parameters<typeof createComposerApiProviders>[0] = {
  environmentId: "env",
  projects: {
    getById: () =>
      Effect.succeedSome({
        projectId: ProjectId.make("project"),
        workspaceRoot: WORKSPACE,
        deletedAt: null,
      }),
  },
  threads: {
    getById: (input) =>
      Effect.succeed(
        input.threadId === ThreadId.make("thread")
          ? Option.some({
              projectId: ProjectId.make("project"),
              worktreePath: null,
              deletedAt: null,
            })
          : Option.none(),
      ),
  },
};
const providers = createComposerApiProviders(resolverDeps, {
  environmentId: "env",
  clientApiProviders: {
    connect: () => Effect.die("unused"),
    respond: () => Effect.die("unused"),
    emit: () => Effect.die("unused"),
    invoke: () => Effect.fail(noClient),
    openSubscription: () => Effect.fail(noClient),
    registerCorrelation: () => Effect.die("unused"),
    unregisterCorrelation: () => Effect.die("unused"),
    listTargets: () => Effect.succeed([]),
    resolveTarget: () => Effect.fail(noClient),
    hasProvider: () => Effect.succeed(false),
    connectionForSession: () => Effect.succeed(false),
  },
});
const composer = providers.find((p) => p.providerId === "host.composer")!;
const messages = providers.find((p) => p.providerId === "host.messages")!;

const meta = (provider: HostApiProvider): Parameters<HostApiProvider["invoke"]>[4] => ({
  callId: "call",
  rootCallerId: "root",
  callerId: "caller",
  providerId: provider.providerId,
  providerGeneration: 1,
  callerGenerations: [],
  principal: {
    kind: "environment-session",
    id: "session",
    environmentId: "env",
    scopes: [AuthOrchestrationReadScope],
  },
  assertAuthority: async () => {},
});

const call = (
  provider: HostApiProvider,
  method: string,
  input: Json,
  context = makeContext(),
): Promise<Json> =>
  Promise.resolve(provider.invoke(method, input, context, signal, meta(provider)));

/** A plugin-style principal bound to one live client connection, with a real caller generation. */
const sessionMeta = (provider: HostApiProvider, connectionId: string) => ({
  ...meta(provider),
  clientConnectionId: connectionId,
  callerGenerations: [{ pluginId: "ext.a", contentHash: "hash-a", installationGeneration: 1 }],
});

/** Same as `call`, but through the mixed-version session metadata. */
const dispatch = (
  provider: HostApiProvider,
  method: string,
  input: Json,
  connectionId: string,
): Promise<Json> =>
  Promise.resolve(
    provider.invoke(method, input, makeContext(), signal, sessionMeta(provider, connectionId)),
  );

const expectNamedError = async (pending: Promise<Json>, operation: string, detail: RegExp) => {
  const error = await pending.then(
    () => {
      throw new Error("expected failure");
    },
    (cause: unknown) => cause,
  );
  expect(isOperationError(error)).toBe(true);
  if (isOperationError(error)) {
    expect(error.operation).toBe(operation);
    expect(error.detail).toMatch(detail);
  }
};

// The mixed-version test drives the production broker: a real socket whose
// declared composer version is what dispatch gates on.
const brokerLayer = clientApiProvidersLayer.pipe(
  Layer.provide(
    Layer.succeed(ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
      getDescriptor: Effect.die("unused"),
    }),
  ),
);
const nextFrame = (iterator: AsyncIterator<ClientProviderServerFrame>) =>
  Effect.promise<ClientProviderServerFrame | undefined>(async () => {
    const next = await iterator.next();
    return next.done ? undefined : next.value;
  });
const frameIterator = (stream: Stream.Stream<ClientProviderServerFrame>) =>
  Stream.toAsyncIterableWith(stream, Context.empty())[Symbol.asyncIterator]();

it.effect("reports the transport gap honestly through getCapabilities", () =>
  Effect.promise(async () => {
    const composerCaps = (await call(composer, "getCapabilities", {})) as ComposerCapabilities;
    expect(composerCaps).toEqual({
      adapter: "host.composer",
      transport: "unavailable",
      detail: expect.stringContaining("client-local"),
      operations: {
        insertContext: false,
        getDraftState: false,
        insertMention: false,
        insertTerminalContext: false,
      },
    });
    const messageCaps = (await call(
      messages,
      "getCapabilities",
      {},
    )) as MessagesEnrichmentCapabilities;
    expect(messageCaps.adapter).toBe("host.messages");
    expect(messageCaps.transport).toBe("unavailable");
    expect(messageCaps.operations).toEqual({
      attachAnnotation: false,
      listAnnotations: false,
      removeAnnotation: false,
    });
  }),
);

it.effect("gates 1.1.0 shapes on the targeted connection while 1.0.0 ops keep flowing", () =>
  Effect.gen(function* () {
    const broker = yield* ClientApiProviders;
    // A real 1.0.0 registration the broker accepts through ^1.0.0, plus a
    // 1.1.0 sibling in the same environment: only the targeted connection's
    // version may unlock the new ops.
    const oldStream = yield* broker.connect(
      { connectionId: "conn-old", sessionId: "session", announcedOrigin: { surface: "web" } },
      { providers: [{ id: "t3.client/composer", version: "1.0.0" }] },
    );
    const oldFrames = frameIterator(oldStream);
    yield* nextFrame(oldFrames); // registered
    const newStream = yield* broker.connect(
      { connectionId: "conn-new", sessionId: "session", announcedOrigin: { surface: "web" } },
      { providers: [{ id: "t3.client/composer", version: "1.1.0" }] },
    );
    const newFrames = frameIterator(newStream);
    yield* nextFrame(newFrames); // registered

    const mixedProviders = createComposerApiProviders(resolverDeps, {
      environmentId: "env",
      clientApiProviders: broker,
    });
    const composer = mixedProviders.find((p) => p.providerId === "host.composer")!;
    const messages = mixedProviders.find((p) => p.providerId === "host.messages")!;

    // Capabilities report the targeted connection's version, not the environment's best.
    const oldCaps = (yield* Effect.promise(() =>
      dispatch(composer, "getCapabilities", {}, "conn-old"),
    )) as ComposerCapabilities;
    expect(oldCaps.transport).toBe("client");
    expect(oldCaps.detail).toContain("1.0.0");
    expect(oldCaps.operations).toEqual({
      insertContext: true,
      getDraftState: true,
      insertMention: false,
      insertTerminalContext: false,
    });
    const newCaps = (yield* Effect.promise(() =>
      dispatch(composer, "getCapabilities", {}, "conn-new"),
    )) as ComposerCapabilities;
    expect(newCaps.transport).toBe("client");
    expect(newCaps.detail).toBeNull();
    expect(newCaps.operations).toEqual({
      insertContext: true,
      getDraftState: true,
      insertMention: true,
      insertTerminalContext: true,
    });

    // The unchanged 1.0.0 file annotation still succeeds end to end.
    const fileAnnotation = yield* Effect.promise(() =>
      dispatch(
        messages,
        "attachAnnotation",
        {
          annotation: { filePath: "a.ts", startLine: 1, endLine: 2, body: "x" },
        } as Json,
        "conn-old",
      ),
    ).pipe(Effect.forkChild);
    const fileFrame = yield* nextFrame(oldFrames);
    if (fileFrame?.type !== "invoke") throw new Error("expected attachAnnotation dispatch");
    expect(fileFrame.method).toBe("attachAnnotation");
    yield* broker.respond("conn-old", {
      requestId: fileFrame.requestId,
      ok: true,
      value: { annotationId: "annotation:ext.a:legacy-1" },
    });
    expect(yield* Fiber.join(fileAnnotation)).toEqual({
      annotationId: "annotation:ext.a:legacy-1",
    });

    // The diff variant is refused with the named error before any mutation.
    yield* Effect.promise(() =>
      expectNamedError(
        dispatch(
          messages,
          "attachAnnotation",
          {
            annotation: {
              kind: "diff",
              filePath: "a.ts",
              sectionId: "diff:a.ts",
              sectionTitle: "Changes",
              rangeLabel: "+12",
              diff: "@@ -1,1 +1,1 @@\n-old\n+new",
              selection: { start: 12, side: "additions", end: 12, endSide: "additions" },
              body: "this breaks",
            },
          } as Json,
          "conn-old",
        ),
        "messages.enrichment.attachAnnotation",
        /client-provider-unsupported-version/,
      ),
    );
    // So is every other 1.1.0-only method on that connection.
    yield* Effect.promise(() =>
      expectNamedError(
        dispatch(composer, "insertMention", { paths: ["a.ts"] } as Json, "conn-old"),
        "composer.context.insertMention",
        /client-provider-unsupported-version/,
      ),
    );

    // Nothing was dispatched for the refused ops: the next frame on the old
    // socket is a later 1.0.0 op — no interleaved invoke frame exists.
    const followUp = yield* Effect.promise(() =>
      dispatch(composer, "getDraftState", {}, "conn-old"),
    ).pipe(Effect.forkChild);
    const followUpFrame = yield* nextFrame(oldFrames);
    if (followUpFrame?.type !== "invoke") throw new Error("expected getDraftState dispatch");
    expect(followUpFrame.method).toBe("getDraftState");
    yield* broker.respond("conn-old", {
      requestId: followUpFrame.requestId,
      ok: true,
      value: { draft: null },
    });
    expect(yield* Fiber.join(followUp)).toEqual({ draft: null });

    // The same 1.1.0 op does flow to a connection that declares 1.1.0.
    const mention = yield* Effect.promise(() =>
      dispatch(composer, "insertMention", { paths: ["a.ts"] } as Json, "conn-new"),
    ).pipe(Effect.forkChild);
    const mentionFrame = yield* nextFrame(newFrames);
    if (mentionFrame?.type !== "invoke") throw new Error("expected insertMention dispatch");
    expect(mentionFrame.method).toBe("insertMention");
    yield* broker.respond("conn-new", {
      requestId: mentionFrame.requestId,
      ok: true,
      value: { inserted: 1, target: "env:thread" },
    });
    expect(yield* Fiber.join(mention)).toEqual({ inserted: 1, target: "env:thread" });
  }).pipe(Effect.provide(brokerLayer)),
);

it.effect("fails state ops with a named unsupported error after valid scope and input", () =>
  Effect.promise(async () => {
    await expectNamedError(
      call(composer, "insertContext", {
        refs: [{ path: "src/a.ts", startLine: 1, endLine: 4, excerpt: "const a = 1" }],
      }),
      "composer.context.insertContext",
      /unavailable.*client-local/,
    );
    await expectNamedError(
      call(composer, "getDraftState", {}),
      "composer.context.getDraftState",
      /unavailable.*client-local/,
    );
    await expectNamedError(
      call(messages, "attachAnnotation", {
        annotation: { filePath: "src/a.ts", startLine: 1, endLine: 2, body: "rename this" },
      }),
      "messages.enrichment.attachAnnotation",
      /unavailable.*client-local/,
    );
    // The 1.1.0 shapes decode cleanly and hit the same honest transport gap.
    await expectNamedError(
      call(composer, "insertMention", { paths: ["src/a.ts"] }),
      "composer.context.insertMention",
      /unavailable.*client-local/,
    );
    await expectNamedError(
      call(composer, "insertTerminalContext", {
        terminalId: "term-1",
        terminalLabel: "zsh",
        lineStart: 3,
        lineEnd: 5,
        text: "npm test",
      }),
      "composer.context.insertTerminalContext",
      /unavailable.*client-local/,
    );
    await expectNamedError(
      call(messages, "listAnnotations", {}),
      "messages.enrichment.listAnnotations",
      /unavailable.*client-local/,
    );
    await expectNamedError(
      call(messages, "removeAnnotation", { annotationId: "annotation:x:y" }),
      "messages.enrichment.removeAnnotation",
      /unavailable.*client-local/,
    );
    // A diff-kind annotation decodes through the union variant.
    await expectNamedError(
      call(messages, "attachAnnotation", {
        annotation: {
          kind: "diff",
          filePath: "src/a.ts",
          sectionId: "diff:src/a.ts",
          sectionTitle: "Changes",
          rangeLabel: "+3",
          diff: "@@ -1,1 +1,1 @@\n-old\n+new",
          selection: { start: 3, side: "additions", end: 3, endSide: "additions" },
          body: "this breaks",
        },
      }),
      "messages.enrichment.attachAnnotation",
      /unavailable.*client-local/,
    );
  }),
);

it.effect("rejects malformed and over-bounds payloads with a named error, not a crash", () =>
  Effect.promise(async () => {
    for (const input of [
      { refs: [] },
      { refs: Array.from({ length: 9 }, () => ({ path: "a" })) },
      { refs: [{ path: "" }] },
      { refs: [{ path: "a".repeat(513) }] },
      { refs: [{ path: "a", startLine: 0 }] },
      { refs: [{ path: "a" }], extra: true },
      { refs: [{ path: "a", surprise: 1 }] },
      "not-an-object",
    ]) {
      await expectNamedError(
        call(composer, "insertContext", input as Json),
        "composer.context.insertContext",
        /Invalid/,
      );
    }
    for (const input of [
      { annotation: { filePath: "a", startLine: 1, endLine: 2 } },
      { annotation: { filePath: "a", startLine: 1, endLine: 2, body: "" } },
      { annotation: { filePath: "a", startLine: 1, endLine: 2, body: "x", extra: 1 } },
      { annotation: null },
      // 1.1.0 diff variant: closed schema, required fields, bounded selection.
      { annotation: { kind: "diff", filePath: "a", body: "x", diff: "+new", rangeLabel: "+1" } },
      {
        annotation: {
          kind: "diff",
          filePath: "a",
          body: "x",
          diff: "+new",
          rangeLabel: "+1",
          sectionId: "s",
          sectionTitle: "t",
          selection: { start: 0, side: "additions", end: 1, endSide: "additions" },
        },
      },
      {
        annotation: {
          kind: "diff",
          filePath: "a",
          body: "x",
          diff: "+new",
          rangeLabel: "+1",
          sectionId: "s",
          sectionTitle: "t",
          selection: { start: 1, side: "middle", end: 1, endSide: "additions" },
        },
      },
      {
        annotation: {
          kind: "not-diff",
          filePath: "a",
          body: "x",
        },
      },
    ]) {
      await expectNamedError(
        call(messages, "attachAnnotation", input as Json),
        "messages.enrichment.attachAnnotation",
        /Invalid/,
      );
    }
    for (const input of [
      { paths: [] },
      { paths: Array.from({ length: 9 }, () => "a") },
      { paths: ["a".repeat(513)] },
      { paths: [42] },
      { paths: ["a"], extra: true },
    ]) {
      await expectNamedError(
        call(composer, "insertMention", input as Json),
        "composer.context.insertMention",
        /Invalid/,
      );
    }
    for (const input of [
      { terminalId: "t", terminalLabel: "l", lineStart: 1, lineEnd: 1 },
      {
        terminalId: "t",
        terminalLabel: "l",
        lineStart: 1,
        lineEnd: 1,
        text: "\u0000".repeat(10_001),
      },
      { terminalId: "t", terminalLabel: "l", lineStart: 0, lineEnd: 1, text: "x" },
      { terminalId: "t", terminalLabel: "l", lineStart: 1, lineEnd: 1, text: "x", extra: 1 },
    ]) {
      await expectNamedError(
        call(composer, "insertTerminalContext", input as Json),
        "composer.context.insertTerminalContext",
        /Invalid/,
      );
    }
    for (const input of [{ annotationId: "" }, { extra: true }, "not-an-object"]) {
      await expectNamedError(
        call(messages, "removeAnnotation", input as Json),
        "messages.enrichment.removeAnnotation",
        /Invalid/,
      );
    }
  }),
);

it.effect("rejects foreign threads, foreign environments, and thread-less contexts", () =>
  Effect.promise(async () => {
    // An input threadId must equal the granted context's thread.
    await expectNamedError(
      call(composer, "insertContext", {
        threadId: "other-thread",
        refs: [{ path: "a" }],
      }),
      "composer.context.insertContext",
      /outside the granted thread scope/,
    );
    // A context without a thread cannot target a draft.
    await expectNamedError(
      call(
        messages,
        "attachAnnotation",
        {
          annotation: { filePath: "a", startLine: 1, endLine: 2, body: "x" },
        },
        makeContext(null),
      ),
      "messages.enrichment.attachAnnotation",
      /thread-scoped/,
    );
    // Foreign environments fail scope resolution before the unsupported error.
    const foreign = makeContext();
    const foreignContext: ViewContext = {
      ...foreign,
      resource: { ...foreign.resource, environmentId: "other" },
    };
    await expectNamedError(
      call(composer, "insertContext", { refs: [{ path: "a" }] }, foreignContext),
      "scope",
      /environment/,
    );
    // Unknown methods fail named, not silently.
    await expectNamedError(
      call(composer, "sendMessage", { text: "hi" }),
      "composer.context",
      /unavailable/,
    );
    // Every 1.1.0 op applies the same thread scoping as the 1.0.0 ops.
    await expectNamedError(
      call(composer, "insertMention", { threadId: "other-thread", paths: ["a"] }),
      "composer.context.insertMention",
      /outside the granted thread scope/,
    );
    await expectNamedError(
      call(composer, "insertTerminalContext", {
        threadId: "other-thread",
        terminalId: "t",
        terminalLabel: "l",
        lineStart: 1,
        lineEnd: 1,
        text: "x",
      }),
      "composer.context.insertTerminalContext",
      /outside the granted thread scope/,
    );
    await expectNamedError(
      call(messages, "listAnnotations", { threadId: "other-thread" }),
      "messages.enrichment.listAnnotations",
      /outside the granted thread scope/,
    );
    await expectNamedError(
      call(messages, "removeAnnotation", {
        threadId: "other-thread",
        annotationId: "annotation:x:y",
      }),
      "messages.enrichment.removeAnnotation",
      /outside the granted thread scope/,
    );
  }),
);

it.effect("enforces matching context thread on getDraftState too", () =>
  Effect.promise(async () => {
    await expectNamedError(
      call(composer, "getDraftState", { threadId: "other-thread" }),
      "composer.context.getDraftState",
      /outside the granted thread scope/,
    );
    // Matching threadId passes scope and reaches the honest unsupported error.
    await expectNamedError(
      call(composer, "getDraftState", { threadId: "thread" }),
      "composer.context.getDraftState",
      /unavailable.*client-local/,
    );
  }),
);
