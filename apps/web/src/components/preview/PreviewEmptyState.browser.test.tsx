import { act, render, type Screen } from "../../../test/render";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

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

function setup() {
  vi.clearAllMocks();
  mocks.servers = [];
}

async function renderPreview(
  recentEntries: Array<{ url: string; lastVisitedAt: number; title?: string }>,
) {
  return render(
    <PreviewEmptyState
      threadRef={threadRef}
      environmentId={environmentId}
      recentEntries={recentEntries}
      onRemoveRecent={onRemoveRecent}
      onOpenUrl={onOpenUrl}
    />,
  );
}

function button(screen: Screen, name: string) {
  const match = [...screen.container.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === name || element.textContent?.includes(name),
  );
  expect(match, `button ${name}`).toBeDefined();
  return match!;
}

describe("PreviewEmptyState", () => {
  it("lists a recent entry and a live server matching its host:port, and opens or forgets entries", async () => {
    setup();
    mocks.servers = [server(5173)];
    await using screen = await renderPreview([
      { url: "https://myapp.test/admin#users", lastVisitedAt: Date.now(), title: "Admin" },
      { url: "http://localhost:5173/", lastVisitedAt: Date.now(), title: "Recent Local" },
    ]);
    const text = screen.container.textContent;
    expect(text).toContain("Recently used");
    expect(text).toContain("Local servers");
    expect(text).toContain("Recent Local");
    expect(text).toContain("node");

    await act(async () => button(screen, "Admin").click());
    expect(onOpenUrl).toHaveBeenCalledExactlyOnceWith("https://myapp.test/admin#users");

    await act(async () => button(screen, "Remove myapp.test/admin#users from history").click());
    expect(onRemoveRecent).toHaveBeenCalledExactlyOnceWith("https://myapp.test/admin#users");
  });

  it("shows only the recents group when no servers are found", async () => {
    setup();
    await using screen = await renderPreview([{ url: "https://myapp.test/", lastVisitedAt: 0 }]);
    expect(screen.container.textContent).toContain("Recently used");
    expect(screen.container.textContent).not.toContain("Local servers");
  });

  it("keeps the original empty state when both groups are empty", async () => {
    setup();
    await using screen = await renderPreview([]);
    expect(screen.container.textContent).toContain("No preview yet");
  });

  it("shows an entry with an out-of-range lastVisitedAt instead of crashing", async () => {
    setup();
    await using screen = await renderPreview([{ url: "https://myapp.test/", lastVisitedAt: 1e20 }]);
    expect(screen.container.textContent).toContain("myapp.test");
    button(screen, "Remove myapp.test from history");
  });
});
