import {
  type ManagedPolicySummary,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { cliTerminalStep, groupWelcomeAgents, welcomePhonePath } from "./welcomePage.logic";

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
        // Signed in and healthy, but the server knows this CLI version is broken.
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

    expect(names(groups.found)).toEqual(["Broken", "Codex", "Registry"]);
    expect(names(groups.available)).toEqual(["Pi"]);
    expect(groups.readyCount).toBe(0);
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
    expect(step({ installed: false, status: "error", auth: { status: "unknown" } })).toBe("open");
    expect(step({ auth: { status: "unauthenticated" } })).toBe("open");
    // A check that timed out still gets the sign-in command.
    expect(step({ status: "error", auth: { status: "unknown" } })).toBe("open");
    expect(step()).toBe("done");
  });
});

describe("welcomePhonePath", () => {
  it("offers T3 Connect or a pairing code only for the primary computer and only when allowed", () => {
    const policy = (limits: ManagedPolicySummary["limits"]): ManagedPolicySummary => ({
      organization: "Acme",
      lockedSettings: [],
      ...(limits === undefined ? {} : { limits }),
    });
    const path = (input: Partial<Parameters<typeof welcomePhonePath>[0]>) =>
      welcomePhonePath({ isPrimary: true, cloud: true, policy: undefined, ...input });

    expect(path({})).toBe("connect");
    expect(path({ cloud: false })).toBe("pairing");
    expect(path({ policy: policy({ connect: false }) })).toBe("pairing");
    expect(path({ policy: policy({ clients: ["desktop"] }) })).toBeNull();
    expect(path({ isPrimary: false })).toBeNull();
  });
});
