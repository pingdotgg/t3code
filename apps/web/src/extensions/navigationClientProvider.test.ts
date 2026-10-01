import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, type ClientProviderCaller } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { CLIENT_PROVIDER_APIS } from "@t3tools/extension-sdk/clientProviders";
import {
  CLIENT_PROVIDER_DESCRIPTORS,
  createNavigationClientProvider,
  type ExternalOpener,
} from "./clientProviders";
import { ClientProviderOpError, type ClientProviderInvokeCall } from "./clientProviderTypes";
import type { InstalledPackage } from "./installedController";

const shells = vi.hoisted(
  () => new Map<string, { projectId: string; worktreePath: string | null }>(),
);
vi.mock("../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/entities")>()),
  readThreadShell: (ref: { threadId: string }) => shells.get(ref.threadId) ?? null,
  readProject: (ref: { projectId: string }) =>
    ref.projectId.startsWith("project-") ? { workspaceRoot: `/work/${ref.projectId}` } : null,
}));
vi.mock("../components/ThreadTerminalDrawer", () => ({ terminalThemeFromApp: () => ({}) }));

const ENV = "env-a";
const INSTALL = "ext.a";
const VIEW = `${INSTALL}/view`;
const GRANT = "t3.ui/navigation.open";

const caller: ClientProviderCaller = {
  installationId: INSTALL,
  contentHash: "hash-a",
  installationGeneration: 1,
};

const context: ViewContext = {
  client: "web",
  resource: {
    namespace: INSTALL,
    id: VIEW,
    environmentId: ENV,
    projectId: "project-a",
    threadId: "thread-a",
  },
};

function installation(capabilities: readonly string[]): InstalledPackage {
  const surface = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    title: id,
    placements: ["side-panel"],
    clients: ["web", "desktop"],
    scope: "thread",
    capabilities: [],
    stateVersion: 1,
    ...overrides,
  });
  return {
    id: INSTALL,
    contentHash: "hash-a",
    enabled: true,
    installationGeneration: 1,
    grants: {
      capabilities: [...capabilities],
      projectIds: [ProjectId.make("project-a"), ProjectId.make("project-b")],
    },
    package: {
      manifest: {
        id: INSTALL,
        apiVersion: 1,
        version: "1.0.0",
        surfaces: [
          surface(VIEW),
          surface(`${INSTALL}/dock`, { placements: ["bottom-dock"] }),
          surface(`${INSTALL}/project`, { scope: "project" }),
          surface(`${INSTALL}/desktop`, { clients: ["desktop"] }),
        ],
      },
    },
  } as unknown as InstalledPackage;
}

function provider(
  capabilities: readonly string[] = [GRANT],
  opener: ExternalOpener | undefined = undefined,
  previewFile: (...args: unknown[]) => Promise<unknown> = async () => "opened",
  previewSupported = true,
) {
  const navigate = vi.fn(async () => {});
  const installed = installation(capabilities);
  return {
    navigate,
    provider: createNavigationClientProvider(
      {
        environmentId: EnvironmentId.make(ENV),
        client: "web",
        emit: vi.fn(),
        installations: () => [installed],
      },
      navigate,
      () => opener,
      previewFile as never,
      () => previewSupported,
    ),
  };
}

const openThread = (input: Record<string, unknown>): ClientProviderInvokeCall => ({
  method: "openThread",
  input: { target: { kind: "self" }, ...input } as ClientProviderInvokeCall["input"],
  context,
  caller,
  signal: new AbortController().signal,
});

describe("navigation provider", () => {
  beforeEach(() => {
    shells.clear();
    shells.set("thread-a", { projectId: "project-a", worktreePath: null });
    shells.set("thread-b", { projectId: "project-a", worktreePath: "/work/tree-b" });
    shells.set("thread-other", { projectId: "project-b", worktreePath: null });
  });

  it("rejects callers without the navigation grant before routing", async () => {
    const { provider: denied, navigate } = provider([]);
    await expect(denied.invoke(openThread({ threadId: "thread-b" }))).rejects.toBeInstanceOf(
      ClientProviderOpError,
    );
    await expect(denied.invoke(openThread({ threadId: "thread-b" }))).rejects.toMatchObject({
      code: "client-target-denied",
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("refuses unknown and cross-project threads by name, even when both are granted", async () => {
    const { provider: granted, navigate } = provider();
    await expect(granted.invoke(openThread({ threadId: "thread-gone" }))).resolves.toEqual({
      status: "refused",
      reason: "unknown-thread",
    });
    await expect(granted.invoke(openThread({ threadId: "thread-other" }))).resolves.toEqual({
      status: "refused",
      reason: "out-of-scope",
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("only opens the caller's own thread-scoped side-panel surfaces for this client", async () => {
    const { provider: granted, navigate } = provider();
    for (const surfaceId of [
      "other.ext/view",
      `${INSTALL}/missing`,
      `${INSTALL}/dock`,
      `${INSTALL}/project`,
      `${INSTALL}/desktop`,
    ])
      await expect(
        granted.invoke(openThread({ threadId: "thread-b", surfaceId })),
      ).resolves.toEqual({ status: "refused", reason: "surface-not-found" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("routes to a same-project thread", async () => {
    const { provider: granted, navigate } = provider();
    await expect(granted.invoke(openThread({ threadId: "thread-b" }))).resolves.toEqual({
      status: "opened",
      threadId: "thread-b",
    });
    expect(navigate).toHaveBeenCalledWith(
      scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-b")),
    );
  });

  it("opens the caller's surface on the target thread before routing there", async () => {
    const { provider: granted, navigate } = provider();
    const ref = scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-b"));
    navigate.mockImplementation(async () => {
      // The panel is already in place when the route renders.
      const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
      expect(
        panel.surfaces.some(
          (surface) => surface.kind === "extension" && surface.record.surfaceId === VIEW,
        ),
      ).toBe(true);
    });
    await expect(
      granted.invoke(openThread({ threadId: "thread-b", surfaceId: VIEW })),
    ).resolves.toEqual({ status: "opened", threadId: "thread-b", surfaceId: VIEW });
    expect(navigate).toHaveBeenCalledOnce();
    const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
    const opened = panel.surfaces.find(
      (surface) => surface.kind === "extension" && surface.record.surfaceId === VIEW,
    );
    expect(opened?.kind === "extension" && opened.record.context.resource).toMatchObject({
      namespace: INSTALL,
      id: VIEW,
      projectId: "project-a",
      threadId: "thread-b",
    });
  });

  describe("openSession", () => {
    const SESSION_GRANT = "t3.ui/navigation.open-session";
    const openSession = (url: string): ClientProviderInvokeCall => ({
      method: "openSession",
      input: {
        target: { kind: "self" },
        agentId: "workflow-1",
        url,
      } as ClientProviderInvokeCall["input"],
      context,
      caller,
      signal: new AbortController().signal,
    });

    it("needs its own grant; thread navigation does not carry it", async () => {
      const open = vi.fn(async () => {});
      const { provider: denied } = provider([GRANT], { kind: "browser-window", open });
      await expect(denied.invoke(openSession("https://claude.ai/code/s"))).rejects.toMatchObject({
        code: "client-target-denied",
      });
      expect(open).not.toHaveBeenCalled();
    });

    it("hands a checked http(s) session URL to the OS opener", async () => {
      const open = vi.fn(async () => {});
      const { provider: granted, navigate } = provider([SESSION_GRANT], {
        kind: "desktop-shell",
        open,
      });
      await expect(granted.invoke(openSession("https://claude.ai/code/s"))).resolves.toEqual({
        status: "opened",
        agentId: "workflow-1",
        opener: "desktop-shell",
      });
      expect(open).toHaveBeenCalledWith("https://claude.ai/code/s");
      expect(navigate).not.toHaveBeenCalled();
    });

    it("refuses non-http URLs and a missing or failing opener by name", async () => {
      const open = vi.fn(async () => {});
      const { provider: granted } = provider([SESSION_GRANT], { kind: "browser-window", open });
      await expect(granted.invoke(openSession("javascript:alert(1)"))).resolves.toEqual({
        status: "refused",
        reason: "no-session",
      });
      expect(open).not.toHaveBeenCalled();
      const { provider: noOpener } = provider([SESSION_GRANT]);
      await expect(noOpener.invoke(openSession("https://claude.ai/code/s"))).resolves.toEqual({
        status: "refused",
        reason: "opener-refused",
      });
      const { provider: failing } = provider([SESSION_GRANT], {
        kind: "browser-window",
        open: () => Promise.reject(new Error("blocked")),
      });
      await expect(failing.invoke(openSession("https://claude.ai/code/s"))).resolves.toEqual({
        status: "refused",
        reason: "opener-refused",
      });
    });

    it("reports a popup the browser blocked as refused through the real web opener", async () => {
      vi.stubGlobal("window", { open: vi.fn(() => null) });
      try {
        const real = createNavigationClientProvider(
          {
            environmentId: EnvironmentId.make(ENV),
            client: "web",
            emit: vi.fn(),
            installations: () => [installation([SESSION_GRANT])],
          },
          vi.fn(async () => {}),
        );
        await expect(real.invoke(openSession("https://claude.ai/code/s"))).resolves.toEqual({
          status: "refused",
          reason: "opener-refused",
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe("openFile", () => {
    const openFile = (
      input: Record<string, unknown>,
      threadId: string | null = "thread-a",
    ): ClientProviderInvokeCall => {
      const { threadId: _dropped, ...resource } = context.resource;
      return {
        method: "openFile",
        input: { target: { kind: "self" }, ...input } as ClientProviderInvokeCall["input"],
        context: { ...context, resource: threadId ? { ...resource, threadId } : resource },
        caller,
        signal: new AbortController().signal,
      };
    };
    const panelOf = (threadId: string) =>
      selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make(threadId)),
      );

    it("opens and activates the file on the caller's own thread, where native file links land", async () => {
      const { provider: granted, navigate } = provider();
      await expect(
        granted.invoke(openFile({ relativePath: "src/app.ts", line: 7 })),
      ).resolves.toEqual({ status: "opened", relativePath: "src/app.ts" });
      const panel = panelOf("thread-a");
      expect(panel.isOpen).toBe(true);
      expect(panel.activeSurfaceId).toBe("file:src/app.ts");
      // The host's own file surface: it renders through the selected
      // t3.file/presentation provider (SelectedApiPresentation) or native.
      expect(panel.surfaces.find((surface) => surface.id === "file:src/app.ts")).toMatchObject({
        kind: "file",
        relativePath: "src/app.ts",
        revealLine: 7,
      });
      // Opening a file never routes the client to another thread.
      expect(navigate).not.toHaveBeenCalled();
    });

    it("is grant-gated and refuses unknown, foreign and unsafe targets without opening", async () => {
      const { provider: denied } = provider([]);
      await expect(denied.invoke(openFile({ relativePath: "a.ts" }))).rejects.toMatchObject({
        code: "client-target-denied",
      });
      const { provider: granted } = provider();
      await expect(
        granted.invoke(openFile({ relativePath: "a.ts" }, "thread-gone")),
      ).resolves.toEqual({ status: "refused", reason: "unknown-thread" });
      await expect(granted.invoke(openFile({ relativePath: "a.ts" }, null))).resolves.toEqual({
        status: "refused",
        reason: "unknown-thread",
      });
      await expect(
        granted.invoke(openFile({ relativePath: "a.ts" }, "thread-other")),
      ).resolves.toEqual({ status: "refused", reason: "out-of-scope" });
      await expect(granted.invoke(openFile({ relativePath: "../a.ts" }))).resolves.toEqual({
        status: "refused",
        reason: "invalid-path",
      });
      for (const threadId of ["thread-gone", "thread-other", "thread-b"])
        expect(panelOf(threadId).surfaces.some((surface) => surface.kind === "file")).toBe(false);
    });

    // Native parity (FilePreviewPanel "Open file in preview browser").
    it("opens a page in the thread's preview browser from its workspace root", async () => {
      const previewFile = vi.fn(async () => "opened");
      const { provider: granted } = provider([GRANT], undefined, previewFile);
      const surfaces = panelOf("thread-a").surfaces;
      await expect(
        granted.invoke(openFile({ relativePath: "site/index.html", openIn: "browser" })),
      ).resolves.toEqual({ status: "opened", relativePath: "site/index.html" });
      await expect(
        granted.invoke(openFile({ relativePath: "doc.pdf", openIn: "browser" }, "thread-b")),
      ).resolves.toEqual({ status: "opened", relativePath: "doc.pdf" });
      expect(previewFile.mock.calls).toEqual([
        [
          scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a")),
          "/work/project-a/site/index.html",
          "/work/project-a",
        ],
        [
          scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-b")),
          "/work/tree-b/doc.pdf",
          "/work/tree-b",
        ],
      ]);
      // The page opens in the browser, not as a file surface.
      expect(panelOf("thread-a").surfaces).toBe(surfaces);
    });

    // Native shows "Open file in preview
    // browser" only where this client has one; a pack asks the same question.
    it("says whether this client has a preview browser, without a grant", async () => {
      for (const supported of [true, false]) {
        const { provider: client } = provider([], undefined, undefined, supported);
        await expect(
          client.invoke({
            method: "getCapabilities",
            input: { target: { kind: "self" } } as ClientProviderInvokeCall["input"],
            context,
            caller,
            signal: new AbortController().signal,
          }),
        ).resolves.toEqual({ openFileInBrowser: supported });
      }
    });

    it("refuses a file the browser cannot show and names a failed open", async () => {
      const outcomes = ["browser-unavailable", "open-failed"];
      const previewFile = vi.fn(async () => outcomes.shift());
      const { provider: granted } = provider([GRANT], undefined, previewFile);
      const page = openFile({ relativePath: "index.html", openIn: "browser" });
      await expect(
        granted.invoke(openFile({ relativePath: "notes.txt", openIn: "browser" })),
      ).resolves.toEqual({ status: "refused", reason: "not-previewable" });
      expect(previewFile).not.toHaveBeenCalled();
      await expect(granted.invoke(page)).resolves.toEqual({
        status: "refused",
        reason: "browser-unavailable",
      });
      await expect(granted.invoke(page)).resolves.toEqual({
        status: "refused",
        reason: "open-failed",
      });
    });
  });
});

// The server sends openFile and asks for
// renderBrowserFile only when this client registered the 1.1.0 areas.
it("registers the 1.1.0 navigation and preferences areas", () => {
  for (const id of ["t3.client/navigation", "t3.client/preferences"])
    expect(CLIENT_PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.id === id)?.version).toBe(
      CLIENT_PROVIDER_APIS.get(id)?.version,
    );
  expect(CLIENT_PROVIDER_APIS.get("t3.client/navigation")?.version).toBe("1.2.0");
});
