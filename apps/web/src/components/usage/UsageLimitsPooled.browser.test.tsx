import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

const testState = vi.hoisted(() => ({ consume: vi.fn(), readOnlyEnvironments: new Set<string>() }));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: ((id: string) => !testState.readOnlyEnvironments.has(id)) as never,
  readEnvironmentScope: ((id: string) => !testState.readOnlyEnvironments.has(id)) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => testState.consume) as never,
}));

import { UsageLimitsPooled } from "./UsageLimitsPooled";

const checkedAt = "2026-10-25T16:00:00.000Z";

function setup() {
  testState.readOnlyEnvironments.clear();
  testState.consume.mockReset();
  testState.consume.mockResolvedValue({ _tag: "Success", value: { outcome: "reset" } });
}

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

function redeemable(
  instanceId: string,
  driver: string,
  displayName: string,
  readAt = checkedAt,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    displayName,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated", email: `${driver}@example.com` },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: readAt,
      windows: [
        {
          id: "session",
          kind: "session",
          label: "Session",
          usedPercent: 40,
          resetsAt: "2026-10-25T18:00:00.000Z",
          windowDurationMins: 300,
        },
      ],
      resetCredits: { availableCount: 1 },
    },
  };
}

function environments(
  ...entries: ReadonlyArray<readonly [id: string, label: string, providers: ServerProvider[]]>
) {
  return new Map(
    entries.map(([id, label, providers]) => [
      EnvironmentId.make(id),
      { entry: { target: { label } }, serverConfig: { providers } },
    ]),
  );
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });
});

describe("UsageLimitsPooled reset credits", () => {
  it("redeems the clicked account even when the pointer crosses another account's bar", async () => {
    setup();
    // Wide bars at the top of the page: the clicked popup flips below and covers the next bar's middle.
    await page.viewport(1280, 800);
    const presentations = environments([
      "desk",
      "Desk",
      [
        redeemable("codex", "codex", "Codex Work"),
        redeemable("claudeAgent", "claudeAgent", "Claude Max"),
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );
    const codexBar = screen.getByRole("button", { name: /^Codex Work:/ });
    const claudeBar = screen.getByRole("button", { name: /^Claude Max:/ });
    const popup = page.getByRole("dialog");

    // Hover previews still follow the pointer from bar to bar.
    await userEvent.hover(codexBar);
    await expect.element(popup).toMatchTextContent("Codex Work");
    await userEvent.hover(claudeBar, { position: { x: 8, y: 8 } });
    await expect.element(popup).toMatchTextContent("Claude Max");

    await userEvent.click(codexBar);
    await expect.element(popup).toMatchTextContent("Codex Work");
    await userEvent.hover(claudeBar, { position: { x: 8, y: 8 } });
    await expect.element(popup).not.toMatchTextContent("Claude Max");
    await userEvent.click(popup.getByRole("button", { name: "Use reset" }));

    const confirm = page.getByRole("alertdialog");
    await expect.element(confirm.getByText("Use a reset credit on Codex?")).toBeVisible();
    await expect.element(confirm.getByText("Codex Work")).toBeVisible();
    await userEvent.click(confirm.getByRole("button", { name: "Use credit" }));
    expect(testState.consume).toHaveBeenCalledExactlyOnceWith({
      environmentId: "desk",
      input: { instanceId: "codex" },
    });
  });

  it("keeps confirmation permissions and redemption on the captured environment", async () => {
    setup();
    testState.readOnlyEnvironments.add("desk");
    const now = Date.parse(checkedAt);
    const laptopFresh = environments(
      ["laptop", "Laptop", [redeemable("codex", "codex", "Codex", "2026-10-25T16:05:00.000Z")]],
      ["desk", "Desk", [redeemable("codex_personal", "codex", "Codex")]],
    );
    const deskFresh = environments(
      ["laptop", "Laptop", [redeemable("codex", "codex", "Codex")]],
      [
        "desk",
        "Desk",
        [redeemable("codex_personal", "codex", "Codex", "2026-10-25T16:10:00.000Z")],
      ],
    );
    await using screen = await render(<UsageLimitsPooled presentations={laptopFresh} now={now} />);

    await userEvent.click(screen.getByRole("button", { name: /^Codex:/ }));
    await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Use reset" }));
    const confirm = page.getByRole("alertdialog");
    await expect.element(confirm).toBeVisible();
    await screen.rerender(<UsageLimitsPooled presentations={new Map(deskFresh)} now={now} />);
    const useCredit = confirm.getByRole("button", { name: "Use credit" });
    await expect.element(useCredit).toBeEnabled();

    testState.readOnlyEnvironments.delete("desk");
    testState.readOnlyEnvironments.add("laptop");
    await screen.rerender(<UsageLimitsPooled presentations={new Map(deskFresh)} now={now} />);
    await expect.element(useCredit).toBeDisabled();
    expect(testState.consume).not.toHaveBeenCalled();

    testState.readOnlyEnvironments.delete("laptop");
    await screen.rerender(<UsageLimitsPooled presentations={new Map(deskFresh)} now={now} />);
    await expect.element(useCredit).toBeEnabled();
    await userEvent.click(useCredit);

    expect(testState.consume).toHaveBeenCalledExactlyOnceWith({
      environmentId: "laptop",
      input: { instanceId: "codex" },
    });
  });
});
