import { describe, expect, it, vi } from "vite-plus/test";
import { ProjectId, type ClientProviderCaller } from "@t3tools/contracts";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import { CLIENT_PROVIDER_APIS } from "@t3tools/extension-sdk/clientProviders";
import {
  CLIENT_PROVIDER_DESCRIPTORS,
  createExternalClientProvider,
  type LinkRouter,
} from "./clientProviders";
import type { ClientProviderInvokeCall } from "./clientProviderTypes";
import type { InstalledPackage } from "./installedController";

const shells = vi.hoisted(() => new Map<string, { projectId: string }>());
vi.mock("../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/entities")>()),
  readThreadShell: (ref: { threadId: string }) => shells.get(ref.threadId) ?? null,
}));
vi.mock("../components/ThreadTerminalDrawer", () => ({ terminalThemeFromApp: () => ({}) }));

const ENV = "env-a";
const INSTALL = "ext.a";

const caller: ClientProviderCaller = {
  installationId: INSTALL,
  contentHash: "hash-a",
  installationGeneration: 1,
};

const context = (threadId: string | undefined): ViewContext => ({
  client: "desktop",
  resource: {
    namespace: INSTALL,
    id: `${INSTALL}/view`,
    environmentId: ENV,
    projectId: "project-a",
    ...(threadId === undefined ? {} : { threadId }),
  },
});

const installation = {
  id: INSTALL,
  contentHash: "hash-a",
  enabled: true,
  installationGeneration: 1,
  grants: { capabilities: ["t3.ui/external.open"], projectIds: [ProjectId.make("project-a")] },
} as unknown as InstalledPackage;

/**
 * A provider whose router stands in for the native decision: `"app"` keeps
 * the link in the preview browser, `"system"` hands it back to the OS opener.
 */
function provider(decision: "app" | "system") {
  shells.clear();
  shells.set("thread-a", { projectId: "project-a" });
  shells.set("thread-other", { projectId: "project-b" });
  const open = vi.fn(async (_url: string) => {});
  const routed: { url: string; threadId: string; forceBrowser: boolean }[] = [];
  const router: LinkRouter = async (input) => {
    routed.push({
      url: input.url,
      threadId: input.threadRef.threadId,
      forceBrowser: input.forceBrowser,
    });
    if (decision === "system" || input.forceBrowser) input.fallbackToBrowser();
  };
  const external = createExternalClientProvider(
    { environmentId: ENV, installations: () => [installation] },
    () => ({ kind: "desktop-shell", open }),
    router,
  );
  const invoke = (method: string, input: Record<string, unknown>, threadId?: string) =>
    external.invoke({
      method,
      input: input as ClientProviderInvokeCall["input"],
      context: context(threadId),
      caller,
      signal: new AbortController().signal,
    });
  return { invoke, open, routed };
}

// Terminal URL links always reached the OS opener, ignoring
// "Open links in: in-app browser". openLink routes like the native drawer.
describe("t3.client/external openLink", () => {
  it("opens in the thread's preview browser when the setting says so", async () => {
    const { invoke, open, routed } = provider("app");
    await expect(invoke("openLink", { url: "https://t3.codes" }, "thread-a")).resolves.toEqual({
      status: "opened",
      url: "https://t3.codes/",
      opener: "in-app-browser",
    });
    expect(routed).toEqual([
      { url: "https://t3.codes/", threadId: "thread-a", forceBrowser: false },
    ]);
    expect(open).not.toHaveBeenCalled();
  });

  it("uses the OS opener when the setting or a Cmd/Ctrl-click says system", async () => {
    const system = provider("system");
    await expect(
      system.invoke("openLink", { url: "https://t3.codes" }, "thread-a"),
    ).resolves.toEqual({ status: "opened", url: "https://t3.codes/", opener: "desktop-shell" });
    expect(system.open).toHaveBeenCalledWith("https://t3.codes/");

    const forced = provider("app");
    await expect(
      forced.invoke("openLink", { url: "https://t3.codes", forceSystem: true }, "thread-a"),
    ).resolves.toMatchObject({ opener: "desktop-shell" });
    expect(forced.routed[0]?.forceBrowser).toBe(true);
    expect(forced.open).toHaveBeenCalledTimes(1);
  });

  it("never routes open, a threadless view, or a thread outside the grants", async () => {
    const { invoke, open, routed } = provider("app");
    await invoke("open", { url: "https://t3.codes" }, "thread-a");
    await invoke("openLink", { url: "https://t3.codes" });
    await invoke("openLink", { url: "https://t3.codes" }, "thread-other");
    expect(routed).toEqual([]);
    expect(open).toHaveBeenCalledTimes(3);
  });

  it("registers the 1.1.0 area the SDK defines", () => {
    expect(
      CLIENT_PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.id === "t3.client/external"),
    ).toEqual({
      id: "t3.client/external",
      version: CLIENT_PROVIDER_APIS.get("t3.client/external")!.version,
    });
  });
});
