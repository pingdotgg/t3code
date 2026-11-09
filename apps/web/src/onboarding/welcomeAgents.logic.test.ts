import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupWelcomeAgents } from "./welcomeAgents.logic";

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
      nameOf,
      allowAll,
    );

    expect(names(groups.found)).toEqual(["Claude", "Codex", "Zeta"]);
    // Cursor is still being checked; it stays listed instead of disappearing.
    expect(names(groups.available)).toEqual(["Cursor", "Grok", "Pi"]);
    expect(groups.checking).toBe(true);
    expect(groups.readyCount).toBe(2);
  });

  it("leaves out agents the computer's policy does not allow, ready or not", () => {
    const groups = groupWelcomeAgents(
      [provider("Codex"), provider("Blocked")],
      nameOf,
      (entry) => entry.driver !== "blocked",
    );

    expect(names(groups.found)).toEqual(["Codex"]);
    expect(groups.readyCount).toBe(1);
  });

  it("reports checking before the computer has sent its providers", () => {
    expect(groupWelcomeAgents(undefined, nameOf, allowAll)).toEqual({
      checking: true,
      readyCount: 0,
      found: [],
      available: [],
    });
  });
});
