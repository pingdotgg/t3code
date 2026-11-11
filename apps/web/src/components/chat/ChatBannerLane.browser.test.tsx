import { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { Schema } from "effect";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { useChatBannerLane } from "./ChatBannerLane";
import { ComposerBannerStack } from "./ComposerBannerStack";
import "~/index.css";

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);

function Fixture({ resetsAt }: { readonly resetsAt: string }) {
  const provider = decodeProvider({
    instanceId: "claude",
    driver: "claude",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-11T00:00:00.000Z",
    models: [],
    usageLimits: {
      checkedAt: "2026-11-11T00:00:00.000Z",
      windows: [{ id: "session", kind: "session", label: "5 hour", usedPercent: 100, resetsAt }],
    },
  });
  const items = useChatBannerLane({
    environmentId: EnvironmentId.make("dismiss-regression"),
    activeProviderStatus: provider,
    providerStatuses: [provider],
    usageLimitSources: [],
    canSwitchProvider: false,
    providerStatus: null,
    providerStatusBannerKey: null,
    setDismissedProviderStatusBannerKey: vi.fn(),
    onOpenProviderSetup: vi.fn(),
    onOpenTerminal: vi.fn(),
    onProviderModelSelect: vi.fn(),
    limitsAvailable: false,
    threadId: null,
    threadError: null,
    threadErrorClass: null,
    threadErrorCode: null,
    threadErrorBannerKey: null,
    onRetry: null,
    retrying: false,
    setThreadError: vi.fn(),
    setThreadErrorBannerDismissTick: vi.fn(),
  });
  return <ComposerBannerStack items={items} />;
}

it("dismisses low usage immediately, remembers it across remounts, and shows the next window", async () => {
  const resetsAt = "2026-11-11T05:00:00.000Z";
  {
    await using screen = await render(<Fixture resetsAt={resetsAt} />);
    await expect.element(screen.getByText(/claude usage low/i)).toBeVisible();
    await screen.getByRole("button", { name: "Dismiss low usage notice" }).click();
    await expect.element(screen.getByText(/claude usage low/i)).not.toBeInTheDocument();
  }
  await using screen = await render(<Fixture resetsAt={resetsAt} />);
  await expect.element(screen.getByText(/claude usage low/i)).not.toBeInTheDocument();
  await screen.rerender(<Fixture resetsAt="2026-11-11T10:00:00.000Z" />);
  await expect.element(screen.getByText(/claude usage low/i)).toBeVisible();
});
