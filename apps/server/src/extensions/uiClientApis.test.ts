import { ClientProvidersError } from "@t3tools/contracts";
import { CLIENT_PROVIDER_APIS } from "@t3tools/extension-sdk/clientProviders";
import { uiEditorApi } from "@t3tools/extension-sdk/catalogue";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import type {
  HostApiInvocationMetadata,
  HostApiPrincipal,
  HostApiProvider,
} from "@t3tools/extension-runtime";
import { describe, expect, it, vi } from "vite-plus/test";
import { Ajv } from "ajv";
import * as Effect from "effect/Effect";
import type { ClientApiProviders, CorrelationEntry } from "./ClientApiProviders.ts";
import { createUiClientApiProviders } from "./uiClientApis.ts";

const ENV = "env-a";
const signal = new AbortController().signal;

const context = {
  resource: {
    namespace: "t3.extensions",
    id: "ext.a",
    environmentId: ENV,
    projectId: "project-a",
    threadId: "thread-a",
  },
  client: "web",
} as ViewContext;

interface RecordedInvoke {
  readonly connectionId: string;
  readonly apiId: string;
  readonly method: string;
  readonly input: Json;
}

function fakeBridge(options?: {
  resolveFailure?: ClientProvidersError;
  targets?: readonly unknown[];
  sessionConnections?: Record<string, readonly string[]>;
  miniPlayerSupported?: boolean;
}) {
  const correlations = new Map<string, CorrelationEntry>();
  const invoked: RecordedInvoke[] = [];
  const subscribed: { apiId: string; name: string; input: Json; coalesce?: boolean }[] = [];
  const service: ClientApiProviders["Service"] = {
    connect: () => Effect.die("unused"),
    respond: () => Effect.void,
    emit: () => Effect.void,
    invoke: (request) => {
      invoked.push({
        connectionId: request.connectionId,
        apiId: request.apiId,
        method: request.method,
        input: request.input,
      });
      if (request.method === "dismiss") return Effect.succeed({ dismissed: true });
      if (request.method === "open")
        return Effect.succeed({
          status: "opened",
          url: (request.input as { url: string }).url,
          opener: "desktop-shell",
        });
      if (request.method === "openSession")
        return Effect.succeed({
          status: "opened",
          agentId: (request.input as { agentId: string }).agentId,
          opener: "desktop-shell",
        });
      if (request.method === "getCapabilities")
        return Effect.succeed(
          request.apiId === "t3.client/panels"
            ? { browserMiniPlayer: options?.miniPlayerSupported ?? true }
            : request.apiId === "t3.client/editor"
              ? {
                  adapter: "host.ui.editor",
                  operations: { openPath: true },
                  clients: [],
                  editor: {
                    visible: true,
                    editors: [{ id: "vscode", label: "VS Code" }],
                    preferredEditor: "vscode",
                    remoteHint: null,
                  },
                }
              : { openFileInBrowser: true },
        );
      if (request.method === "openFile")
        return Effect.succeed({
          status: "opened",
          relativePath: (request.input as { relativePath: string }).relativePath,
        });
      if (request.method === "openThread")
        return Effect.succeed({
          status: "opened",
          threadId: (request.input as { threadId: string }).threadId,
        });
      if (request.method === "registerCommands") {
        const commands = (request.input as { commands: { id: string }[] }).commands;
        return Effect.succeed({
          commandSetToken: "cmdset-1",
          results: commands.map((command) => ({ commandId: command.id, status: "registered" })),
        });
      }
      return Effect.succeed({ applied: true });
    },
    openSubscription: (request) => {
      subscribed.push({
        apiId: request.apiId,
        name: request.name,
        input: request.input,
        ...(request.coalesce !== undefined ? { coalesce: request.coalesce } : {}),
      });
      return Effect.succeed({
        events: (async function* () {
          yield { type: "snapshot" as const, value: { wordWrap: true } };
        })(),
        close: () => Effect.void,
      });
    },
    registerCorrelation: (correlationId, entry) => {
      correlations.set(correlationId, entry);
      return Effect.void;
    },
    unregisterCorrelation: (correlationId) => {
      correlations.delete(correlationId);
      return Effect.void;
    },
    // By default the one client runs every current area, as a real one lists them.
    listTargets: () =>
      Effect.succeed(
        (options?.targets ?? [
          {
            connectionId: "conn-1",
            providers: [...CLIENT_PROVIDER_APIS.values()].map(({ id, version }) => ({
              id,
              version,
            })),
          },
        ]) as readonly import("@t3tools/contracts").ClientTargetInfo[],
      ),
    resolveTarget: (_environmentId, _principal, hint) =>
      options?.resolveFailure
        ? Effect.fail(options.resolveFailure)
        : Effect.succeed(hint ?? "conn-1"),
    hasProvider: () => Effect.succeed(true),
    connectionForSession: (sessionId, connectionId) =>
      Effect.succeed(options?.sessionConnections?.[sessionId]?.includes(connectionId) ?? true),
  };
  return { service, correlations, invoked, subscribed };
}

const hostPrincipal: HostApiPrincipal = {
  kind: "host",
  id: "host",
  environmentId: ENV,
  scopes: [],
};

const metadata = (
  installationId = "ext.a",
  principal: HostApiPrincipal | undefined = hostPrincipal,
): HostApiInvocationMetadata => ({
  callId: "call-1",
  rootCallerId: installationId,
  callerId: installationId,
  providerId: "host.ui.test",
  providerGeneration: 1,
  callerGenerations: [{ pluginId: installationId, contentHash: "hash", installationGeneration: 1 }],
  ...(principal ? { principal } : {}),
});

const THREAD_PROJECTS: Record<string, string> = {
  "thread-a": "project-a",
  "thread-b": "project-a",
  "thread-other": "project-b",
};

function makeProviders(
  bridge: ReturnType<typeof fakeBridge>,
  authorizeGrant?: () => Promise<boolean>,
) {
  const providers = createUiClientApiProviders({
    environmentId: ENV,
    clientApiProviders: bridge.service,
    authorizeGrant: authorizeGrant ?? (() => Promise.resolve(true)),
    resolveThreadProject: (threadId) => Promise.resolve(THREAD_PROJECTS[threadId] ?? null),
    readThreadAgentSessions: (threadId) =>
      Promise.resolve(
        threadId === "thread-a"
          ? [
              { id: "workflow-1", sessionUrl: "https://claude.ai/code/session_1" },
              { id: "task-1" },
              { id: "task-bad", sessionUrl: "file:///etc/passwd" },
            ]
          : null,
      ),
  });
  const byId = (providerId: string): HostApiProvider =>
    providers.find((provider) => provider.providerId === providerId)!;
  return {
    theme: byId("host.ui.theme"),
    keybindings: byId("host.ui.keybindings"),
    notifications: byId("host.ui.notifications"),
    panels: byId("host.ui.panels"),
    preferences: byId("host.ui.preferences"),
    external: byId("host.ui.external"),
    editor: byId("host.ui.editor"),
    history: byId("host.browser.history"),
    navigation: byId("host.ui.navigation"),
  };
}

describe("browser mini-player client adapter", () => {
  it("reports the targeted client's engine and version rather than a capable sibling", async () => {
    const bridge = fakeBridge({
      targets: [
        { connectionId: "conn-1", providers: [{ id: "t3.client/panels", version: "1.0.0" }] },
        { connectionId: "sibling", providers: [{ id: "t3.client/panels", version: "1.1.0" }] },
      ],
    });
    const { panels } = makeProviders(bridge);
    const caps = (await panels.invoke("getCapabilities", {}, context, signal, metadata())) as {
      operations: Record<string, boolean>;
    };
    expect(caps.operations.setBrowserMiniPlayer).toBe(false);
    await expect(
      panels.invoke(
        "setBrowserMiniPlayer",
        { tabId: "tab-a", serverEpoch: "epoch-a", open: true },
        context,
        signal,
        metadata(),
      ),
    ).rejects.toMatchObject({ code: "provider-rejected" });
    expect(bridge.invoked).toHaveLength(0);
    const web = makeProviders(fakeBridge({ miniPlayerSupported: false }));
    const webCaps = (await web.panels.invoke(
      "getCapabilities",
      {},
      context,
      signal,
      metadata(),
    )) as { operations: Record<string, boolean> };
    expect(webCaps.operations.getBrowserMiniPlayer).toBe(false);
    expect(webCaps.operations.setBrowserMiniPlayer).toBe(false);
  });

  it("pins mini-player requests to the caller's client and thread", async () => {
    const bridge = fakeBridge();
    const { panels } = makeProviders(bridge);
    await panels.invoke(
      "setBrowserMiniPlayer",
      { tabId: "tab-a", serverEpoch: "epoch-a", open: true },
      context,
      signal,
      metadata(),
    );
    expect(bridge.invoked).toEqual([
      {
        connectionId: "conn-1",
        apiId: "t3.client/panels",
        method: "setBrowserMiniPlayer",
        input: {
          target: { kind: "connection", connectionId: "conn-1" },
          threadId: "thread-a",
          tabId: "tab-a",
          serverEpoch: "epoch-a",
          open: true,
        },
      },
    ]);
    await expect(
      panels.invoke(
        "setBrowserMiniPlayer",
        { threadId: "other", tabId: "tab-a", serverEpoch: "epoch-a", open: true },
        context,
        signal,
        metadata(),
      ),
    ).rejects.toMatchObject({ code: "client-target-denied" });
  });

  it("does not advertise mini-player access to provider sessions or an unavailable target", async () => {
    const bridge = fakeBridge();
    const { panels } = makeProviders(bridge);
    const caps = (await panels.invoke(
      "getCapabilities",
      {},
      context,
      signal,
      metadata("ext.a", {
        kind: "provider-session",
        id: "provider-1",
        environmentId: ENV,
        scopes: [],
      }),
    )) as { operations: Record<string, boolean> };
    expect(caps.operations.getBrowserMiniPlayer).toBe(false);
    expect(caps.operations.setBrowserMiniPlayer).toBe(false);
    expect(bridge.invoked).toHaveLength(0);
    const unavailable = makeProviders(
      fakeBridge({
        resolveFailure: new ClientProvidersError({
          code: "client-provider-unavailable",
          detail: "No target",
        }),
      }),
    );
    const unavailableCaps = (await unavailable.panels.invoke(
      "getCapabilities",
      {},
      context,
      signal,
      metadata(),
    )) as { operations: Record<string, boolean> };
    expect(unavailableCaps.operations.setBrowserMiniPlayer).toBe(false);
  });
});

describe("preferences adapter", () => {
  it("forwards writes as the broker-verified writer's patch", async () => {
    const bridge = fakeBridge();
    const { preferences } = makeProviders(bridge);
    await preferences.invoke(
      "setPreferences",
      { wordWrap: false } as Json,
      context,
      signal,
      metadata(),
    );
    const forwarded = bridge.invoked[0]!;
    expect(forwarded.apiId).toBe("t3.client/preferences");
    expect(forwarded.method).toBe("applyPreferences");
    expect(forwarded.input).toEqual({
      target: { kind: "connection", connectionId: "conn-1" },
      writer: "ext.a",
      patch: { wordWrap: false },
      include: ["renderBrowserFile", "fileExplorerOpen"],
    });
  });

  it("streams the client's coalesced watch feed", async () => {
    const bridge = fakeBridge();
    const { preferences } = makeProviders(bridge);
    const events = [];
    for await (const event of preferences.subscribe!(
      "subscribePreferences",
      {},
      context,
      signal,
      metadata(),
    ))
      events.push(event);
    expect(bridge.subscribed).toEqual([
      {
        apiId: "t3.client/preferences",
        name: "watchPreferences",
        input: {
          target: { kind: "connection", connectionId: "conn-1" },
          include: ["renderBrowserFile", "fileExplorerOpen"],
        },
        coalesce: true,
      },
    ]);
    expect(events).toEqual([{ type: "snapshot", value: { wordWrap: true } }]);
  });
});

describe("theme adapter", () => {
  it("stamps the broker-verified caller as the preference writer", async () => {
    const bridge = fakeBridge();
    const { theme } = makeProviders(bridge);
    await theme.invoke(
      "setPreference",
      { mode: "session", theme: "ocean" } as unknown as Json,
      context,
      signal,
      metadata(),
    );
    const forwarded = bridge.invoked[0]!;
    expect(forwarded.apiId).toBe("t3.client/theme");
    expect(forwarded.method).toBe("applyPreference");
    expect(forwarded.input).toMatchObject({
      writer: "ext.a",
      preference: { mode: "session", theme: "ocean" },
      target: { kind: "connection", connectionId: "conn-1" },
    });
  });

  it("propagates target resolution failures instead of forwarding", async () => {
    const bridge = fakeBridge({
      resolveFailure: new ClientProvidersError({
        code: "client-target-denied",
        detail: "Provider sessions cannot target clients.",
      }),
    });
    const { theme } = makeProviders(bridge);
    await expect(theme.invoke("getState", {}, context, signal, metadata())).rejects.toMatchObject({
      code: "client-target-denied",
    });
    expect(bridge.invoked).toHaveLength(0);
  });
});

describe("external adapter", () => {
  it("refuses bad URLs and non-allowlisted schemes without reaching a client", async () => {
    const bridge = fakeBridge();
    const { external } = makeProviders(bridge);
    const open = (url: string) => external.invoke("open", { url }, context, signal, metadata());
    await expect(open("not a url")).resolves.toEqual({ status: "refused", reason: "invalid-url" });
    await expect(open("//example.com/relative")).resolves.toEqual({
      status: "refused",
      reason: "invalid-url",
    });
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "mailto:a@b.c", "vscode://x"])
      await expect(open(url)).resolves.toEqual({
        status: "refused",
        reason: "scheme-not-allowed",
      });
    expect(bridge.invoked).toHaveLength(0);
  });

  it("forwards the normalized URL to the caller's own client", async () => {
    const bridge = fakeBridge();
    const { external } = makeProviders(bridge);
    await expect(
      external.invoke("open", { url: "HTTPS://Example.com" }, context, signal, metadata()),
    ).resolves.toEqual({
      status: "opened",
      url: "https://example.com/",
      opener: "desktop-shell",
    });
    expect(bridge.invoked).toEqual([
      {
        connectionId: "conn-1",
        apiId: "t3.client/external",
        method: "open",
        input: {
          target: { kind: "connection", connectionId: "conn-1" },
          url: "https://example.com/",
        },
      },
    ]);
  });
});

// Terminal URL links ignored "Open links in: in-app browser". The
// setting is client state, so openLink (1.1.0) reaches the caller's own
// client, which routes it; a 1.0.0 client keeps the system browser.
describe("1.1.0 openLink", () => {
  const seam = (external: string) =>
    fakeBridge({
      targets: [
        { connectionId: "conn-1", providers: [{ id: "t3.client/external", version: external }] },
      ],
    });
  const openLink = (bridge: ReturnType<typeof fakeBridge>, input: Record<string, unknown>) =>
    makeProviders(bridge).external.invoke("openLink", input as Json, context, signal, metadata());

  it("forwards the checked link and the modifier to a client that routes links", async () => {
    const current = seam("1.1.0");
    await openLink(current, { url: "HTTPS://Example.com" });
    await openLink(current, { url: "https://example.com/b", forceSystem: true });
    expect(current.invoked.map(({ method, input }) => ({ method, input }))).toEqual([
      {
        method: "openLink",
        input: {
          target: { kind: "connection", connectionId: "conn-1" },
          url: "https://example.com/",
        },
      },
      {
        method: "openLink",
        input: {
          target: { kind: "connection", connectionId: "conn-1" },
          url: "https://example.com/b",
          forceSystem: true,
        },
      },
    ]);
  });

  it("opens in the system browser on an older client and refuses bad URLs locally", async () => {
    const older = seam("1.0.0");
    await openLink(older, { url: "https://example.com/", forceSystem: true });
    expect(older.invoked.map(({ method, input }) => ({ method, input }))).toEqual([
      {
        method: "open",
        input: {
          target: { kind: "connection", connectionId: "conn-1" },
          url: "https://example.com/",
        },
      },
    ]);
    const current = seam("1.1.0");
    await expect(openLink(current, { url: "file:///etc/passwd" })).resolves.toEqual({
      status: "refused",
      reason: "scheme-not-allowed",
    });
    expect(current.invoked).toHaveLength(0);
  });
});

describe("editor adapter", () => {
  it("strictly validates legacy and workspace editor inputs on both API seams", () => {
    const ajv = new Ajv({ strict: true });
    const publicInput = uiEditorApi.definition.methods!.find(
      ({ name }) => name === "openPath",
    )!.inputSchema;
    const privateInput = CLIENT_PROVIDER_APIS.get("t3.client/editor")!.methods![0]!.inputSchema;
    for (const [schema, target] of [
      [publicInput, {}],
      [privateInput, { target: { kind: "self" } }],
    ] as const) {
      const validate = ajv.compile(schema);
      expect(validate({ ...target, path: "src/a.ts", cwd: "/repo" })).toBe(true);
      expect(validate({ ...target, path: "src/a.ts", workspace: true })).toBe(true);
      expect(validate({ ...target, path: "src/a.ts", cwd: "/ignored", workspace: true })).toBe(
        false,
      );
      expect(validate({ ...target, path: "src/a.ts" })).toBe(false);
      expect(validate({ ...target, path: "src/a.ts", workspace: false })).toBe(false);
    }
  });

  it("requires a remote-aware client before forwarding a workspace open", async () => {
    const input = { path: "src/app.ts", workspace: true };
    const old = fakeBridge({
      targets: [
        { connectionId: "conn-1", providers: [{ id: "t3.client/editor", version: "1.0.0" }] },
      ],
    });
    await expect(
      makeProviders(old).editor.invoke("openPath", input, context, signal, metadata()),
    ).rejects.toMatchObject({ code: "provider-rejected" });
    expect(old.invoked).toHaveLength(0);
    const current = fakeBridge();
    await makeProviders(current).editor.invoke("openPath", input, context, signal, metadata());
    expect(current.invoked[0]).toMatchObject({
      apiId: "t3.client/editor",
      method: "openPath",
      input: { path: "src/app.ts", workspace: true },
    });
  });
  it("hides workspace editor controls from old clients", async () => {
    const old = fakeBridge({
      targets: [
        { connectionId: "conn-1", providers: [{ id: "t3.client/editor", version: "1.0.0" }] },
      ],
    });
    await expect(
      makeProviders(old).editor.invoke("getCapabilities", {}, context, signal, metadata()),
    ).resolves.toMatchObject({ operations: { openPath: false } });
    expect(old.invoked).toHaveLength(0);
  });
  it("gets picker visibility and editor choices from the caller's own client", async () => {
    const current = fakeBridge();
    await expect(
      makeProviders(current).editor.invoke("getCapabilities", {}, context, signal, metadata()),
    ).resolves.toMatchObject({
      operations: { openPath: true },
      editor: {
        visible: true,
        preferredEditor: "vscode",
        editors: [{ id: "vscode", label: "VS Code" }],
      },
    });
    expect(current.invoked[0]).toMatchObject({
      connectionId: "conn-1",
      apiId: "t3.client/editor",
      method: "getCapabilities",
    });
  });
  it("forwards openPath to the caller's own client", async () => {
    const bridge = fakeBridge();
    const { editor } = makeProviders(bridge);
    await editor.invoke(
      "openPath",
      { path: "src/app.ts:3:5", cwd: "/ws/root" },
      context,
      signal,
      metadata(),
    );
    expect(bridge.invoked).toEqual([
      {
        connectionId: "conn-1",
        apiId: "t3.client/editor",
        method: "openPath",
        input: {
          target: { kind: "connection", connectionId: "conn-1" },
          path: "src/app.ts:3:5",
          cwd: "/ws/root",
        },
      },
    ]);
  });
});

describe("browser history adapter", () => {
  it("forwards each op to the caller's client under the context thread", async () => {
    const bridge = fakeBridge();
    const { history } = makeProviders(bridge);
    await history.invoke("record", { url: "https://example.com" }, context, signal, metadata());
    await history.invoke("list", {}, context, signal, metadata());
    expect(bridge.invoked).toEqual([
      {
        connectionId: "conn-1",
        apiId: "t3.client/browser-history",
        method: "record",
        input: {
          target: { kind: "connection", connectionId: "conn-1" },
          url: "https://example.com",
        },
      },
      {
        connectionId: "conn-1",
        apiId: "t3.client/browser-history",
        method: "list",
        input: { target: { kind: "connection", connectionId: "conn-1" } },
      },
    ]);
  });

  it("refuses a context without a thread before reaching a client", async () => {
    const bridge = fakeBridge();
    const { history } = makeProviders(bridge);
    const projectOnly = {
      ...context,
      resource: { ...context.resource, threadId: undefined },
    } as unknown as ViewContext;
    await expect(history.invoke("list", {}, projectOnly, signal, metadata())).rejects.toMatchObject(
      { code: "client-target-denied" },
    );
    await expect(history.invoke("clear", {}, context, signal, metadata())).rejects.toMatchObject({
      code: "client-provider-unavailable",
    });
    expect(bridge.invoked).toHaveLength(0);
  });
});

describe("navigation adapter", () => {
  it("refuses unknown and cross-project threads without reaching a client", async () => {
    const bridge = fakeBridge();
    const { navigation } = makeProviders(bridge);
    const open = (threadId: string) =>
      navigation.invoke("openThread", { threadId }, context, signal, metadata());
    await expect(open("thread-gone")).resolves.toEqual({
      status: "refused",
      reason: "unknown-thread",
    });
    await expect(open("thread-other")).resolves.toEqual({
      status: "refused",
      reason: "out-of-scope",
    });
    // A context without a project scope has no thread it may steer to.
    const unscoped = {
      ...context,
      resource: { namespace: "t3.extensions", id: "ext.a", environmentId: ENV },
    } as ViewContext;
    await expect(
      navigation.invoke("openThread", { threadId: "thread-b" }, unscoped, signal, metadata()),
    ).resolves.toEqual({ status: "refused", reason: "out-of-scope" });
    expect(bridge.invoked).toHaveLength(0);
  });

  it("forwards a same-project thread and surface to the caller's own client", async () => {
    const bridge = fakeBridge();
    const { navigation } = makeProviders(bridge);
    await expect(
      navigation.invoke(
        "openThread",
        { threadId: "thread-b", surfaceId: "ext.a/view" },
        context,
        signal,
        metadata(),
      ),
    ).resolves.toEqual({ status: "opened", threadId: "thread-b" });
    expect(bridge.invoked).toEqual([
      {
        connectionId: "conn-1",
        apiId: "t3.client/navigation",
        method: "openThread",
        input: {
          target: { kind: "connection", connectionId: "conn-1" },
          threadId: "thread-b",
          surfaceId: "ext.a/view",
        },
      },
    ]);
  });

  it("reports openThread availability through getCapabilities", async () => {
    const { navigation } = makeProviders(fakeBridge());
    await expect(
      navigation.invoke("getCapabilities", {}, context, signal, metadata()),
    ).resolves.toMatchObject({
      adapter: "host.ui.navigation",
      operations: { openThread: true, openAgentSession: true, openFile: true },
    });
  });

  it("resolves an agent's session URL on the caller's own thread and forwards only that", async () => {
    const bridge = fakeBridge();
    const { navigation } = makeProviders(bridge);
    await expect(
      navigation.invoke("openAgentSession", { agentId: "workflow-1" }, context, signal, metadata()),
    ).resolves.toEqual({ status: "opened", agentId: "workflow-1", opener: "desktop-shell" });
    expect(bridge.invoked).toEqual([
      {
        connectionId: "conn-1",
        apiId: "t3.client/navigation",
        method: "openSession",
        input: {
          target: { kind: "connection", connectionId: "conn-1" },
          agentId: "workflow-1",
          url: "https://claude.ai/code/session_1",
        },
      },
    ]);
  });

  it("refuses unknown agents, sessionless rows, and non-http URLs before any client frame", async () => {
    const bridge = fakeBridge();
    const { navigation } = makeProviders(bridge);
    const open = (agentId: string, ctx: ViewContext = context) =>
      navigation.invoke("openAgentSession", { agentId }, ctx, signal, metadata());
    await expect(open("nobody")).resolves.toEqual({ status: "refused", reason: "unknown-agent" });
    await expect(open("task-1")).resolves.toEqual({ status: "refused", reason: "no-session" });
    await expect(open("task-bad")).resolves.toEqual({ status: "refused", reason: "no-session" });
    // The session is looked up on the context thread only; a deleted thread or
    // a context without one has no roster to open from.
    const otherThread = {
      ...context,
      resource: { ...context.resource, threadId: "thread-b" },
    } as ViewContext;
    await expect(open("workflow-1", otherThread)).resolves.toEqual({
      status: "refused",
      reason: "unknown-thread",
    });
    const { threadId: _dropped, ...unthreaded } = context.resource;
    await expect(
      open("workflow-1", { ...context, resource: unthreaded } as ViewContext),
    ).resolves.toEqual({ status: "refused", reason: "unknown-thread" });
    expect(bridge.invoked).toHaveLength(0);
  });
});

describe("navigation adapter openFile", () => {
  const openFile = (input: Record<string, unknown>, ctx: ViewContext = context) =>
    makeProviders(bridge).navigation.invoke("openFile", input as Json, ctx, signal, metadata());
  let bridge = fakeBridge();

  it("forwards a workspace path to the caller's own client for its context thread", async () => {
    bridge = fakeBridge();
    await expect(openFile({ relativePath: "src/app.ts", line: 12 })).resolves.toEqual({
      status: "opened",
      relativePath: "src/app.ts",
    });
    expect(bridge.invoked).toEqual([
      {
        connectionId: "conn-1",
        apiId: "t3.client/navigation",
        method: "openFile",
        input: {
          target: { kind: "connection", connectionId: "conn-1" },
          relativePath: "src/app.ts",
          line: 12,
        },
      },
    ]);
  });

  it("refuses unsafe paths and foreign or missing threads before any client frame", async () => {
    bridge = fakeBridge();
    for (const relativePath of ["../secret", "/etc/passwd", "a//b", "a\\b", "src/../x"])
      await expect(openFile({ relativePath })).resolves.toEqual({
        status: "refused",
        reason: "invalid-path",
      });
    const { threadId: _dropped, ...unthreaded } = context.resource;
    await expect(
      openFile({ relativePath: "a.ts" }, { ...context, resource: unthreaded } as ViewContext),
    ).resolves.toEqual({ status: "refused", reason: "unknown-thread" });
    await expect(
      openFile({ relativePath: "a.ts" }, {
        ...context,
        resource: { ...context.resource, threadId: "thread-other" },
      } as ViewContext),
    ).resolves.toEqual({ status: "refused", reason: "out-of-scope" });
    expect(bridge.invoked).toHaveLength(0);
  });
});

// openFile and renderBrowserFile are 1.1.0
// additions to the client seam. A client still on 1.0.0 never sees a frame it
// cannot validate, and an older server never gets a field it would reject.
describe("1.1.0 client seam additions", () => {
  const seam = (navigation: string, preferences: string) =>
    fakeBridge({
      targets: [
        {
          connectionId: "conn-1",
          providers: [
            { id: "t3.client/navigation", version: navigation },
            { id: "t3.client/preferences", version: preferences },
          ],
        },
      ],
    });

  it("refuses openFile for a client whose navigation predates it", async () => {
    const bridge = seam("1.0.0", "1.0.0");
    await expect(
      makeProviders(bridge).navigation.invoke(
        "openFile",
        { relativePath: "a.ts" } as Json,
        context,
        signal,
        metadata(),
      ),
    ).rejects.toMatchObject({ code: "provider-rejected" });
    expect(bridge.invoked).toHaveLength(0);
  });

  it("asks only a 1.1.0 client for renderBrowserFile", async () => {
    const drain = async (preferences: HostApiProvider) => {
      for await (const _event of preferences.subscribe!(
        "subscribePreferences",
        {},
        context,
        signal,
        metadata(),
      ));
    };
    const inputs = async (version: string) => {
      const bridge = seam("1.1.0", version);
      const { preferences } = makeProviders(bridge);
      await preferences.invoke("getPreferences", {} as Json, context, signal, metadata());
      await preferences.invoke(
        "setPreferences",
        { wordWrap: true } as Json,
        context,
        signal,
        metadata(),
      );
      await drain(preferences);
      return [
        ...bridge.invoked.map(({ input }) => (input as { include?: unknown }).include),
        ...bridge.subscribed.map(({ input }) => (input as { include?: unknown }).include),
      ];
    };
    expect(await inputs("1.1.0")).toEqual([
      ["renderBrowserFile"],
      ["renderBrowserFile"],
      ["renderBrowserFile"],
    ]);
    expect(await inputs("1.0.0")).toEqual([undefined, undefined, undefined]);
  });

  it("refuses a renderBrowserFile write to a client that predates it", async () => {
    const bridge = seam("1.1.0", "1.0.0");
    await expect(
      makeProviders(bridge).preferences.invoke(
        "setPreferences",
        { renderBrowserFile: false } as Json,
        context,
        signal,
        metadata(),
      ),
    ).rejects.toMatchObject({ code: "provider-rejected" });
    expect(bridge.invoked).toHaveLength(0);
  });

  // An unlisted version is not a current one.
  it("treats a client that lists no version as predating the additions", async () => {
    const bridge = fakeBridge({ targets: [{ connectionId: "conn-1", providers: [] }] });
    const { navigation, preferences } = makeProviders(bridge);
    await expect(
      navigation.invoke("openFile", { relativePath: "a.ts" } as Json, context, signal, metadata()),
    ).rejects.toMatchObject({ code: "provider-rejected" });
    await preferences.invoke("getPreferences", {} as Json, context, signal, metadata());
    // Only the read went out, and it asked for no 1.1.0 key.
    expect(
      bridge.invoked.map(({ method, input }) => [method, (input as { include?: unknown }).include]),
    ).toEqual([["getPreferences", undefined]]);
  });
});

// The file explorer choice is a 1.2.0
// preference; a 1.1.0 client is asked only for what it knows.
describe("1.2.0 file explorer preference", () => {
  const seam = (preferences: string) =>
    fakeBridge({
      targets: [
        {
          connectionId: "conn-1",
          providers: [{ id: "t3.client/preferences", version: preferences }],
        },
      ],
    });

  it("asks only a 1.2.0 client for fileExplorerOpen", async () => {
    const includes = async (version: string) => {
      const bridge = seam(version);
      const { preferences } = makeProviders(bridge);
      await preferences.invoke("getPreferences", {} as Json, context, signal, metadata());
      await Promise.resolve(
        preferences.invoke(
          "setPreferences",
          { fileExplorerOpen: false } as Json,
          context,
          signal,
          metadata(),
        ),
      ).catch(() => {});
      for await (const _event of preferences.subscribe!(
        "subscribePreferences",
        {},
        context,
        signal,
        metadata(),
      ));
      return [
        ...bridge.invoked.map(({ input }) => (input as { include?: unknown }).include),
        ...bridge.subscribed.map(({ input }) => (input as { include?: unknown }).include),
      ];
    };
    const both = ["renderBrowserFile", "fileExplorerOpen"];
    expect(await includes("1.2.0")).toEqual([both, both, both]);
    // The write never reaches a client that predates the key.
    expect(await includes("1.1.0")).toEqual([["renderBrowserFile"], ["renderBrowserFile"]]);
  });

  it("refuses a fileExplorerOpen write to a client that predates it", async () => {
    const bridge = seam("1.1.0");
    await expect(
      makeProviders(bridge).preferences.invoke(
        "setPreferences",
        { fileExplorerOpen: false } as Json,
        context,
        signal,
        metadata(),
      ),
    ).rejects.toMatchObject({ code: "provider-rejected" });
    expect(bridge.invoked).toHaveLength(0);
  });
});

// Whether the invoking client has a preview
// browser is its own answer, asked only of a 1.2.0 navigation client.
describe("1.2.0 preview-browser capability", () => {
  const seam = (navigation: string) =>
    fakeBridge({
      targets: [
        {
          connectionId: "conn-1",
          providers: [{ id: "t3.client/navigation", version: navigation }],
        },
      ],
    });

  it("reports the invoking client's answer, and false for an older client", async () => {
    const operations = async (version: string) => {
      const bridge = seam(version);
      const answer = (await makeProviders(bridge).navigation.invoke(
        "getCapabilities",
        {} as Json,
        context,
        signal,
        metadata(),
      )) as { operations: Record<string, boolean> };
      return {
        openFileInBrowser: answer.operations.openFileInBrowser,
        asked: bridge.invoked.map(({ method }) => method),
      };
    };
    expect(await operations("1.2.0")).toEqual({
      openFileInBrowser: true,
      asked: ["getCapabilities"],
    });
    expect(await operations("1.1.0")).toEqual({ openFileInBrowser: false, asked: [] });
  });
});

// Native parity ("Open file in preview browser"): openIn is a 1.2.0 addition
// to the client seam; a 1.1.0 client still opens files in the panel.
describe("1.2.0 openFile in the preview browser", () => {
  const seam = (navigation: string) =>
    fakeBridge({
      targets: [
        {
          connectionId: "conn-1",
          providers: [{ id: "t3.client/navigation", version: navigation }],
        },
      ],
    });
  const open = (bridge: ReturnType<typeof fakeBridge>, input: Record<string, unknown>) =>
    makeProviders(bridge).navigation.invoke("openFile", input as Json, context, signal, metadata());

  it("forwards openIn only to a client that has it", async () => {
    const current = seam("1.2.0");
    await open(current, { relativePath: "site/index.html", openIn: "browser" });
    expect(current.invoked.map(({ input }) => input)).toEqual([
      {
        target: { kind: "connection", connectionId: "conn-1" },
        relativePath: "site/index.html",
        openIn: "browser",
      },
    ]);
    const older = seam("1.1.0");
    await expect(
      open(older, { relativePath: "site/index.html", openIn: "browser" }),
    ).rejects.toMatchObject({ code: "provider-rejected" });
    expect(older.invoked).toHaveLength(0);
    await open(older, { relativePath: "a.ts", openIn: "panel" });
    expect(older.invoked.map(({ input }) => input)).toEqual([
      { target: { kind: "connection", connectionId: "conn-1" }, relativePath: "a.ts" },
    ]);
  });
});

describe("keybindings adapter", () => {
  it("rejects global commands locally when the global grant is missing", async () => {
    const bridge = fakeBridge();
    const { keybindings } = makeProviders(bridge, () => Promise.resolve(false));
    const result = (await keybindings.invoke(
      "registerCommands",
      {
        commands: [
          { id: "local", title: "Local", scope: "surface" },
          { id: "global", title: "Global", scope: "global" },
        ],
      } as unknown as Json,
      context,
      signal,
      metadata(),
    )) as { commandSetToken: string; results: { commandId: string; status: string }[] };
    // The legal command still forwarded; the global one rejected locally.
    const forwarded = bridge.invoked[0]!;
    expect(forwarded.apiId).toBe("t3.client/keybindings");
    expect((forwarded.input as { commands: { id: string }[] }).commands.map((c) => c.id)).toEqual([
      "local",
    ]);
    expect(result.results).toContainEqual(
      expect.objectContaining({ commandId: "global", status: "rejected" }),
    );
  });

  it("forwards nothing when every command is rejected", async () => {
    const bridge = fakeBridge();
    const { keybindings } = makeProviders(bridge, () => Promise.resolve(false));
    await keybindings.invoke(
      "registerCommands",
      { commands: [{ id: "global", title: "G", scope: "global" }] } as unknown as Json,
      context,
      signal,
      metadata(),
    );
    expect(bridge.invoked).toHaveLength(0);
  });

  it("resolves unregister for a fully-rejected set without a client roundtrip", async () => {
    const bridge = fakeBridge();
    const { keybindings } = makeProviders(bridge, () => Promise.resolve(false));
    const registered = (await keybindings.invoke(
      "registerCommands",
      { commands: [{ id: "global", title: "G", scope: "global" }] } as unknown as Json,
      context,
      signal,
      metadata(),
    )) as { commandSetToken: string };
    expect(registered.commandSetToken).toMatch(/^cmdset-/);
    const result = (await keybindings.invoke(
      "unregisterCommands",
      { commandSetToken: registered.commandSetToken } as unknown as Json,
      context,
      signal,
      metadata(),
    )) as { unregistered: boolean };
    expect(result.unregistered).toBe(true);
    expect(bridge.invoked).toHaveLength(0);
  });
});

describe("capability directory", () => {
  const targets = [
    { connectionId: "conn-a", providers: {} },
    { connectionId: "conn-b", providers: {} },
  ];
  const principal = (kind: HostApiPrincipal["kind"], id: string): HostApiPrincipal => ({
    kind,
    id,
    environmentId: ENV,
    scopes: [],
  });

  it("scopes the client directory to the caller's principal", async () => {
    const bridge = fakeBridge({
      targets,
      sessionConnections: { "sess-1": ["conn-a"] },
    });
    const { theme } = makeProviders(bridge);
    const host = (await theme.invoke("getCapabilities", {}, context, signal, metadata())) as {
      clients: { connectionId: string }[];
    };
    expect(host.clients.map((client) => client.connectionId)).toEqual(["conn-a", "conn-b"]);

    const own = (await theme.invoke(
      "getCapabilities",
      {},
      context,
      signal,
      metadata("ext.a", principal("environment-session", "sess-1")),
    )) as { clients: { connectionId: string }[] };
    expect(own.clients.map((client) => client.connectionId)).toEqual(["conn-a"]);

    const none = (await theme.invoke(
      "getCapabilities",
      {},
      context,
      signal,
      metadata("ext.a", principal("provider-session", "prov-1")),
    )) as { clients: unknown[]; operations: Record<string, boolean> };
    expect(none.clients).toHaveLength(0);
    // Provider-session callers see the contract shape but no reachable ops.
    expect(Object.values(none.operations).every((op) => op === false)).toBe(true);
  });
});

describe("notifications adapter", () => {
  const notifyInput = (extra?: Record<string, unknown>) =>
    ({ severity: "info", title: "Build done", ...extra }) as unknown as Json;

  it("mints the id, registers an outcome correlation, and forwards the nested shape", async () => {
    const bridge = fakeBridge();
    const { notifications } = makeProviders(bridge);
    const result = (await notifications.invoke(
      "notify",
      notifyInput(),
      context,
      signal,
      metadata(),
    )) as { notificationId: string };
    expect(result.notificationId).toMatch(/^ntf-/);
    const forwarded = bridge.invoked[0]!;
    expect(forwarded.apiId).toBe("t3.client/notifications");
    expect(forwarded.method).toBe("notify");
    expect(forwarded.input).toMatchObject({
      notification: { notificationId: result.notificationId, severity: "info" },
    });
    expect(bridge.correlations.has(result.notificationId)).toBe(true);
  });

  it("resolves a pending awaitAction when the outcome arrives", async () => {
    const bridge = fakeBridge();
    const { notifications } = makeProviders(bridge);
    const { notificationId } = (await notifications.invoke(
      "notify",
      notifyInput(),
      context,
      signal,
      metadata(),
    )) as { notificationId: string };
    const action = notifications.invoke(
      "awaitAction",
      { notificationId } as unknown as Json,
      context,
      signal,
      metadata(),
    );
    bridge.correlations.get(notificationId)!.deliver({
      type: "notificationOutcome",
      outcome: { actionId: "open" },
    });
    await expect(action).resolves.toEqual({ actionId: "open" });
    // Settled outcomes release their correlation.
    expect(bridge.correlations.has(notificationId)).toBe(false);
  });

  it("reports keepOpen clicks without settling, queuing clicks nobody awaited", async () => {
    const bridge = fakeBridge();
    const { notifications } = makeProviders(bridge);
    const { notificationId } = (await notifications.invoke(
      "notify",
      notifyInput({ actions: [{ id: "copy-path", label: "Copy path", keepOpen: true }] }),
      context,
      signal,
      metadata(),
    )) as { notificationId: string };
    const awaitAction = () =>
      notifications.invoke(
        "awaitAction",
        { notificationId } as unknown as Json,
        context,
        signal,
        metadata(),
      );
    const deliver = bridge.correlations.get(notificationId)!.deliver;
    const first = awaitAction();
    deliver({ type: "notificationAction", actionId: "copy-path" });
    await expect(first).resolves.toEqual({ actionId: "copy-path" });
    // Still live: a click between awaits is queued, and update still reaches the toast.
    deliver({ type: "notificationAction", actionId: "copy-path" });
    await expect(awaitAction()).resolves.toEqual({ actionId: "copy-path" });
    await expect(
      notifications.invoke(
        "update",
        {
          notificationId,
          flashAction: { actionId: "copy-path", label: "Copied!", durationMs: 2000 },
        } as unknown as Json,
        context,
        signal,
        metadata(),
      ),
    ).resolves.toEqual({ applied: true });
    expect(bridge.invoked.at(-1)).toMatchObject({
      method: "update",
      input: { patch: { flashAction: { actionId: "copy-path", label: "Copied!" } } },
    });
    const last = awaitAction();
    deliver({ type: "notificationOutcome", outcome: { dismissed: true } });
    await expect(last).resolves.toEqual({ dismissed: true });
    expect(bridge.correlations.has(notificationId)).toBe(false);
  });

  it("drains clicks queued before the toast closed ahead of the final outcome", async () => {
    const bridge = fakeBridge();
    const { notifications } = makeProviders(bridge);
    const { notificationId } = (await notifications.invoke(
      "notify",
      notifyInput({
        actions: [
          { id: "copy-path", label: "Copy path", keepOpen: true },
          { id: "reveal", label: "Reveal", keepOpen: true },
        ],
      }),
      context,
      signal,
      metadata(),
    )) as { notificationId: string };
    const awaitAction = () =>
      notifications.invoke(
        "awaitAction",
        { notificationId } as unknown as Json,
        context,
        signal,
        metadata(),
      );
    const deliver = bridge.correlations.get(notificationId)!.deliver;
    // Both clicks and the close land before the plugin's next await round-trip.
    deliver({ type: "notificationAction", actionId: "copy-path" });
    deliver({ type: "notificationAction", actionId: "reveal" });
    deliver({ type: "notificationOutcome", outcome: { dismissed: true } });
    await expect(awaitAction()).resolves.toEqual({ actionId: "copy-path" });
    await expect(awaitAction()).resolves.toEqual({ actionId: "reveal" });
    await expect(awaitAction()).resolves.toEqual({ dismissed: true });
    await expect(awaitAction()).resolves.toEqual({ dismissed: true });
  });

  it("keeps queued clicks when an API dismiss settles before its response returns", async () => {
    const bridge = fakeBridge();
    const { notifications } = makeProviders(bridge);
    const { notificationId } = (await notifications.invoke(
      "notify",
      notifyInput({
        actions: [
          { id: "copy-path", label: "Copy path", keepOpen: true },
          { id: "reveal", label: "Reveal", keepOpen: true },
        ],
      }),
      context,
      signal,
      metadata(),
    )) as { notificationId: string };
    const awaitAction = () =>
      notifications.invoke(
        "awaitAction",
        { notificationId } as unknown as Json,
        context,
        signal,
        metadata(),
      );
    const deliver = bridge.correlations.get(notificationId)!.deliver;
    deliver({ type: "notificationAction", actionId: "copy-path" });
    deliver({ type: "notificationAction", actionId: "reveal" });
    // The web client settles inside its dismiss handler, so the outcome event
    // can reach the server before the dismiss response does.
    const invoke = bridge.service.invoke;
    vi.spyOn(bridge.service, "invoke").mockImplementation((request) => {
      if (request.method === "dismiss")
        deliver({ type: "notificationOutcome", outcome: { dismissed: true } });
      return invoke(request);
    });
    await expect(
      notifications.invoke(
        "dismiss",
        { notificationId } as unknown as Json,
        context,
        signal,
        metadata(),
      ),
    ).resolves.toEqual({ dismissed: true });
    await expect(awaitAction()).resolves.toEqual({ actionId: "copy-path" });
    await expect(awaitAction()).resolves.toEqual({ actionId: "reveal" });
    await expect(awaitAction()).resolves.toEqual({ dismissed: true });
  });

  it("names the gap when the client predates keepOpen and flashAction", async () => {
    const bridge = fakeBridge({
      targets: [
        {
          connectionId: "conn-1",
          providers: [{ id: "t3.client/notifications", version: "1.0.0" }],
        },
      ],
    });
    const { notifications } = makeProviders(bridge);
    await expect(
      notifications.invoke(
        "notify",
        notifyInput({ actions: [{ id: "copy", label: "Copy", keepOpen: true }] }),
        context,
        signal,
        metadata(),
      ),
    ).rejects.toMatchObject({ code: "provider-rejected" });
    const { notificationId } = (await notifications.invoke(
      "notify",
      notifyInput({ actions: [{ id: "copy", label: "Copy" }] }),
      context,
      signal,
      metadata(),
    )) as { notificationId: string };
    await expect(
      notifications.invoke(
        "update",
        {
          notificationId,
          flashAction: { actionId: "copy", label: "Copied!", durationMs: 2000 },
        } as unknown as Json,
        context,
        signal,
        metadata(),
      ),
    ).rejects.toMatchObject({ code: "provider-rejected" });
  });

  it("withholds a retained outcome from a foreign installation", async () => {
    const bridge = fakeBridge();
    const { notifications } = makeProviders(bridge);
    const { notificationId } = (await notifications.invoke(
      "notify",
      notifyInput(),
      context,
      signal,
      metadata(),
    )) as { notificationId: string };
    bridge.correlations.get(notificationId)!.deliver({
      type: "notificationOutcome",
      outcome: { actionId: "apply" },
    });
    // The outcome is retained, but only the owning installation may read it.
    await expect(
      notifications.invoke(
        "awaitAction",
        { notificationId } as unknown as Json,
        context,
        signal,
        metadata("ext.b"),
      ),
    ).rejects.toMatchObject({ code: "notification-owner-mismatch" });
    await expect(
      notifications.invoke(
        "awaitAction",
        { notificationId } as unknown as Json,
        context,
        signal,
        metadata(),
      ),
    ).resolves.toEqual({ actionId: "apply" });
  });

  it("resolves awaitAction from the retained outcome after settlement", async () => {
    const bridge = fakeBridge();
    const { notifications } = makeProviders(bridge);
    const { notificationId } = (await notifications.invoke(
      "notify",
      notifyInput(),
      context,
      signal,
      metadata(),
    )) as { notificationId: string };
    bridge.correlations.get(notificationId)!.deliver({
      type: "notificationOutcome",
      outcome: { actionId: "apply" },
    });
    // The notification already settled — a late awaitAction still resolves.
    await expect(
      notifications.invoke(
        "awaitAction",
        { notificationId } as unknown as Json,
        context,
        signal,
        metadata(),
      ),
    ).resolves.toEqual({ actionId: "apply" });
  });

  it("records an API dismiss as the settled outcome", async () => {
    const bridge = fakeBridge();
    const { notifications } = makeProviders(bridge);
    const { notificationId } = (await notifications.invoke(
      "notify",
      notifyInput(),
      context,
      signal,
      metadata(),
    )) as { notificationId: string };
    await notifications.invoke(
      "dismiss",
      { notificationId } as unknown as Json,
      context,
      signal,
      metadata(),
    );
    await expect(
      notifications.invoke(
        "awaitAction",
        { notificationId } as unknown as Json,
        context,
        signal,
        metadata(),
      ),
    ).resolves.toEqual({ dismissed: true });
  });

  it("enforces owner-only management and expires unknown ids", async () => {
    const bridge = fakeBridge();
    const { notifications } = makeProviders(bridge);
    const { notificationId } = (await notifications.invoke(
      "notify",
      notifyInput(),
      context,
      signal,
      metadata(),
    )) as { notificationId: string };
    await expect(
      notifications.invoke(
        "dismiss",
        { notificationId } as unknown as Json,
        context,
        signal,
        metadata("ext.b"),
      ),
    ).rejects.toMatchObject({ code: "notification-owner-mismatch" });
    await expect(
      notifications.invoke(
        "awaitAction",
        { notificationId } as unknown as Json,
        context,
        signal,
        metadata("ext.b"),
      ),
    ).rejects.toMatchObject({ code: "notification-owner-mismatch" });
    await expect(
      notifications.invoke(
        "dismiss",
        { notificationId: "ntf-ghost" } as unknown as Json,
        context,
        signal,
        metadata(),
      ),
    ).rejects.toMatchObject({ code: "notification-expired" });
    // A settled notification is expired for management but retained for awaitAction.
    bridge.correlations.get(notificationId)!.deliver({
      type: "notificationOutcome",
      outcome: { dismissed: true },
    });
    await expect(
      notifications.invoke(
        "update",
        { notificationId, patch: { title: "late" } } as unknown as Json,
        context,
        signal,
        metadata(),
      ),
    ).rejects.toMatchObject({ code: "notification-expired" });
  });
});

describe("notification connection ownership", () => {
  it("another connection cannot await a retained outcome", async () => {
    const bridge = fakeBridge();
    const { notifications } = makeProviders(bridge);
    const owner = { ...metadata(), clientConnectionId: "conn-a" };
    const { notificationId } = (await notifications.invoke(
      "notify",
      { severity: "info", title: "x" },
      context,
      signal,
      owner,
    )) as { notificationId: string };
    bridge.correlations.get(notificationId)!.deliver({
      type: "notificationOutcome",
      outcome: { actionId: "yes" },
    });
    await expect(
      notifications.invoke("awaitAction", { notificationId }, context, signal, {
        ...metadata(),
        clientConnectionId: "conn-b",
      }),
    ).rejects.toBeDefined();
  });

  it("a provider-session cannot await a retained outcome", async () => {
    const bridge = fakeBridge();
    const { notifications } = makeProviders(bridge);
    const { notificationId } = (await notifications.invoke(
      "notify",
      { severity: "info", title: "x" },
      context,
      signal,
      { ...metadata(), clientConnectionId: "conn-a" },
    )) as { notificationId: string };
    bridge.correlations.get(notificationId)!.deliver({
      type: "notificationOutcome",
      outcome: { actionId: "yes" },
    });
    await expect(
      notifications.invoke(
        "awaitAction",
        { notificationId },
        context,
        signal,
        metadata("ext.a", {
          kind: "provider-session",
          id: "provider",
          environmentId: ENV,
          scopes: [],
        }),
      ),
    ).rejects.toBeDefined();
  });
});

it("an ordinary view registration is not installation-scoped", async () => {
  const bridge = fakeBridge();
  const { keybindings } = makeProviders(bridge);
  await keybindings.invoke(
    "registerCommands",
    {
      commands: [
        {
          id: "open",
          title: "Open",
          scope: "global",
          activation: { surfaceId: "ext.a/panel", placement: "side-panel" },
        },
      ],
    },
    {
      ...context,
      resource: { ...context.resource, namespace: "ext.a", id: "ext.a/panel" },
    },
    signal,
    metadata(),
  );
  expect(bridge.invoked[0]?.input).not.toMatchObject({ installationScoped: true });
});

it("notification retention cap is per connection", async () => {
  const bridge = fakeBridge();
  const { notifications } = makeProviders(bridge);
  const settle = async (conn: string) => {
    const meta = { ...metadata(), clientConnectionId: conn };
    const result = (await notifications.invoke(
      "notify",
      { title: "x", severity: "info" },
      context,
      signal,
      meta,
    )) as { notificationId: string };
    bridge.correlations.get(result.notificationId)!.deliver({
      type: "notificationOutcome",
      outcome: { actionId: "yes" },
    });
    return result.notificationId;
  };
  const id = await settle("conn-a");
  for (let i = 0; i < 257; i++) await settle("conn-b");
  await expect(
    notifications.invoke("awaitAction", { notificationId: id }, context, signal, {
      ...metadata(),
      clientConnectionId: "conn-a",
    }),
  ).resolves.toEqual({ actionId: "yes" });
});
