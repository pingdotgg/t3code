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
    );

    expect(names(groups.found)).toEqual(["Claude", "Codex", "Zeta"]);
    expect(names(groups.available)).toEqual(["Grok", "Pi"]);
    // Cursor is still being checked, so it is in neither group yet.
    expect(groups.checking).toBe(true);
  });

  it("reports checking before the computer has sent its providers", () => {
    expect(groupWelcomeAgents(undefined, nameOf)).toEqual({
      checking: true,
      found: [],
      available: [],
    });
  });
});
