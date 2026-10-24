import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useUsage, type EnvironmentUsageStatus } from "./usage";

const state = vi.hoisted(() => ({ environments: [] as readonly EnvironmentUsageStatus[] }));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.environments }));
vi.mock("@t3tools/client-runtime/state/usage", () => ({
  needsCursorKeychainAccess: () => false,
  refreshUsage: vi.fn(),
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./presentation", () => ({ environmentPresentations: {} }));
vi.mock("./server", () => ({ serverEnvironment: {} }));
vi.mock("./session", () => ({ environmentSession: {}, readEnvironmentScope: vi.fn() }));

function setup() {
  const window: UsageSummaryInput = {
    sinceDay: UsageDay.make("2026-10-16"),
    untilDay: UsageDay.make("2026-10-23"),
    timeZone: "UTC",
    resolution: "day",
  };
  const summary: UsageSummary = {
    contractVersion: USAGE_CONTRACT_VERSION,
    ...window,
    readAt: "2026-10-23T12:00:00.000Z",
    buckets: [],
    sources: [],
    pricing: { status: "cached", source: "test", fetchedAt: null, knownModels: 0 },
    scanDurationMs: 0,
  };
  const answered: EnvironmentUsageStatus = {
    environmentId: EnvironmentId.make("test"),
    label: "Test",
    isPending: false,
    isConnected: true,
    canReadDiagnostics: true,
    error: null,
    summary,
    needsCursorKeychainAccess: false,
  };
  state.environments = [answered];
  return { window, answered };
}

function UsageProbe({ window }: { readonly window: UsageSummaryInput }) {
  const usage = useUsage(window);
  return (
    <output>
      {usage.shown === null
        ? "Loading usage"
        : `${usage.shown.window.resolution ?? "day"} usage: ${usage.selectedEnvironments[0]?.error ?? "ready"}`}
    </output>
  );
}

it.each(["day", "hour"] as const)(
  "drops the previous view when switching from %s resolution, including on failure",
  async (resolution) => {
    const { window, answered } = setup();
    const initial = { ...window, resolution };
    await using screen = await render(<UsageProbe window={initial} />);
    await expect.element(screen.getByText(`${resolution} usage: ready`)).toBeVisible();

    const next = { ...window, resolution: resolution === "day" ? "hour" : "day" } as const;
    state.environments = [{ ...answered, summary: null, isPending: true }];
    await screen.rerender(<UsageProbe window={next} />);
    await expect.element(screen.getByText("Loading usage")).toBeVisible();

    state.environments = [{ ...answered, summary: null, error: "unavailable" }];
    await screen.rerender(<UsageProbe window={next} />);
    await expect.element(screen.getByText(`${next.resolution} usage: unavailable`)).toBeVisible();

    state.environments = [answered];
    await screen.rerender(<UsageProbe window={next} />);
    await expect.element(screen.getByText(`${next.resolution} usage: ready`)).toBeVisible();
  },
);

it("keeps the previous view while another window of the same resolution loads", async () => {
  const { window, answered } = setup();
  await using screen = await render(<UsageProbe window={window} />);
  await expect.element(screen.getByText("day usage: ready")).toBeVisible();

  state.environments = [{ ...answered, summary: null, isPending: true }];
  await screen.rerender(
    <UsageProbe window={{ ...window, sinceDay: UsageDay.make("2026-10-01") }} />,
  );
  await expect.element(screen.getByText("day usage: ready")).toBeVisible();
});
