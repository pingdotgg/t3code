import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  normalizeProviderAccentColor,
  providerInstanceInitials,
  resolveProviderAccountSwitchPrompt,
  resolveProviderInstanceDisplayName,
  resolveTurnAccountSwitchConsent,
  retainConfirmedAccountSwitch,
  shouldShowInstanceBadge,
} from "./providerInstanceDisplay.ts";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

describe("resolveProviderInstanceDisplayName", () => {
  it("keeps a snapshot name that differs from the brand label", () => {
    expect(
      resolveProviderInstanceDisplayName({
        instanceId: ProviderInstanceId.make("codex"),
        driver: codex,
        displayName: "Work",
      }),
    ).toBe("Work");
  });

  it("humanizes a custom instance id when the snapshot only carries the brand label", () => {
    expect(
      resolveProviderInstanceDisplayName({
        instanceId: ProviderInstanceId.make("codex_personal"),
        driver: codex,
        displayName: "Codex",
      }),
    ).toBe("Codex Personal");
  });

  it("uses the brand label for the default instance", () => {
    expect(
      resolveProviderInstanceDisplayName({
        instanceId: ProviderInstanceId.make("codex"),
        driver: codex,
      }),
    ).toBe("Codex");
  });
});

describe("providerInstanceInitials", () => {
  it("takes the first two characters of a single word", () => {
    expect(providerInstanceInitials("Codex")).toBe("CO");
  });

  it("takes the first character of each of the first two words", () => {
    expect(providerInstanceInitials("Codex Personal")).toBe("CP");
  });

  it("ignores words past the first two", () => {
    expect(providerInstanceInitials("Codex Personal Backup Account")).toBe("CP");
  });

  it("returns an empty string for an empty label", () => {
    expect(providerInstanceInitials("")).toBe("");
  });

  it("keeps an emoji whole instead of splitting its surrogate pair", () => {
    expect(providerInstanceInitials("😀 Work")).toBe("😀W");
    expect(providerInstanceInitials("😀")).toBe("😀");
  });
});

describe("normalizeProviderAccentColor", () => {
  it("accepts a lowercase hex color", () => {
    expect(normalizeProviderAccentColor("#ff8800")).toBe("#ff8800");
  });

  it("accepts an uppercase hex color", () => {
    expect(normalizeProviderAccentColor("#FF8800")).toBe("#FF8800");
  });

  it("rejects a non-hex value", () => {
    expect(normalizeProviderAccentColor("blue")).toBeUndefined();
  });

  it("rejects a short hex value", () => {
    expect(normalizeProviderAccentColor("#fff")).toBeUndefined();
  });

  it("treats undefined and blank as unset", () => {
    expect(normalizeProviderAccentColor(undefined)).toBeUndefined();
    expect(normalizeProviderAccentColor("   ")).toBeUndefined();
  });
});

describe("shouldShowInstanceBadge", () => {
  it("shows the badge when the entry has an accent color", () => {
    const entry = { driverKind: codex, accentColor: "#ff8800" };
    expect(shouldShowInstanceBadge(entry, [entry])).toBe(true);
  });

  it("shows the badge when two entries share a driver, even without an accent", () => {
    const first = { driverKind: codex, accentColor: undefined };
    const second = { driverKind: codex, accentColor: undefined };
    expect(shouldShowInstanceBadge(first, [first, second])).toBe(true);
  });

  it("hides the badge for a single instance of a driver with no accent", () => {
    const entry = { driverKind: codex, accentColor: undefined };
    const other = { driverKind: claude, accentColor: undefined };
    expect(shouldShowInstanceBadge(entry, [entry, other])).toBe(false);
  });
});

describe("resolveProviderAccountSwitchPrompt", () => {
  const work = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: claude,
    displayName: "Work",
    continuation: { groupKey: "claude:/home/me/.claude-work" },
  };
  const personal = {
    instanceId: ProviderInstanceId.make("claude_personal"),
    driver: claude,
    displayName: "Personal",
    continuation: { groupKey: "claude:/home/me/.claude-personal" },
  };

  it("names both accounts when the thread moves between them", () => {
    const prompt = resolveProviderAccountSwitchPrompt({
      supported: true,
      current: work,
      next: personal,
    });
    expect(prompt?.title).toBe("Continue this thread on Personal?");
    expect(prompt?.body).toContain("Work keeps the conversation");
    expect(prompt?.body).toContain("Personal starts fresh");
  });

  it("asks nothing when the server would reject the switch", () => {
    expect(
      resolveProviderAccountSwitchPrompt({ supported: false, current: work, next: personal }),
    ).toBeNull();
  });

  it("asks nothing when both accounts share a continuation group", () => {
    expect(
      resolveProviderAccountSwitchPrompt({
        supported: true,
        current: work,
        next: { ...personal, continuation: work.continuation },
      }),
    ).toBeNull();
  });

  it("leaves a different driver to the driver lock", () => {
    expect(
      resolveProviderAccountSwitchPrompt({
        supported: true,
        current: work,
        next: {
          instanceId: ProviderInstanceId.make("codex"),
          driver: codex,
          displayName: "Codex",
          continuation: { groupKey: "codex:/home/me/.codex" },
        },
      }),
    ).toBeNull();
  });

  it("stays locked when an account reports no continuation group", () => {
    const { continuation: _dropped, ...withoutGroup } = personal;
    expect(
      resolveProviderAccountSwitchPrompt({ supported: true, current: work, next: withoutGroup }),
    ).toBeNull();
  });
});

describe("retainConfirmedAccountSwitch", () => {
  const confirmation = { from: "claude_work", to: "claude_personal", revision: 12 };

  it("holds the confirmation while the thread still sits on the account being left", () => {
    expect(retainConfirmedAccountSwitch(confirmation, "claude_work", 12)).toBe(confirmation);
  });

  it("rejects an open dialog or offline confirmation after A → B → A", () => {
    expect(retainConfirmedAccountSwitch(confirmation, "claude_work", 14)).toBeNull();
  });

  it("defaults legacy session revisions to zero", () => {
    const initial = { ...confirmation, revision: 0 };
    expect(retainConfirmedAccountSwitch(initial, "claude_work", undefined)).toBe(initial);
    expect(retainConfirmedAccountSwitch(confirmation, "claude_work", undefined)).toBeNull();
  });

  // A→B→A: the send moves the thread to B and spends the confirmation. Another
  // device moving it back to A must not revive it and restart on B unasked.
  it("spends the confirmation once the switch lands, and does not revive it", () => {
    const landed = retainConfirmedAccountSwitch(confirmation, "claude_personal", 12);
    expect(landed).toBeNull();
    expect(retainConfirmedAccountSwitch(landed, "claude_work", 12)).toBeNull();
  });

  it("spends the confirmation when the thread moves somewhere else entirely", () => {
    expect(retainConfirmedAccountSwitch(confirmation, "claude_third", 12)).toBeNull();
  });

  it("spends the confirmation for a thread with no account of its own", () => {
    expect(retainConfirmedAccountSwitch(confirmation, undefined, 12)).toBeNull();
  });
});

describe("resolveTurnAccountSwitchConsent", () => {
  const confirmed = { from: "claude_work", to: "claude_personal", revision: 12 };

  it("carries the account being left when the turn goes to the confirmed one", () => {
    expect(resolveTurnAccountSwitchConsent({ confirmed, instanceId: "claude_personal" })).toEqual({
      providerAccountSwitchFrom: "claude_work",
      providerAccountSwitchRevision: 12,
    });
  });

  it("claims nothing for a turn on the thread's own account", () => {
    expect(resolveTurnAccountSwitchConsent({ confirmed, instanceId: "claude_work" })).toEqual({});
  });

  // A queued message can outlive the confirmation that was in hand when it was
  // written; without consent the server refuses to reset the conversation.
  it("claims nothing when nothing was confirmed", () => {
    expect(
      resolveTurnAccountSwitchConsent({ confirmed: null, instanceId: "claude_personal" }),
    ).toEqual({});
  });

  it("claims nothing for a third account the confirmation never named", () => {
    expect(resolveTurnAccountSwitchConsent({ confirmed, instanceId: "claude_third" })).toEqual({});
  });
});
