import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { ComposerBanner } from "./ComposerBanner";
import {
  ComposerBannerStack,
  NoticeText,
  type ComposerBannerStackItem,
} from "./ComposerBannerStack";
import { useChatBannerLane } from "./ChatBannerLane";

function notice(title: string, group?: ComposerBannerStackItem["group"]): ComposerBannerStackItem {
  return { id: title, variant: "default", icon: <InfoIcon />, title, ...(group ? { group } : {}) };
}

it("puts machine notices first, whatever order the notices arrive in", async () => {
  await using screen = await render(
    <ComposerBannerStack
      items={[{ ...notice("Branch changed"), variant: "error" }, notice("Offline", "environment")]}
    />,
  );

  await expect.element(screen.getByText("Offline", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Branch changed", { exact: true })).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "1 other notice" }).click();
  await expect.element(screen.getByText("Branch changed", { exact: true })).toBeVisible();
});

function noticeRow(width: string, children: ReactNode) {
  return (
    <div data-testid="row" className="flex items-center gap-1.5" style={{ width }}>
      <NoticeText detailsLabel="Show details" className="min-w-0 truncate">
        {children}
      </NoticeText>
    </div>
  );
}

it("leaves out the details button when only a link's hit area reaches past the text", async () => {
  // Phones lay out in device pixels, so a range can measure one float32 step (2^-17 px at
  // this size) wider than its element. Headless Chromium's rects agree exactly.
  const rangeRect = Range.prototype.getBoundingClientRect;
  using _rangeRect = vi
    .spyOn(Range.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Range) {
      const rect = rangeRect.call(this);
      return new DOMRect(rect.x, rect.y, rect.width + 2 ** -17, rect.height);
    });
  // The flicker is a details button that mounts and then unmounts, so record every insertion.
  const inserted: Node[] = [];
  using observing = new DisposableStack();
  const mutations = new MutationObserver((records) =>
    inserted.push(...records.flatMap((record) => [...record.addedNodes])),
  );
  mutations.observe(document.body, { childList: true, subtree: true });
  observing.defer(() => mutations.disconnect());
  await using screen = await render(
    noticeRow(
      "20rem",
      <>
        Needs input{" "}
        <button type="button" className="relative after:absolute after:-inset-x-10 after:inset-y-0">
          Review
        </button>
      </>,
    ),
  );

  await expect.element(screen.getByText("Review")).toBeVisible();
  const details = [
    ...inserted,
    ...mutations.takeRecords().flatMap((record) => [...record.addedNodes]),
  ].filter(
    (node) =>
      node instanceof Element &&
      (node.matches('[aria-label="Show details"]') ||
        node.querySelector('[aria-label="Show details"]')),
  );
  expect(details).toEqual([]);
});

it("shows the details button while text or nested text is cut, until it fits again", async () => {
  await using screen = await render(noticeRow("4rem", "Waiting on a subagent with a long name"));
  const details = screen.getByRole("button", { name: "Show details" });
  await expect.element(details).toBeInTheDocument();

  await screen.rerender(noticeRow("4rem", "Ready"));
  await expect.element(details).not.toBeInTheDocument();

  await screen.rerender(noticeRow("4rem", "Waiting on a subagent with a long name"));
  await expect.element(details).toBeInTheDocument();

  screen.getByTestId("row").element().style.width = "40rem";
  await expect.element(details).not.toBeInTheDocument();

  await screen.rerender(
    noticeRow(
      "40rem",
      <span className="inline-block max-w-16 truncate align-bottom">A long nested name</span>,
    ),
  );
  await expect.element(details).toBeInTheDocument();

  await screen.rerender(
    <ComposerBanner.Root>
      {noticeRow("4rem", "Waiting on a subagent with a long name")}
    </ComposerBanner.Root>,
  );
  await expect.element(details).toBeInTheDocument();
  await screen.rerender(<ComposerBanner.Root>{noticeRow("4rem", "Ready")}</ComposerBanner.Root>);
  await expect.element(details).not.toBeInTheDocument();
});

it("opens the details of a long notice right above its button", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1280, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  const script = Array.from({ length: 400 }, (_, line) => `echo "line ${line}"`).join("\n");
  const container = document.createElement("div");
  container.style.cssText = "position: fixed; bottom: 4rem; right: 4rem;";
  await using screen = await render(noticeRow("40rem", script), { container });
  const details = screen.getByRole("button", { name: "Show details" });
  await userEvent.hover(details);
  const popup = page.getByLabelText("Notice details");
  await expect.element(popup).toBeVisible();

  // A positioner sized to the unscrolled text flips beside the button and covers it.
  await vi.waitFor(() => {
    const gap =
      details.element().getBoundingClientRect().top -
      popup.element().getBoundingClientRect().bottom;
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(8);
  });
});

function LowUsageLane({
  resetsAt,
  checkedAt,
}: {
  readonly resetsAt: string;
  readonly checkedAt: string;
}) {
  const claude: ServerProvider = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "2.1.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-11T16:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          windowDurationMins: 300,
          usedPercent: 84,
          resetsAt,
        },
      ],
    },
  };
  const items = useChatBannerLane({
    environmentId: EnvironmentId.make("remote"),
    activeProviderStatus: claude,
    providerStatuses: [claude],
    usageLimitSources: [],
    selectedModel: undefined,
    canSwitchProvider: false,
    providerStatus: null,
    providerStatusDismissalKey: null,
    onOpenProviderSetup: () => {},
    onOpenTerminal: () => {},
    onProviderModelSelect: () => {},
    limitsAvailable: false,
    threadId: null,
    threadError: null,
    threadErrorClass: null,
    threadErrorCode: null,
    threadErrorBannerKey: null,
    onRetry: null,
    retrying: false,
    setThreadError: () => {},
    setThreadErrorBannerDismissTick: () => {},
  });
  return <ComposerBannerStack items={items} />;
}

it("dismisses the low usage notice until its window resets", async () => {
  // Windows whose reset has passed are ignored, so the clock sits before the first reset.
  using _now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-11T16:00:00.000Z"));
  await using screen = await render(
    <LowUsageLane resetsAt="2026-11-11T19:59:59.612Z" checkedAt="2026-11-11T16:00:00.000Z" />,
  );
  await screen.getByRole("button", { name: "Dismiss low usage notice" }).click();
  await expect.element(screen.getByText("Claude usage low")).not.toBeInTheDocument();

  // A turn's rate-limit event reports the same reset in whole seconds.
  await screen.rerender(
    <LowUsageLane resetsAt="2026-11-11T20:00:00.000Z" checkedAt="2026-11-11T16:05:00.000Z" />,
  );
  await expect.element(screen.getByText("Claude usage low")).not.toBeInTheDocument();
  // A pooled read can name another account as the tightest, with a later reset.
  await screen.rerender(
    <LowUsageLane resetsAt="2026-11-11T22:30:00.000Z" checkedAt="2026-11-11T16:10:00.000Z" />,
  );
  await expect.element(screen.getByText("Claude usage low")).not.toBeInTheDocument();
  await screen.rerender(
    <LowUsageLane resetsAt="2026-11-12T01:00:00.000Z" checkedAt="2026-11-11T20:01:00.000Z" />,
  );
  await expect.element(screen.getByText("Claude usage low")).toBeVisible();
});
