import { EnvironmentId, ThreadId, type DiscoveredLocalServer } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const mockServers = vi.hoisted(() => ({ count: 10 }));
const setup = (count = 10) => {
  mockServers.count = count;
};

vi.mock(import("../../portDiscoveryState"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadDiscoveredPorts: () =>
    Array.from(
      { length: mockServers.count },
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

it("never hides a lone server behind a toggle row", async () => {
  setup(5);
  await using screen = await render(panel("a"));
  await vi.waitFor(() => expect(screen.container.querySelectorAll("li").length).toBe(5));
  await expect.element(page.getByText(/^Show \d+ more$/)).not.toBeInTheDocument();
});

it("shows the last server instead of a Show 1 more page", async () => {
  setup(9);
  await using screen = await render(panel("a"));
  await page.getByRole("button", { name: "Show 4 more" }).click();
  await vi.waitFor(() => expect(screen.container.querySelectorAll("li").length).toBe(9));
});
