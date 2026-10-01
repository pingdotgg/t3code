import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { copyJson, type ViewContext } from "@t3tools/extension-sdk/contracts";

const { readPreparedConnection, shellProjects } = vi.hoisted(() => ({
  readPreparedConnection: vi.fn<() => { httpBaseUrl: string } | null>(() => null),
  shellProjects: new Map<string, string>(),
}));

vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  readPreparedConnection,
}));
vi.mock("../components/ThreadTerminalDrawer", () => ({ terminalThemeFromApp: () => ({}) }));
vi.mock("../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/entities")>()),
  readThreadShell: (ref: { threadId: string }) => {
    const projectId = shellProjects.get(ref.threadId);
    return projectId ? { projectId } : null;
  },
}));

import {
  BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT,
  recordVisitForThread,
  resetBrowserHistoryForTests,
  useBrowserHistoryStore,
} from "../browserHistoryStore";
import { createBrowserHistoryClientProvider } from "./clientProviders";
import { ClientProviderOpError, type ClientProviderInvokeCall } from "./clientProviderTypes";
import type { InstalledPackage } from "./installedController";

const ENV = "env-a";
const READ = "t3.browser/read-history";
const RECORD = "t3.browser/record-history";

function deps(capabilities: readonly string[]) {
  const installed = {
    id: "ext.browser",
    contentHash: "hash-a",
    grants: { capabilities: [...capabilities], projectIds: [ProjectId.make("project-a")] },
  } as unknown as InstalledPackage;
  return { environmentId: ENV, installations: () => [installed] };
}

const context = (threadId: string): ViewContext => ({
  client: "web",
  resource: { namespace: "t3.extensions", id: "ext.browser", environmentId: ENV, threadId },
});

const call = (method: string, input: object, threadId = "thread-a"): ClientProviderInvokeCall => ({
  method,
  input: { target: { kind: "self" }, ...input },
  context: context(threadId),
  caller: { installationId: "ext.browser", contentHash: "hash-a", installationGeneration: 1 },
  signal: new AbortController().signal,
});

const threadRef = (threadId: string) =>
  scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make(threadId));

type Listed = {
  entries: { url: string; lastVisitedAt: number; title?: string }[];
  truncated?: true;
};

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof ClientProviderOpError ? error.code : "not-a-provider-error";
  }
  return undefined;
}

beforeEach(() => {
  resetBrowserHistoryForTests();
  shellProjects.clear();
  shellProjects.set("thread-a", "project-a");
  shellProjects.set("thread-b", "project-a");
  shellProjects.set("thread-other", "project-other");
  // Two threads of one project, as ChatView registers them.
  const store = useBrowserHistoryStore.getState();
  store.registerThreadProject(threadRef("thread-a"), "logical:project-a");
  store.registerThreadProject(threadRef("thread-b"), "logical:project-a");
});
afterEach(() => vi.restoreAllMocks());

describe("browser history client provider", () => {
  it("gates reads on the read grant and writes on both grants", () => {
    const readOnly = createBrowserHistoryClientProvider(deps([READ]));
    const recordOnly = createBrowserHistoryClientProvider(deps([RECORD]));
    expect(errorCode(() => readOnly.invoke(call("record", { url: "https://a.test" })))).toBe(
      "client-target-denied",
    );
    // A write answers with the list, so the record grant alone reveals nothing.
    expect(errorCode(() => recordOnly.invoke(call("record", { url: "https://a.test" })))).toBe(
      "client-target-denied",
    );
    expect(errorCode(() => recordOnly.invoke(call("list", {})))).toBe("client-target-denied");
    expect(readOnly.invoke(call("list", {}))).toEqual({ entries: [] });
  });

  it("refuses threads outside the granted project or unknown to the client", () => {
    const provider = createBrowserHistoryClientProvider(deps([READ, RECORD]));
    expect(errorCode(() => provider.invoke(call("list", {}, "thread-other")))).toBe(
      "client-target-denied",
    );
    expect(errorCode(() => provider.invoke(call("list", {}, "thread-missing")))).toBe(
      "provider-rejected",
    );
  });

  it("shares one project list across threads and with the native preview", () => {
    const provider = createBrowserHistoryClientProvider(deps([READ, RECORD]));
    provider.invoke(call("record", { url: "localhost:5173/docs" }, "thread-a"));
    // A native preview visit in a sibling thread lands in the same list.
    recordVisitForThread(threadRef("thread-b"), "https://example.com/");
    const listed = provider.invoke(call("list", {}, "thread-b")) as Listed;
    expect(listed.entries.map((entry) => entry.url)).toEqual([
      "https://example.com/",
      "http://localhost:5173/docs",
    ]);
  });

  it("keeps native ordering, loopback folding, and the 50-entry cap", () => {
    const provider = createBrowserHistoryClientProvider(deps([READ, RECORD]));
    for (let index = 0; index < BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT + 5; index++)
      provider.invoke(call("record", { url: `https://site.test/${index}` }));
    // A revisit through a loopback alias moves the one existing entry to the
    // front and, like native, keeps the spelling it was first stored under.
    provider.invoke(call("record", { url: "http://127.0.0.1:3000/" }));
    provider.invoke(call("record", { url: "https://site.test/54" }));
    const listed = provider.invoke(call("record", { url: "http://localhost:3000/" })) as Listed;
    expect(listed.entries).toHaveLength(BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT);
    expect(listed.entries.slice(0, 3).map((entry) => entry.url)).toEqual([
      "http://127.0.0.1:3000/",
      "https://site.test/54",
      "https://site.test/53",
    ]);
    expect(listed.entries.some((entry) => entry.url === "https://site.test/5")).toBe(false);
  });

  it("answers a full list of maximum-length URLs inside the envelope, flagged truncated", () => {
    const provider = createBrowserHistoryClientProvider(deps([READ, RECORD]));
    // 50 distinct URLs at the native 2048-char normalization cap.
    const urls = Array.from({ length: BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT }, (_, index) => {
      const prefix = `https://site.test/${String(index).padStart(2, "0")}/`;
      return prefix + "a".repeat(2048 - prefix.length);
    });
    for (const url of urls.slice(0, -1)) provider.invoke(call("record", { url }));
    const written = provider.invoke(call("record", { url: urls.at(-1)! })) as Listed;
    const listed = provider.invoke(call("list", {})) as Listed;
    for (const answer of [written, listed]) {
      expect(() => copyJson(answer)).not.toThrow();
      expect(answer.truncated).toBe(true);
      expect(answer.entries.length).toBeLessThan(urls.length);
      // Most recent first, as stored.
      expect(answer.entries.map((entry) => entry.url)).toEqual(
        urls.toReversed().slice(0, answer.entries.length),
      );
    }
    // The native list itself keeps every entry; only the answer is shortened.
    const store = useBrowserHistoryStore.getState();
    expect(store.byProjectKey["logical:project-a"]).toHaveLength(urls.length);
  });

  it("titles only existing entries and removes exact URLs", () => {
    const provider = createBrowserHistoryClientProvider(deps([READ, RECORD]));
    provider.invoke(call("record", { url: "https://example.com/a" }));
    const titled = provider.invoke(
      call("setTitle", { url: "https://example.com/a", title: "  Page A  " }),
    ) as Listed;
    expect(titled.entries[0]).toMatchObject({ url: "https://example.com/a", title: "Page A" });
    const untitled = provider.invoke(
      call("setTitle", { url: "https://example.com/never", title: "Ghost" }),
    ) as Listed;
    expect(untitled.entries).toHaveLength(1);
    const removed = provider.invoke(call("remove", { url: "https://example.com/a" })) as Listed;
    expect(removed.entries).toEqual([]);
  });

  it("buffers a visit until the thread's project registers, like the native store", () => {
    shellProjects.set("thread-new", "project-a");
    const provider = createBrowserHistoryClientProvider(deps([READ, RECORD]));
    const early = provider.invoke(
      call("record", { url: "https://early.test/" }, "thread-new"),
    ) as Listed;
    expect(early.entries).toEqual([]);
    useBrowserHistoryStore
      .getState()
      .registerThreadProject(threadRef("thread-new"), "logical:project-a");
    const listed = provider.invoke(call("list", {}, "thread-a")) as Listed;
    expect(listed.entries.map((entry) => entry.url)).toEqual(["https://early.test/"]);
  });

  it("drops corrupt persisted entries on rehydrate and lists the rest", async () => {
    const storage = useBrowserHistoryStore.persist.getOptions().storage!;
    await storage.setItem("t3code:browser-history:v1", {
      version: 1,
      state: {
        byProjectKey: {
          "logical:project-a": [
            { url: "https://kept.test/", lastVisitedAt: 2 },
            { url: 42, lastVisitedAt: 3 },
            { url: "https://bad-time.test/", lastVisitedAt: "soon" },
            null,
          ],
        },
        projectKeyByThreadKey: useBrowserHistoryStore.getState().projectKeyByThreadKey,
      },
    } as never);
    await useBrowserHistoryStore.persist.rehydrate();
    const provider = createBrowserHistoryClientProvider(deps([READ]));
    expect(provider.invoke(call("list", {}))).toEqual({
      entries: [{ url: "https://kept.test/", lastVisitedAt: 2 }],
    });
  });
});
