import { EnvironmentId, ThreadId, type DiscoveredLocalServer } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const shell = vi.hoisted(() => ({ openExternal: vi.fn(async (_url: string) => undefined) }));
const forwardState = vi.hoisted(() => ({ fail: false }));

// Pure browser client: no desktop bridge, so modified clicks reserve a tab with
// window.open before the probe instead of going through shell.openExternal.
vi.mock("~/env", () => ({ isElectron: false }));
vi.mock(import("../../state/portForwards"), async (importOriginal) => ({
  ...(await importOriginal()),
  canForwardPorts: () => true,
  useForwardLocality: () => "remote" as const,
  usePortForwards: () => [],
  forwardPort: (async (environmentId: string, remotePort: number) => {
    if (forwardState.fail) throw new Error("forward failed");
    return {
      environmentId,
      remotePort,
      localPort: 45000,
    };
  }) as never,
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
}));
vi.mock(import("../../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironment: (() => ({
    connection: { phase: "connected" },
    entry: { target: { _tag: "BearerConnectionTarget", connectionId: "saved:remote" } },
    serverConfig: null,
  })) as never,
}));
vi.mock(import("../../localApi"), async (importOriginal) => ({
  ...(await importOriginal()),
  readLocalApi: (() => ({ shell })) as never,
}));

vi.mock(import("../../portDiscoveryState"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadDiscoveredPorts: () =>
    Array.from(
      { length: 10 },
      (_, index) =>
        ({
          pid: index,
          port: 3000 + index,
          url: `http://localhost:${3000 + index}`,
          terminal: null,
          processName: "node",
        }) as DiscoveredLocalServer,
    ),
}));

import { render } from "../../../test/render";
import { ThreadServersPanel } from "./ThreadServersPanel";

const panel = (threadId: string) => (
  <ThreadServersPanel
    environmentId={EnvironmentId.make("env")}
    threadId={ThreadId.make(threadId)}
  />
);

const reservedWindow = () => ({
  location: { href: "" },
  close: vi.fn(),
  opener: null as unknown,
});

it("reserves a browser tab before the probe so a modified click is not blocked", async () => {
  const reserved = reservedWindow();
  const openSpy = vi.spyOn(window, "open").mockReturnValue(reserved as unknown as Window);
  try {
    shell.openExternal.mockClear();
    await using _screen = await render(panel("a"));
    await page.getByText("localhost:3000", { exact: true }).click({ modifiers: ["ControlOrMeta"] });
    await vi.waitFor(() => expect(reserved.location.href).toBe("http://localhost:45000/"));
    expect(openSpy).toHaveBeenCalledWith("", "_blank");
    expect(reserved.opener).toBeNull();
    expect(reserved.close).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  } finally {
    openSpy.mockRestore();
  }
});

it("closes the reserved browser tab when the forward fails", async () => {
  forwardState.fail = true;
  const reserved = reservedWindow();
  const openSpy = vi.spyOn(window, "open").mockReturnValue(reserved as unknown as Window);
  try {
    await using _screen = await render(panel("a"));
    await page.getByText("localhost:3000", { exact: true }).click({ modifiers: ["ControlOrMeta"] });
    await vi.waitFor(() => expect(reserved.close).toHaveBeenCalled());
    expect(reserved.location.href).toBe("");
  } finally {
    openSpy.mockRestore();
    forwardState.fail = false;
  }
});
