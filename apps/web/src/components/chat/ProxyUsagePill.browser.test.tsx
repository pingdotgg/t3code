import {
  EnvironmentId,
  UsageLimitSourceId,
  type ServerProviderResetCredits,
  type UsageLimitSourceSnapshot,
} from "@lathe/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const gateway = vi.hoisted(() => ({
  redeems: [] as Array<unknown>,
  answer: null as null | ((value: unknown) => void),
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => undefined) as never,
}));
// Every command the ledger runs resolves when the test answers it.
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => (request: unknown) => {
    gateway.redeems.push(request);
    return new Promise((resolve) => {
      gateway.answer = resolve;
    });
  }) as never,
}));

import "~/index.css";

import { render } from "../../../test/render";
import { deriveProxyPill } from "./ProxyUsagePill.logic";
import { Ledger } from "./ProxyUsagePill";

const environmentId = EnvironmentId.make("desk");
const checkedAt = "2026-11-18T12:00:00.000Z";
const NOW = Date.parse(checkedAt);
const weeklyResetsAt = "2026-11-21T12:00:00.000Z";

/** Pins the ledger's clock at `NOW`; timers stay real so locators can poll. */
function frozenClock(): Disposable {
  vi.setSystemTime(NOW);
  return { [Symbol.dispose]: () => void vi.useRealTimers() };
}

/** Forgets the previous test's redeem calls. */
function freshGateway() {
  gateway.redeems.length = 0;
  gateway.answer = null;
  return gateway;
}

/** The gateway with one account whose weekly window is `weeklyUsed` percent spent. */
function gatewaySnapshot(
  weeklyUsed: number,
  resetCredits: ServerProviderResetCredits,
): UsageLimitSourceSnapshot {
  return {
    id: UsageLimitSourceId.make("modelproxy-iris"),
    kind: "modelproxy",
    label: "iris",
    checkedAt,
    accounts: [
      {
        id: "claude-1",
        driver: "claudeAgent" as never,
        usageLimits: {
          checkedAt,
          windows: [
            { id: "five_hour", kind: "session", label: "Session", usedPercent: 10 },
            {
              id: "seven_day",
              kind: "weekly",
              label: "Weekly",
              usedPercent: weeklyUsed,
              resetsAt: weeklyResetsAt,
            },
          ],
          resetCredits,
        },
        proxy: { state: "ready", inflight: 0 },
      },
    ],
    proxy: {
      auth: { state: "signedIn" },
      rotationThresholdPercent: 90,
      runway: { kind: "idle" },
      inflightTotal: 0,
      queueDepth: 0,
    },
  };
}

const ledger = (snapshot: UsageLimitSourceSnapshot, variant: "peek" | "card") => (
  <Ledger
    environmentId={environmentId}
    snapshot={snapshot}
    threshold={90}
    variant={variant}
    loginFor={null}
    onLoginFor={() => {}}
  />
);

const spent = gatewaySnapshot(100, {
  availableCount: 1,
  usableNowCount: 1,
  nextCreditId: "weekly" as never,
});
const cleared = gatewaySnapshot(0, { availableCount: 0, usableNowCount: 0 });

describe("Ledger reset credits", () => {
  it.each(["the new status", "the redeem answer"] as const)(
    "keeps the redemption's answer after the reset moves the account and spends the last credit, when %s arrives first",
    async (first) => {
      using _clock = frozenClock();
      const calls = freshGateway();
      // The reset clears the spent window, so the account moves from the
      // unavailable rows to the available ones and its row mounts afresh.
      expect(deriveProxyPill(spent, NOW)?.groups[0]?.unavailable.map((a) => a.id)).toEqual([
        "claude-1",
      ]);
      expect(deriveProxyPill(cleared, NOW)?.groups[0]?.available.map((a) => a.id)).toEqual([
        "claude-1",
      ]);

      await using screen = await render(ledger(spent, "card"));
      await screen.getByRole("button", { name: "Show claude-1 windows" }).click();
      await screen.getByRole("button", { name: "Use reset" }).click();
      await page.getByRole("button", { name: "Use credit" }).click();
      await expect.element(screen.getByRole("button", { name: "Using…" })).toBeVisible();
      expect(calls.redeems).toHaveLength(1);

      // The server publishes the new status before the redeem call returns, but
      // the two reach the client on different paths.
      const answer = () => calls.answer?.({ _tag: "Success", value: { outcome: "reset" } });
      if (first === "the redeem answer") answer();
      await screen.rerender(ledger(cleared, "card"));
      if (first === "the new status") answer();

      await expect
        .element(screen.getByText("Reset applied. Your windows have cleared."))
        .toBeVisible();
      await expect
        .element(screen.getByRole("button", { name: "Use reset" }))
        .not.toBeInTheDocument();
    },
  );

  it("offers redemption only on the card, never in the hover peek", async () => {
    using _clock = frozenClock();
    await using peek = await render(ledger(spent, "peek"));
    await peek.getByRole("button", { name: "Show claude-1 windows" }).click();
    await expect.element(peek.getByRole("button", { name: "Hide claude-1 windows" })).toBeVisible();
    await expect.element(peek.getByRole("button", { name: "Use reset" })).not.toBeInTheDocument();
    await peek.unmount();

    await using card = await render(ledger(spent, "card"));
    await card.getByRole("button", { name: "Show claude-1 windows" }).click();
    await expect.element(card.getByRole("button", { name: "Use reset" })).toBeVisible();
  });

  const fableOnly: ServerProviderResetCredits = {
    availableCount: 0,
    usableNowCount: 0,
    fable: { availableCount: 1, nextCreditId: "fable" as never },
  };

  it("holds back a Fable reset while the weekly limit is full, and says why", async () => {
    using _clock = frozenClock();
    const calls = freshGateway();
    await using card = await render(ledger(gatewaySnapshot(99, fableOnly), "card"));
    await card.getByRole("button", { name: "Show claude-1 windows" }).click();
    await expect.element(card.getByRole("button", { name: "Use reset" })).toBeDisabled();
    await expect
      .element(
        card.getByText(
          "Weekly limit full, resets in 3d 0h. A Fable reset can't be used until then.",
        ),
      )
      .toBeVisible();
    expect(calls.redeems).toHaveLength(0);
  });

  it("offers a Fable reset while the weekly limit has room", async () => {
    using _clock = frozenClock();
    await using card = await render(ledger(gatewaySnapshot(50, fableOnly), "card"));
    await card.getByRole("button", { name: "Show claude-1 windows" }).click();
    await expect.element(card.getByRole("button", { name: "Use reset" })).toBeEnabled();
    await expect.element(card.getByText(/A Fable reset can't be used/)).not.toBeInTheDocument();
  });
});
