import { EnvironmentId, ThreadId, type DiscoveredLocalServer } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const shell = vi.hoisted(() => ({ openExternal: vi.fn(async (_url: string) => undefined) }));
const state = vi.hoisted(() => ({ serverCount: 10 }));

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
      { length: state.serverCount },
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

const setup = (serverCount = 10) => {
  state.serverCount = serverCount;
};

const panel = (threadId: string) => (
  <ThreadServersPanel
    environmentId={EnvironmentId.make("env")}
    threadId={ThreadId.make(threadId)}
  />
);

it("pages servers four at a time, collapses back, and resets on thread switch", async () => {
  setup();
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

it('shows a lone fifth server instead of a "Show 1 more" row', async () => {
  setup(5);
  await using screen = await render(panel("a"));
  await vi.waitFor(() => expect(screen.container.querySelectorAll("li").length).toBe(5));
  expect(screen.container.querySelectorAll("[data-thread-details-server-overflow]").length).toBe(0);
  expect(screen.container.textContent).not.toContain("Show");
});

it("labels a page by the rows it reveals, folding in a last lone server", async () => {
  setup(9);
  await using screen = await render(panel("a"));
  const count = (selector: string) => screen.container.querySelectorAll(selector).length;
  await vi.waitFor(() => expect(count("li")).toBe(4));
  await page.getByRole("button", { name: "Show 5 more" }).click();
  await vi.waitFor(() => expect(count("li")).toBe(9));
  expect(count("[data-thread-details-server-overflow]")).toBe(5);
  await page.getByRole("button", { name: "Show less" }).click();
  await vi.waitFor(() => expect(count("li")).toBe(4));
});

it("opens a remote server in the system browser through the forward a modified click starts", async () => {
  setup();
  shell.openExternal.mockClear();
  await using _screen = await render(panel("a"));
  await page.getByText("localhost:3000", { exact: true }).click({ modifiers: ["ControlOrMeta"] });
  await vi.waitFor(() =>
    expect(shell.openExternal).toHaveBeenCalledWith("http://localhost:45000/"),
  );
});
