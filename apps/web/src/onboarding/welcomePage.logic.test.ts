import {
  type ManagedPolicySummary,
  ProjectId,
  resolveProviderInstanceEnabled,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cliTerminalStep,
  codexCardProvider,
  codexNeedsSetup,
  groupWelcomeAgents,
  turnedOnInstance,
  welcomeOffersPhone,
} from "./welcomePage.logic";

function provider(name: string, overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(name.toLowerCase()),
    driver: ProviderDriverKind.make(name.toLowerCase()),
    displayName: name,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-23T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const nameOf = (entry: ServerProvider) => entry.displayName ?? entry.driver;
const names = (entries: ReadonlyArray<ServerProvider>) => entries.map(nameOf);
const allowAll = () => true;

describe("groupWelcomeAgents", () => {
  it("lists agents on the computer by state, then name, and everything else by name", () => {
    const groups = groupWelcomeAgents(
      [
        provider("Zeta", { auth: { status: "unauthenticated" }, status: "error" }),
        provider("Codex"),
        provider("Pi", { enabled: false, status: "disabled" }),
        provider("Grok", { installed: false, status: "error", auth: { status: "unknown" } }),
        provider("Claude"),
        provider("Cursor", { installed: false, status: "warning", auth: { status: "unknown" } }),
      ],
      undefined,
      nameOf,
      allowAll,
    );

    expect(names(groups.found)).toEqual(["Claude", "Codex", "Zeta"]);
    // Cursor is still being checked; it stays listed instead of disappearing.
    expect(names(groups.available)).toEqual(["Cursor", "Grok", "Pi"]);
    expect(groups.checking).toBe(true);
    expect(groups.readyCount).toBe(2);
  });

  it("uses this computer's settings and keeps agents that failed to load with the found ones", () => {
    const acpRegistry = ProviderDriverKind.make("acpRegistry");
    const settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides"> = {
      providerInstances: {
        [ProviderInstanceId.make("pi")]: { driver: ProviderDriverKind.make("pi") },
        [ProviderInstanceId.make("registry")]: { driver: acpRegistry },
      },
      projectSettingsOverrides: {
        [ProjectId.make("project-a")]: {
          providerInstances: { [ProviderInstanceId.make("pi")]: { enabled: true } },
        },
      },
    };
    const groups = groupWelcomeAgents(
      [
        // The server checks Pi because project A turns it on; new projects still cannot use it.
        provider("Pi"),
        provider("Broken", {
          enabled: false,
          installed: false,
          status: "error",
          availability: "unavailable",
          unavailableReason: "Invalid config for instance 'broken'.",
        }),
        // A version warning does not change the state: Orbit owns the CLI version.
        provider("Codex", {
          compatibilityAdvisory: {
            status: "broken",
            message: "Update Codex to 0.170 or later.",
            recommendedVersion: "0.170.0",
            recommendedRange: null,
          },
        }),
        // An ACP agent that is not prepared looks like one still being checked.
        provider("Registry", {
          driver: acpRegistry,
          installed: false,
          status: "warning",
          auth: { status: "unknown" },
        }),
      ],
      settings,
      nameOf,
      allowAll,
    );

    expect(names(groups.found)).toEqual(["Codex", "Broken", "Registry"]);
    expect(names(groups.available)).toEqual(["Pi"]);
    expect(groups.readyCount).toBe(1);
    expect(groups.checking).toBe(false);
  });

  it("leaves out agents the computer's policy does not allow, ready or not", () => {
    const groups = groupWelcomeAgents(
      [provider("Codex"), provider("Blocked")],
      undefined,
      nameOf,
      (entry) => entry.driver !== "blocked",
    );

    expect(names(groups.found)).toEqual(["Codex"]);
    expect(groups.readyCount).toBe(1);
  });

  it("reports checking before the computer has sent its providers", () => {
    expect(groupWelcomeAgents(undefined, undefined, nameOf, allowAll)).toEqual({
      checking: true,
      readyCount: 0,
      found: [],
      available: [],
    });
  });
});

describe("cliTerminalStep", () => {
  it("waits for the CLI's own check, then opens its terminal unless Codex is ready", () => {
    const codex = (overrides: Partial<ServerProvider> = {}) => provider("Codex", overrides);
    const step = (overrides?: Partial<ServerProvider>) =>
      cliTerminalStep(codex(overrides), undefined);

    // Still the ChatGPT sign-in runtime, before the switch to the CLI lands.
    expect(
      step({
        setup: { canAuthenticate: true, canInstall: true },
        auth: { status: "unauthenticated" },
      }),
    ).toBe("wait");
    expect(step({ installed: false, status: "warning", auth: { status: "unknown" } })).toBe("wait");
    // Orbit installs a missing CLI, so there is no terminal to open.
    expect(step({ installed: false, status: "error", auth: { status: "unknown" } })).toBe("done");
    expect(step({ installed: false, status: "error" })).toBe("done");
    expect(step({ auth: { status: "unauthenticated" } })).toBe("open");
    // A check that timed out still gets the sign-in command.
    expect(step({ status: "error", auth: { status: "unknown" } })).toBe("open");
    // A version warning does not change what the terminal is for.
    const broken = {
      status: "broken",
      message: "Update Codex.",
      recommendedVersion: null,
      recommendedRange: null,
    } as const;
    expect(step({ compatibilityAdvisory: broken, auth: { status: "unauthenticated" } })).toBe(
      "open",
    );
    // Signed in but needing a look for another reason: a sign-in would not help.
    expect(step({ status: "warning" })).toBe("done");
    expect(step()).toBe("done");
  });
});

describe("turnedOnInstance", () => {
  it("turns an agent on even when older settings keep it off inside its config", () => {
    const pi = ProviderDriverKind.make("pi");
    expect(resolveProviderInstanceEnabled(turnedOnInstance({ driver: pi }))).toBe(true);
    const migrated = turnedOnInstance({ driver: pi, config: { enabled: false, binaryPath: "pi" } });
    expect(resolveProviderInstanceEnabled(migrated)).toBe(true);
    expect(migrated.config).toEqual({ enabled: true, binaryPath: "pi" });
  });
});

describe("codexNeedsSetup", () => {
  it("opens the setup card only while Codex is not signed in", () => {
    const setup = (overrides: Partial<ServerProvider>) =>
      codexNeedsSetup(provider("Codex", overrides), undefined);

    expect(setup({ auth: { status: "unauthenticated" } })).toBe(true);
    // A check that timed out can still sign in with ChatGPT.
    expect(setup({ status: "error", auth: { status: "unknown" } })).toBe(true);
    // Orbit installs a missing Codex; the card has nothing to offer until then.
    expect(setup({ installed: false, status: "error", auth: { status: "unknown" } })).toBe(false);
    // A version warning never hides the card.
    expect(
      setup({
        auth: { status: "unauthenticated" },
        compatibilityAdvisory: {
          status: "broken",
          message: null,
          recommendedVersion: null,
          recommendedRange: null,
        },
      }),
    ).toBe(true);
    expect(setup({})).toBe(false);
    const claude = provider("Claude", { auth: { status: "unauthenticated" } });
    expect(codexNeedsSetup(claude, undefined)).toBe(false);
  });
});

describe("codexCardProvider", () => {
  it("keeps the card on Codex's last status while a rebuild drops it, and closes once signed in", () => {
    const signedOut = provider("Codex", { auth: { status: "unauthenticated" } });
    const card = (providers: ReadonlyArray<ServerProvider>, last: ServerProvider | null = null) =>
      codexCardProvider({ providers, instanceId: signedOut.instanceId, last, settings: undefined });

    expect(card([signedOut])).toBe(signedOut);
    // The instance is missing for one update while it is rebuilt.
    expect(card([], signedOut)).toBe(signedOut);
    expect(card([], provider("Other"))).toBeNull();
    expect(card([provider("Codex")])).toBeNull();
    expect(
      codexCardProvider({
        providers: [signedOut],
        instanceId: null,
        last: null,
        settings: undefined,
      }),
    ).toBeNull();
  });
});

describe("welcomeOffersPhone", () => {
  it("offers the phone only through T3 Connect on the primary computer, and only when allowed", () => {
    const policy = (limits: ManagedPolicySummary["limits"]): ManagedPolicySummary => ({
      organization: "Acme",
      lockedSettings: [],
      ...(limits === undefined ? {} : { limits }),
    });
    const offers = (input: Partial<Parameters<typeof welcomeOffersPhone>[0]>) =>
      welcomeOffersPhone({
        isPrimary: true,
        cloud: true,
        canShare: true,
        policy: undefined,
        ...input,
      });

    expect(offers({})).toBe(true);
    // There is no pairing-code fallback; without T3 Connect the page leaves the phone out.
    expect(offers({ cloud: false })).toBe(false);
    expect(offers({ canShare: false })).toBe(false);
    expect(offers({ policy: policy({ connect: false }) })).toBe(false);
    expect(offers({ policy: policy({ clients: ["desktop"] }) })).toBe(false);
    expect(offers({ isPrimary: false })).toBe(false);
  });
});
