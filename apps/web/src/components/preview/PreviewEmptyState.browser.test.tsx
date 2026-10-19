import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { PreviewableServer } from "./useDiscoveredLocalServers";

const mocks = vi.hoisted(() => ({ servers: [] as PreviewableServer[] }));

vi.mock(import("./useDiscoveredLocalServers"), async (original) => ({
  ...(await original()),
  useDiscoveredLocalServers: () => mocks.servers,
}));

import { PreviewEmptyState } from "./PreviewEmptyState";

const environmentId = EnvironmentId.make("env-1");
const threadRef = { environmentId, threadId: ThreadId.make("thread-1") };
const onOpenUrl = vi.fn();
const onRemoveRecent = vi.fn();

let root: Root;
let container: HTMLDivElement;

function server(port: number): PreviewableServer {
  return {
    host: "localhost",
    port,
    url: `http://localhost:${port}`,
    requestedUrl: `http://localhost:${port}`,
    processName: "node",
    pid: 1,
    terminal: null,
    source: "scanner",
  } as PreviewableServer;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.servers = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(
  recentEntries: Array<{ url: string; lastVisitedAt: number; title?: string }>,
) {
  await act(async () =>
    root.render(
      <PreviewEmptyState
        threadRef={threadRef}
        environmentId={environmentId}
        recentEntries={recentEntries}
        onRemoveRecent={onRemoveRecent}
        onOpenUrl={onOpenUrl}
      />,
    ),
  );
}

function button(name: string) {
  const match = [...container.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === name || element.textContent?.includes(name),
  );
  expect(match, `button ${name}`).toBeDefined();
  return match!;
}

describe("PreviewEmptyState", () => {
  it("lists a recent entry and a live server matching its host:port, and opens or forgets entries", async () => {
    mocks.servers = [server(5173)];
    await render([
      { url: "https://myapp.test/admin#users", lastVisitedAt: Date.now(), title: "Admin" },
      { url: "http://localhost:5173/", lastVisitedAt: Date.now(), title: "Recent Local" },
    ]);
    const text = container.textContent;
    expect(text).toContain("Recently used");
    expect(text).toContain("Local servers");
    expect(text).toContain("Recent Local");
    expect(text).toContain("node");

    await act(async () => button("Admin").click());
    expect(onOpenUrl).toHaveBeenCalledExactlyOnceWith("https://myapp.test/admin#users");

    await act(async () => button("Remove myapp.test/admin#users from history").click());
    expect(onRemoveRecent).toHaveBeenCalledExactlyOnceWith("https://myapp.test/admin#users");
  });

  it("shows only the recents group when no servers are found", async () => {
    await render([{ url: "https://myapp.test/", lastVisitedAt: 0 }]);
    expect(container.textContent).toContain("Recently used");
    expect(container.textContent).not.toContain("Local servers");
  });

  it("keeps the original empty state when both groups are empty", async () => {
    await render([]);
    expect(container.textContent).toContain("No preview yet");
  });

  it("shows an entry with an out-of-range lastVisitedAt instead of crashing", async () => {
    await render([{ url: "https://myapp.test/", lastVisitedAt: 1e20 }]);
    expect(container.textContent).toContain("myapp.test");
    button("Remove myapp.test from history");
  });
});
