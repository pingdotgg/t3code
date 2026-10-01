import * as React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ProjectId, type ExtensionInstallation } from "@t3tools/contracts";
import { resolveResumableStreams, type ApiStreamFrame } from "@t3tools/extension-sdk/capabilities";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewRecord } from "@t3tools/extension-sdk/contracts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** One fake environment: its prepared connection, its catalogue and its transport. */
const env = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const prepared = new Map<string, unknown>();
  const online = new Map<string, boolean>();
  const installed = new Map<string, unknown[]>();
  const waiters = new Set<() => void>();
  // Environments whose catalogue list never answers, like a black-holed request.
  const heldLists = new Set<string>();
  // Answers the pending API discovery whenever the test chooses.
  const discovery: { reply?: (value: unknown) => void } = {};
  const notify = () => {
    for (const listener of listeners) listener();
    for (const waiter of [...waiters]) waiter();
  };
  return { listeners, prepared, online, installed, waiters, heldLists, discovery, notify };
});

vi.mock("../connection/runtime", async () => {
  const { AsyncResult, Atom } = await import("effect/unstable/reactivity");
  const Context = await import("effect/Context");
  return { connectionAtomRuntime: Atom.make(AsyncResult.success(Context.empty())) };
});
vi.mock("../rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/unstable/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ _tag: "Initial" }) }));
vi.mock("@tanstack/react-router", () => {
  const router = {};
  return { useRouter: () => router };
});
vi.mock("../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => () => {} }));
vi.mock("../threadRoutes", () => ({ buildThreadRouteParams: () => ({}) }));
vi.mock("../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("../state/entities", () => ({ readProject: () => undefined, readThreadShell: () => null }));
vi.mock("../state/presentation", () => ({
  environmentPresentations: { presentationAtom: () => undefined },
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: "env-a" }, { environmentId: "env-b" }],
  }),
}));
vi.mock("../state/session", async () => {
  const { useSyncExternalStore } = await import("react");
  const Option = await import("effect/Option");
  const subscribe = (listener: () => void) => {
    env.listeners.add(listener);
    return () => env.listeners.delete(listener);
  };
  const read = (id: string) => (env.prepared.get(id) ?? Option.none()) as Option.Option<unknown>;
  return {
    usePreparedConnection: (id: string) => useSyncExternalStore(subscribe, () => read(id)),
    readPreparedConnection: (id: string) => Option.getOrNull(read(id)),
  };
});
vi.mock("@t3tools/client-runtime/state/extensions", async () => {
  const Effect = await import("effect/Effect");
  const Data = await import("effect/Data");
  class Unreachable extends Data.TaggedError("Unreachable")<{ readonly message: string }> {}
  const reachable = (connection: { environmentId: string }) =>
    env.online.get(connection.environmentId) === true;
  return {
    createExtensionCatalogueAtoms: () => () => ({}),
    environmentExtensionApiStream: () => undefined,
    environmentExtensionsHttp: {
      list: (connection: { environmentId: string }) =>
        Effect.suspend(() =>
          env.heldLists.has(connection.environmentId)
            ? Effect.never
            : reachable(connection)
              ? Effect.succeed({
                  installations: env.installed.get(connection.environmentId) ?? [],
                  supportsApiStreams: true,
                  supportedPackageFormats: [1, 2, 3],
                })
              : Effect.fail(new Unreachable({ message: "Failed to fetch" })),
        ),
      client: (_connection: unknown, input: { expectedContentHash: string }) =>
        Effect.succeed({ code: "pack", contentHash: input.expectedContentHash }),
      discoverApis: () =>
        Effect.promise(
          () =>
            new Promise((resolve) => {
              env.discovery.reply = resolve;
            }),
        ),
    },
  };
});
// A resumable stream follows transport sessions: it reports each drop through
// `onSuspended` and continues with a fresh frame once the environment is back.
vi.mock("./installedApiFrames", () => ({
  authenticatedApiFrames: () => ({ async *[Symbol.asyncIterator]() {} }),
  resumableApiFrames: (
    environmentId: string,
    _payload: unknown,
    signal: AbortSignal,
    onSuspended?: () => void,
  ) => ({
    async *[Symbol.asyncIterator]() {
      const until = (want: boolean) =>
        new Promise<void>((resolve) => {
          const check = () => {
            if (env.online.get(environmentId) !== want) return;
            env.waiters.delete(check);
            resolve();
          };
          env.waiters.add(check);
          check();
        });
      let sequence = 0;
      while (!signal.aborted) {
        await until(true);
        yield { type: "snapshot", streamId: "s", sequence: ++sequence, value: {} };
        await until(false);
        onSuspended?.();
      }
    },
  }),
}));
vi.mock("./clientProviders", () => ({
  CLIENT_PROVIDER_CLIENT_TAG: "web",
  CLIENT_PROVIDER_DESCRIPTORS: [],
  createClientProviders: () => new Map(),
  nativePrHandoffPrepare: () => undefined,
}));
vi.mock("./clientProviderConnection", () => ({
  currentClientConnectionId: () => undefined,
  withClientConnectionId: () => undefined,
  withClientConnectionIdFrames: () => undefined,
  emitClientProviderEvent: () => {},
  startClientProviderConnection: () => ({ stop: () => {}, notifyInstallationsChanged: () => {} }),
}));
vi.mock("./browserSurfaceBridge", () => ({ createBrowserSurfaceBridge: () => undefined }));
vi.mock("./browserFramesBridge", () => ({ createBrowserFramesBridge: () => undefined }));
vi.mock("./browserCaptureBridge", () => ({ createBrowserCaptureBridge: () => undefined }));
vi.mock("./keybindingsHostBridge", () => ({ createKeybindingsHostBridge: () => undefined }));
vi.mock("./codeView/hostCodeView", () => ({ hostCodeView: undefined }));
vi.mock("./hostTooltip", () => ({ hostTooltip: undefined }));
vi.mock("./floatingLayer/hostFloatingLayer", () => ({ hostFloatingLayer: undefined }));
vi.mock("./hostPullRequestPreferences", () => ({ hostPullRequestPreferences: undefined }));

const { InstalledExtensionsBootstrap, refreshInstalledExtensions } =
  await import("./installedEnvironment");
const { WorkspaceExtensionSurface } = await import("./workspaceRegistry");

const surface = {
  id: "test.pack/view",
  title: "Pack",
  scope: "project" as const,
  clients: ["web"],
  placements: ["side-panel" as const],
  capabilities: [],
  stateVersion: 1,
};
const manifest = { id: "test.pack", version: "1.0.0", apiVersion: 1 as const, surfaces: [surface] };
const pack: ExtensionInstallation = {
  id: manifest.id,
  contentHash: "a".repeat(64),
  enabled: true,
  grants: { capabilities: [], projectIds: [ProjectId.make("project-a")] },
  package: { format: 1, manifest, clientEntry: "client.mjs", tools: [] },
};
const mounts: string[] = [];
/** The client host each environment's mounted view was created with. */
const hosts = new Map<string, ClientHost>();
/** The installed client: a terminal-like view that follows one resumable stream. */
Object.assign(globalThis, {
  __t3HostTestPack: (host: ClientHost) => ({
    manifest,
    surfaces: [
      {
        id: surface.id,
        validateRestore: () => true,
        createView: (session: { context: ViewRecord["context"] }) => {
          hosts.set(session.context.resource.environmentId!, host);
          return {
            renderer: function PackView() {
              const [state, setState] = React.useState("connecting");
              React.useEffect(() => {
                const environmentId = session.context.resource.environmentId!;
                mounts.push(environmentId);
                const controller = new AbortController();
                const frames = resolveResumableStreams(host)!.subscribeApi(
                  {
                    id: "t3.terminal/output-events",
                    versionRange: "^1.0.0",
                    name: "subscribe",
                    input: { terminalId: "term-1" },
                    context: session.context,
                  },
                  controller.signal,
                  { onSuspended: () => setState("Reconnecting…") },
                );
                void (async () => {
                  try {
                    for await (const frame of frames as AsyncIterable<ApiStreamFrame>)
                      setState("live " + frame.sequence);
                  } catch {
                    setState("stream closed");
                  }
                })();
                return () => controller.abort();
              }, []);
              return <span>{state}</span>;
            },
          };
        },
      },
    ],
  }),
});
// The installed client body is imported from an object URL; point it at the fixture above.
vi.spyOn(URL, "createObjectURL").mockReturnValue(
  "data:text/javascript,export default globalThis.__t3HostTestPack",
);

const record = (environmentId: string): ViewRecord => ({
  version: 1,
  surfaceId: surface.id,
  placement: "side-panel",
  stateVersion: 1,
  restoreState: null,
  fallback: "Pack is unavailable. Check environment extensions in Settings.",
  context: {
    client: "web",
    resource: { namespace: manifest.id, id: surface.id, environmentId, projectId: "project-a" },
  },
});
/** Each reconnect produces a new prepared connection, like the supervisor does. */
const setConnected = (environmentId: string, connected: boolean) => {
  env.online.set(environmentId, connected);
  env.prepared.set(
    environmentId,
    connected ? Option.some({ environmentId, httpBaseUrl: "http://env" }) : Option.none(),
  );
  env.notify();
};
const settle = () =>
  act(async () => {
    for (let index = 0; index < 20; index++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const text = (root: ReactTestRenderer) => JSON.stringify(root.toJSON());

let roots: ReactTestRenderer[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount();
  });
  roots = [];
  mounts.length = 0;
  hosts.clear();
  env.heldLists.clear();
  delete env.discovery.reply;
  env.prepared.clear();
  env.online.clear();
  env.installed.clear();
  env.waiters.clear();
});

async function mountHost() {
  env.installed.set("env-a", [pack]);
  env.installed.set("env-b", [pack]);
  setConnected("env-a", true);
  setConnected("env-b", true);
  let a!: ReactTestRenderer;
  let b!: ReactTestRenderer;
  await act(async () => {
    roots.push(create(<InstalledExtensionsBootstrap />));
  });
  await settle();
  await act(async () => {
    a = create(<WorkspaceExtensionSurface record={record("env-a")} visible />);
    b = create(<WorkspaceExtensionSurface record={record("env-b")} visible />);
    roots.push(a, b);
  });
  await settle();
  expect(text(a)).toContain("live 1");
  expect(text(b)).toContain("live 1");
  return { a, b };
}

it("keeps a mounted pack through a disconnect and lets its stream report the suspension", async () => {
  const { a, b } = await mountHost();

  await act(async () => setConnected("env-a", false));
  await settle();
  expect(text(a)).toContain("Reconnecting…");
  expect(text(a)).not.toContain("unavailable");
  // A catalogue refresh while the environment is unreachable knows nothing new.
  await act(() => refreshInstalledExtensions("env-a"));
  await settle();
  expect(text(a)).toContain("Reconnecting…");
  // Another environment's panel is unaffected by env-a's drop.
  expect(text(b)).toContain("live 1");

  await act(async () => setConnected("env-a", true));
  await settle();
  expect(text(a)).toContain("live 2");
  expect(mounts).toEqual(["env-a", "env-b"]);
});

it("removes a pack that was uninstalled while the environment was disconnected", async () => {
  const { a, b } = await mountHost();

  await act(async () => setConnected("env-a", false));
  await settle();
  env.installed.set("env-a", []);
  await act(async () => setConnected("env-a", true));
  await settle();

  expect(text(a)).toContain("Pack is unavailable");
  expect(text(b)).toContain("live 1");
});

it("fails a one-shot call that was in flight when the connection dropped", async () => {
  const { a } = await mountHost();
  const host = hosts.get("env-a")!;
  const call = host.discoverApis(record("env-a").context, new AbortController().signal);
  const outcome = call.then(
    (value) => ({ settled: "resolved", value }),
    (error: Error) => ({ settled: "rejected", value: error.message }),
  );
  await settle();

  await act(async () => setConnected("env-a", false));
  await settle();
  await act(async () => setConnected("env-a", true));
  await settle();
  // The old connection's reply arrives after the new session started.
  env.discovery.reply?.({ apis: [{ id: "late.api", status: "available" }] });
  await settle();

  expect(await outcome).toMatchObject({ settled: "rejected" });
  // The drop ended the call, not the mounted pack.
  expect(text(a)).toContain("live 2");
});

it("does not let a catalogue list from a dropped connection hold the reconnect refresh", async () => {
  const { a } = await mountHost();

  env.heldLists.add("env-a");
  void refreshInstalledExtensions("env-a");
  await settle();
  await act(async () => setConnected("env-a", false));
  await settle();
  env.heldLists.delete("env-a");
  env.installed.set("env-a", []);
  await act(async () => setConnected("env-a", true));
  await settle();

  expect(text(a)).toContain("Pack is unavailable");
});
