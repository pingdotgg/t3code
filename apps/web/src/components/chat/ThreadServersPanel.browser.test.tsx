import {
  EnvironmentId,
  ThreadId,
  type DiscoveredLocalServer,
  type NxtvironInstance,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const mocks = vi.hoisted(() => ({
  servers: [] as ReadonlyArray<DiscoveredLocalServer>,
  instances: [] as ReadonlyArray<NxtvironInstance>,
  run: vi.fn(),
}));

vi.mock(import("../../portDiscoveryState"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadDiscoveredPorts: () => mocks.servers,
  useThreadNxtvironInstances: () => mocks.instances,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => mocks.run) as never,
}));
vi.mock(import("../../state/preview"), async () => {
  const { Atom } = await import("effect/reactivity");
  const denied = Atom.make(false);
  const granted = Atom.make(true);
  return {
    previewEnvironment: {
      open: {},
      stopLocalServer: { permissionAtom: () => denied },
      nxtvironInstanceAction: { permissionAtom: () => granted },
    } as never,
  };
});

import { render } from "../../../test/render";
import { ThreadServersPanel } from "./ThreadServersPanel";

const setup = (input: {
  readonly servers?: ReadonlyArray<DiscoveredLocalServer>;
  readonly instances?: ReadonlyArray<NxtvironInstance>;
}) => {
  mocks.servers = input.servers ?? [];
  mocks.instances = input.instances ?? [];
  mocks.run.mockReset();
  mocks.run.mockResolvedValue({ _tag: "Success", value: undefined });
};

const panel = (threadId: string) => (
  <ThreadServersPanel
    environmentId={EnvironmentId.make("env")}
    threadId={ThreadId.make(threadId)}
  />
);

const instance = (
  ref: string,
  state: NxtvironInstance["state"],
  ports: Record<string, number> = {},
): NxtvironInstance => ({
  ref,
  process: ref.split("#")[0]!,
  id: ref.split("#")[1]!,
  branch: "main",
  status: state,
  state,
  ports,
  proxyHostname: null,
  workingDir: "/work/repo",
  configPath: "/work/repo/nxtviron.yaml",
});

it("pages servers four at a time, collapses back, and resets on thread switch", async () => {
  setup({
    servers: Array.from(
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
  });
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

it("offers each nxtviron instance the actions its state allows", async () => {
  setup({
    servers: [
      {
        host: "127.0.0.1",
        pid: 7,
        port: 4100,
        url: "http://localhost:4100",
        terminal: null,
        processName: "node",
      },
    ],
    instances: [
      instance("api#main", "running", { http: 4100 }),
      instance("web#main", "stopped"),
      instance("job#main", "missing"),
    ],
  });
  await using screen = await render(panel("a"));
  const actionNames = () =>
    Array.from(screen.container.querySelectorAll("li [aria-label]"), (node) =>
      node.getAttribute("aria-label"),
    );

  await vi.waitFor(() =>
    expect(actionNames()).toEqual([
      "Stop api#main",
      "Resume web#main",
      "Delete web#main",
      "Delete job#main",
    ]),
  );
  // The discovered server on the instance's port is the same server, so it is not listed twice.
  expect(screen.container.querySelectorAll("li")).toHaveLength(3);

  await page.getByRole("button", { name: "Resume web#main" }).click();
  await vi.waitFor(() =>
    expect(mocks.run).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("env"),
      input: { ref: "web#main", action: "resume" },
    }),
  );
});
