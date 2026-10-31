import { act, render as renderScreen, type Screen } from "../../test/render";
import { EnvironmentId, type PluginNotificationFrame } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
const testState = vi.hoisted(() => ({
  environmentIds: [] as ReadonlyArray<string>,
  frames: new Map<string, PluginNotificationFrame | null>(),
  open: new Set<string>(),
  added: [] as Array<string>,
  nextToast: 0,
}));
vi.mock("@tanstack/react-router", async () => {
  const router =
    await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return {
    createMemoryHistory: router.createMemoryHistory,
    createRootRoute: router.createRootRoute,
    createRouter: router.createRouter,
    RouterProvider: router.RouterProvider,
    useNavigate: () => () => undefined,
  };
});
vi.mock("../state/environments", () => ({
  useEnvironments: () => testState.environmentIds.map((environmentId) => ({ environmentId })),
}));
vi.mock("../state/pluginNotifications", () => ({
  usePluginNotificationFrame: (environmentId: string) =>
    testState.frames.get(environmentId) ?? null,
}));
vi.mock("./ui/toast", () => ({
  toastManager: {
    add: (toast: { readonly title: string }) => {
      const id = `${toast.title}#${testState.nextToast++}`;
      testState.added.push(toast.title);
      testState.open.add(id);
      return id;
    },
    close: (id: string) => void testState.open.delete(id),
  },
}));
import { PluginNotificationCoordinator } from "./PluginNotificationCoordinator";
const A = EnvironmentId.make("env-a");
const B = EnvironmentId.make("env-b");
/** The same epoch, sequence and plugin in each environment, so only the environment differs. */
const frame = (title?: string): PluginNotificationFrame => ({
  epoch: "epoch-1",
  notifications:
    title === undefined
      ? []
      : [
          {
            sequence: 1,
            pluginId: "acme.notifier",
            pluginName: "Notifier",
            title,
            createdAt: "2026-10-04T00:00:00.000Z",
          },
        ],
});
async function render(
  screen: Screen,
  environmentIds: ReadonlyArray<EnvironmentId>,
  frames: ReadonlyArray<[EnvironmentId, PluginNotificationFrame]>,
) {
  testState.environmentIds = environmentIds;
  for (const [environmentId, next] of frames) testState.frames.set(environmentId, next);
  await act(async () => await screen.rerender(<PluginNotificationCoordinator />));
}
it("closes a removed environment's toasts and keeps the others", async () => {
  using _setup = await setup();
  await using screen = await renderScreen(null, { router: false });
  // The first frame on launch only sets the mark; the next one's notification is new.
  await render(
    screen,
    [A, B],
    [
      [A, frame()],
      [B, frame()],
    ],
  );
  await render(
    screen,
    [A, B],
    [
      [A, frame("from A")],
      [B, frame("from B")],
    ],
  );
  expect([...testState.open].toSorted()).toEqual(["from A#0", "from B#1"]);
  await render(screen, [B], []);
  expect([...testState.open]).toEqual(["from B#1"]);
});
/** A frame retaining `titles` as sequences 1..n of one epoch, oldest first. */
const retained = (epoch: string, titles: ReadonlyArray<[number, string]>) => ({
  epoch,
  notifications: titles.map(([sequence, title]) => ({
    sequence,
    pluginId: "acme.notifier",
    pluginName: "Notifier",
    title,
    createdAt: "2026-10-04T00:00:00.000Z",
  })),
});
it("toasts each notification once across reconnects and closes what left the set", async () => {
  using _setup = await setup();
  await using screen = await renderScreen(null, { router: false });
  await render(screen, [A], [[A, retained("e1", [[1, "old"]])]]);
  // Launch: what the server already held is not news.
  expect(testState.added).toEqual([]);
  await render(
    screen,
    [A],
    [
      [
        A,
        retained("e1", [
          [1, "old"],
          [2, "first"],
        ]),
      ],
    ],
  );
  expect(testState.added).toEqual(["first"]);
  // Back online after missing one; the reconnect's first frame is the whole set.
  await render(
    screen,
    [A],
    [
      [
        A,
        retained("e1", [
          [1, "old"],
          [2, "first"],
          [3, "missed"],
        ]),
      ],
    ],
  );
  // A second reconnect with nothing new shows nothing again.
  await render(
    screen,
    [A],
    [
      [
        A,
        retained("e1", [
          [1, "old"],
          [2, "first"],
          [3, "missed"],
        ]),
      ],
    ],
  );
  expect(testState.added).toEqual(["first", "missed"]);
  expect([...testState.open].toSorted()).toEqual(["first#0", "missed#1"]);
  // The plugin was disabled while this client was away: its toasts close on reconnect.
  await render(screen, [A], [[A, retained("e1", [[1, "old"]])]]);
  expect([...testState.open]).toEqual([]);
  // A server restart starts a new epoch, whose notifications are all new.
  await render(screen, [A], [[A, retained("e2", [[1, "after restart"]])]]);
  expect(testState.added).toEqual(["first", "missed", "after restart"]);
});

async function setup() {
  return {
    [Symbol.dispose]() {
      testState.frames.clear();
      testState.nextToast = 0;
      testState.added.length = 0;
      testState.open.clear();
    },
  };
}
