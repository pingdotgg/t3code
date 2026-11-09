import { EnvironmentId, ThreadId, type DiscoveredLocalServer } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({ serverCount: 10 }));

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

const panel = (threadId: string) => (
  <ThreadServersPanel
    environmentId={EnvironmentId.make("env")}
    threadId={ThreadId.make(threadId)}
  />
);

it("pages servers four at a time, collapses back, and resets on thread switch", async () => {
  state.serverCount = 10;
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
  state.serverCount = 5;
  await using screen = await render(panel("a"));
  await vi.waitFor(() => expect(screen.container.querySelectorAll("li").length).toBe(5));
  expect(screen.container.querySelectorAll("[data-thread-details-server-overflow]").length).toBe(0);
  expect(screen.container.textContent).not.toContain("Show");
});

it("labels a page by the rows it reveals, folding in a last lone server", async () => {
  state.serverCount = 9;
  await using screen = await render(panel("a"));
  const count = (selector: string) => screen.container.querySelectorAll(selector).length;
  await vi.waitFor(() => expect(count("li")).toBe(4));
  await page.getByRole("button", { name: "Show 5 more" }).click();
  await vi.waitFor(() => expect(count("li")).toBe(9));
  expect(count("[data-thread-details-server-overflow]")).toBe(5);
  await page.getByRole("button", { name: "Show less" }).click();
  await vi.waitFor(() => expect(count("li")).toBe(4));
});
