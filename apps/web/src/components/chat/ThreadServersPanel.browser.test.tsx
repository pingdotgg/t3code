import { EnvironmentId, ThreadId, type DiscoveredLocalServer } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const shell = vi.hoisted(() => ({ openExternal: vi.fn(async (_url: string) => undefined) }));

vi.mock("~/env", () => ({ isElectron: true }));
vi.mock(import("../../state/portForwards"), async (importOriginal) => ({
  ...(await importOriginal()),
  canForwardPorts: () => true,
  useForwardLocality: () => "remote" as const,
  usePortForwards: () => [],
  forwardPort: (async (environmentId: string, remotePort: number) => ({
    environmentId,
    remotePort,
    localPort: 45000,
  })) as never,
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

it("pages servers four at a time, collapses back, and resets on thread switch", async () => {
  await using screen = await render(panel("a"));
  const count = (selector: string) => screen.container.querySelectorAll(selector).length;
  const expectRows = (rows: number) => vi.waitFor(() => expect(count("li")).toBe(rows));

  await expectRows(4);
  await page.getByRole("button", { name: "Show 4 more" }).click();
  await expectRows(8);
  expect(count("[data-thread-details-server-overflow]")).toBe(4);
  await page.getByRole("button", { name: "Show 2 more" }).click();
  await expectRows(10);
  await page.getByRole("button", { name: "Show less" }).click();
  await expectRows(4);

  await page.getByRole("button", { name: "Show 4 more" }).click();
  await expectRows(8);
  await screen.rerender(panel("b"));
  await expectRows(4);
  await screen.rerender(panel("a"));
  await expectRows(4);
});

it("opens a remote server in the system browser through the forward a modified click starts", async () => {
  shell.openExternal.mockClear();
  await using _screen = await render(panel("a"));
  await page.getByText("localhost:3000", { exact: true }).click({ modifiers: ["ControlOrMeta"] });
  await vi.waitFor(() =>
    expect(shell.openExternal).toHaveBeenCalledWith("http://localhost:45000/"),
  );
});
