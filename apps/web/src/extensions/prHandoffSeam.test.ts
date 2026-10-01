// @effect-diagnostics deterministicKeys:off - the test keys two tags as the server's own.
// The handoff end to end through the real transport: the extension broker, the server's client
// provider seam, this client's frame handler and the handoff provider. Only the native host
// steps, the socket and the toast surface are stand-ins.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ClientProviderServerFrame,
  type ClientProvidersRespondInput,
  PULL_REQUEST_HANDOFF_DEADLINE_MS,
} from "@t3tools/contracts";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { startClientProviderConnection } from "./clientProviderConnection";
import { createPrHandoffClientProvider } from "./clientProviders";
import type { InstalledPackage } from "./installedController";

// The server's seam and the extension broker are loaded by a path web's typecheck does not
// follow; their use here is typed by the small local shapes below.
const fromRepo = <Module>(path: string): Promise<Module> =>
  import(/* @vite-ignore */ new URL(path, import.meta.url).pathname);

// Keyed as the server's own tags, so the seam's layer resolves them.
class ServerEnvironment extends Context.Service<
  ServerEnvironment,
  { readonly getEnvironmentId: Effect.Effect<EnvironmentId> }
>()("t3/environment/ServerEnvironment") {}
interface SeamError {
  readonly message: string;
}
interface Seam {
  connect(
    socket: { connectionId: string; sessionId: string; announcedOrigin: { surface: string } },
    input: { providers: { id: string; version: string }[] },
  ): Effect.Effect<Stream.Stream<ClientProviderServerFrame>, SeamError>;
  respond(connectionId: string, input: ClientProvidersRespondInput): Effect.Effect<void, SeamError>;
}
class ClientApiProviders extends Context.Service<ClientApiProviders, Seam>()(
  "t3/extensions/ClientApiProviders",
) {}
type Installation = {
  readonly id: string;
  readonly grants: { readonly capabilities: readonly string[] };
};
interface Broker {
  invoke(
    record: Installation,
    request: {
      id: string;
      versionRange: string;
      method: string;
      input: Json;
      context: ViewContext;
    },
    signal: AbortSignal,
  ): Promise<Json>;
  invalidate(affectedPluginIds?: readonly string[]): void;
}
const { layer: clientApiProvidersLayer } = await fromRepo<{
  layer: Layer.Layer<ClientApiProviders, never, ServerEnvironment>;
}>("../../../server/src/extensions/ClientApiProviders.ts");
const { invokeClient } = await fromRepo<{
  invokeClient: (
    deps: { environmentId: string; clientApiProviders: Seam },
    request: {
      apiId: string;
      method: string;
      input: Json;
      context: ViewContext;
      metadata: unknown;
      signal: AbortSignal;
      timeoutMs: number;
      connectionId: string;
    },
  ) => Effect.Effect<Json, SeamError>;
}>("../../../server/src/extensions/uiClientApis.ts");
const { createApiBroker } = await fromRepo<{
  createApiBroker: (options: {
    environmentId: string;
    timeoutMs: number;
    installations: () => readonly Installation[];
    selections: () => readonly never[];
    authorize: (installation: Installation, grant: string) => boolean;
    invokeWorker: () => Promise<Json>;
    providers: readonly {
      providerId: string;
      definition: Json;
      deadlineMs: () => number;
      invoke: (
        method: string,
        input: Json,
        context: ViewContext,
        signal: AbortSignal,
        metadata: unknown,
      ) => Promise<Json>;
    }[];
  }) => Broker;
}>("../../../../packages/extension-runtime/src/broker.ts");

// The seam needs only the environment's service tag; the real module drags in the whole server.
vi.mock("../../../server/src/environment/ServerEnvironment", async () => {
  const { Service } = await import("effect/Context");
  class ServerEnvironment extends Service<ServerEnvironment, unknown>()(
    "t3/environment/ServerEnvironment",
  ) {}
  return { ServerEnvironment };
});
vi.mock("../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/entities")>()),
  readThreadShell: () => null,
  readProject: () => ({ workspaceRoot: "/work/project-a" }),
}));
vi.mock("../components/ThreadTerminalDrawer", () => ({ terminalThemeFromApp: () => ({}) }));
const toasts = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../components/ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/ui/toast")>()),
  toastManager: {
    add: (toast: unknown) => {
      const id = `toast-${toasts.size + 1}`;
      toasts.set(id, toast);
      return id;
    },
    update: (id: string, toast: unknown) => toasts.set(id, toast),
    close: (id: string) => toasts.set(id, "closed"),
  },
}));
// The socket: the client's connect stream and replies go straight to the server seam.
const socket = vi.hoisted(() => ({
  stream: null as unknown,
  respond: null as unknown,
}));
vi.mock("@t3tools/client-runtime/state/extensions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/extensions")>()),
  environmentClientProvidersStream: (...args: unknown[]) =>
    (socket.stream as (...args: unknown[]) => unknown)(...args),
  environmentClientProviderRespond: (...args: unknown[]) =>
    (socket.respond as (...args: unknown[]) => unknown)(...args),
  environmentClientProviderEmit: () => Effect.succeed(null),
  environmentConnectionStateChanges: () => Stream.never,
}));
vi.mock("../rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/unstable/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("../connection/runtime", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const Layer = await import("effect/Layer");
  return { connectionAtomRuntime: Atom.runtime(Layer.empty) };
});

const ENV = "env-a";
const INSTALL = "t3.version-control";
const GRANTS = ["t3.vcs/mutate", "t3.vcs/handoff"];
const API = "test.vcs/handoff";
const NEW_DRAFT = DraftId.make("draft-handoff");
const NEW_THREAD = ThreadId.make("thread-handoff");
const PULL_REQUEST = {
  number: 12,
  url: "https://github.com/o/r/pull/12",
  headBranch: "feat/x",
  baseBranch: "main",
};
const context: ViewContext = {
  client: "web",
  resource: {
    namespace: INSTALL,
    id: `${INSTALL}/view`,
    environmentId: ENV,
    projectId: "project-a",
  },
};
/** The server's own wait on the client, as `vcsActionsApi` gives it. */
const CLIENT_WAIT_MS = PULL_REQUEST_HANDOFF_DEADLINE_MS - 60_000;
/** Past the seam's grace on that wait. */
const PAST_THE_SEAM_MS = CLIENT_WAIT_MS + 2_001;

const record = {
  id: INSTALL,
  contentHash: "hash-a",
  enabled: true,
  grants: { capabilities: GRANTS, projectIds: ["project-a"] },
  package: {
    format: 2,
    manifest: { id: INSTALL, apiVersion: 1, version: "1.0.0", surfaces: [] },
    tools: [],
    provides: [],
    requires: [{ id: API, versionRange: "^1.0.0" }],
    dependencies: [],
  },
};
const installedPackage = {
  id: INSTALL,
  contentHash: "hash-a",
  enabled: true,
  installationGeneration: 1,
  grants: { capabilities: GRANTS, projectIds: [ProjectId.make("project-a")] },
  package: { manifest: { id: INSTALL, apiVersion: 1, version: "1.0.0", surfaces: [] } },
} as unknown as InstalledPackage;

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const stops: (() => Promise<void>)[] = [];

beforeEach(() => {
  toasts.clear();
  useComposerDraftStore.getState().setPrompt(NEW_DRAFT, "");
});

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function setup() {
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- the promise-based broker and client connection call back into the seam, so one runtime must outlive any single it.effect run.
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      clientApiProvidersLayer.pipe(
        Layer.provide(
          Layer.succeed(ServerEnvironment, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make(ENV)),
          }),
        ),
      ),
      TestClock.layer(),
    ),
  );
  const seam = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* ClientApiProviders;
    }),
  );
  const frames: string[] = [];
  const replies: ClientProvidersRespondInput[] = [];
  let connectionId: string | undefined;
  // Receipts: each resolves when the server or the client actually gets that far.
  const registered = gate();
  const cancelled = gate();
  const replied = gate();
  socket.stream = (
    _environmentId: string,
    input: { providers: { id: string; version: string }[] },
  ) =>
    Stream.unwrap(
      seam.connect(
        { connectionId: "conn-a", sessionId: "session-a", announcedOrigin: { surface: "web" } },
        input,
      ),
    ).pipe(
      Stream.tap((frame: ClientProviderServerFrame) =>
        Effect.sync(() => {
          frames.push(frame.type);
          if (frame.type === "registered") {
            connectionId = frame.connectionId;
            registered.resolve();
          }
          if (frame.type === "cancel") cancelled.resolve();
        }),
      ),
    );
  socket.respond = (_environmentId: string, payload: ClientProvidersRespondInput) => {
    replies.push(payload);
    replied.resolve();
    return seam.respond(connectionId!, payload).pipe(Effect.ignore, Effect.as(null));
  };

  const steps: string[] = [];
  let signal: AbortSignal | undefined;
  let invoked: Promise<unknown> | undefined;
  let prepared: Promise<unknown> | undefined;
  const held = gate();
  const reached = gate();
  const provider = createPrHandoffClientProvider(
    {
      environmentId: EnvironmentId.make(ENV),
      client: "web",
      emit: vi.fn(),
      installations: () => [installedPackage],
    },
    {
      openThread: async (_projectRef: unknown, workspace?: unknown) => {
        steps.push(workspace === undefined ? "open" : "point");
        return { draftId: NEW_DRAFT, threadId: NEW_THREAD };
      },
      prepare: () =>
        (prepared = (async () => {
          steps.push("prepare");
          reached.resolve();
          await held.promise;
          return {
            ok: true as const,
            value: { branch: "feat/x", worktreePath: "/work/wt", isOnPullRequestHead: true },
          };
        })()),
    },
  );
  const connection = startClientProviderConnection({
    environmentId: EnvironmentId.make(ENV),
    providers: new Map([
      [
        "t3.client/pr-handoff",
        {
          invoke: (call) => {
            signal = call.signal;
            const invocation = Promise.resolve(provider.invoke(call));
            invoked = invocation.catch(() => {});
            return invocation;
          },
        },
      ],
    ]),
    descriptors: [{ id: "t3.client/pr-handoff", version: "1.0.0" }],
    flushGlobalCommands: () => Promise.resolve(),
  });
  stops.push(async () => {
    held.resolve();
    connection.stop();
    await runtime.dispose();
  });
  await registered.promise;

  let installations: readonly Installation[] = [record];
  const broker = createApiBroker({
    environmentId: ENV,
    timeoutMs: 15_000,
    installations: () => installations,
    selections: () => [],
    authorize: (installation, grant) => installation.grants.capabilities.includes(grant),
    invokeWorker: () => Promise.reject(new Error("no workers here")),
    providers: [
      {
        providerId: "host.handoff",
        definition: {
          id: API,
          version: "1.0.0",
          methods: [
            {
              name: "start",
              inputSchema: { type: "object" },
              outputSchema: { type: "object" },
              effect: "write",
              requiredGrants: [],
            },
          ],
        },
        deadlineMs: () => PULL_REQUEST_HANDOFF_DEADLINE_MS,
        invoke: (method, input, callContext, callSignal, metadata) =>
          runtime.runPromise(
            invokeClient(
              { environmentId: ENV, clientApiProviders: seam },
              {
                apiId: "t3.client/pr-handoff",
                method,
                input,
                context: callContext,
                metadata,
                signal: callSignal,
                timeoutMs: CLIENT_WAIT_MS,
                connectionId: connectionId!,
              },
            ),
          ),
      },
    ],
  });
  const outcome = broker
    .invoke(
      record,
      {
        id: API,
        versionRange: "^1.0.0",
        method: "start",
        input: { task: "resolve-conflicts", mode: "worktree", pullRequest: PULL_REQUEST } as Json,
        context,
      },
      new AbortController().signal,
    )
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
    );
  await reached.promise;
  return {
    frames,
    replies,
    steps,
    outcome,
    signal: () => signal!,
    cancelled: cancelled.promise,
    replied: replied.promise,
    /**
     * Releases the held checkout, then waits for it to return and for the client's handling of the
     * call to run to its end, so anything the late result could start has already happened.
     */
    releaseAndDrain: async () => {
      held.resolve();
      await prepared;
      await invoked;
    },
    advance: (ms: number) => runtime.runPromise(TestClock.adjust(ms)),
    uninstall: () => {
      installations = [];
      broker.invalidate([INSTALL]);
    },
  };
}

const CHECKOUT_STOPPED = {
  type: "warning",
  title: "Handoff stopped",
  description: "Stopped while preparing the checkout; it may still finish.",
};

describe("a handoff whose call ends while the checkout is still running", () => {
  it("is cancelled on the client when the server stops waiting, and a late checkout starts nothing", async () => {
    const handoff = await setup();
    await handoff.advance(PAST_THE_SEAM_MS);
    expect(await handoff.outcome).toEqual({
      error: "client-request-timeout: Client provider request timed out.",
    });
    // The server cancels the call and the client answers while the checkout is still held.
    await handoff.cancelled;
    await handoff.replied;
    expect(handoff.frames).toEqual(["registered", "invoke", "cancel"]);
    expect(handoff.signal().aborted).toBe(true);
    // The client answered, so its pending entry is gone, and the spinner says where it stopped.
    expect(handoff.replies).toEqual([expect.objectContaining({ ok: false })]);
    expect([...toasts.values()]).toEqual([CHECKOUT_STOPPED]);

    await handoff.releaseAndDrain();
    expect(handoff.steps).toEqual(["open", "prepare"]);
    expect(handoff.replies).toHaveLength(1);
    expect(useComposerDraftStore.getState().getComposerDraft(NEW_DRAFT)?.prompt ?? "").toBe("");
    expect([...toasts.values()]).toEqual([CHECKOUT_STOPPED]);
  });

  it("lets go at once when its pack is uninstalled, before the checkout returns", async () => {
    const handoff = await setup();
    handoff.uninstall();
    expect(await handoff.outcome).toEqual({ error: "API configuration changed" });
    await handoff.cancelled;
    await handoff.replied;
    expect(handoff.frames).toEqual(["registered", "invoke", "cancel"]);
    expect(handoff.signal().aborted).toBe(true);
    expect([...toasts.values()]).toEqual([CHECKOUT_STOPPED]);

    await handoff.releaseAndDrain();
    expect(handoff.steps).toEqual(["open", "prepare"]);
    expect(handoff.replies).toHaveLength(1);
    expect([...toasts.values()]).toEqual([CHECKOUT_STOPPED]);
  });
});
