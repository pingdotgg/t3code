import { EnvironmentId, ThreadId, type DiscoveredLocalServer } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

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

it("pages servers four at a time and collapses back", async () => {
  await using screen = await render(
    <ThreadServersPanel environmentId={EnvironmentId.make("env")} threadId={ThreadId.make("t")} />,
  );
  const rows = () => screen.container.querySelectorAll("li").length;

  expect(rows()).toBe(4);
  await page.getByRole("button", { name: "Show 4 more" }).click();
  expect(rows()).toBe(8);
  await page.getByRole("button", { name: "Show 2 more" }).click();
  expect(rows()).toBe(10);
  await page.getByRole("button", { name: "Show less" }).click();
  expect(rows()).toBe(4);
});
