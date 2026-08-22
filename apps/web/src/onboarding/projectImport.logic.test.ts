import type { AgentSessionProjectCandidate } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { partitionOnboardingProjects } from "./projectImport.logic";

const now = Date.parse("2026-08-22T12:00:00.000Z");

function candidate(
  path: string,
  overrides: Partial<AgentSessionProjectCandidate> = {},
): AgentSessionProjectCandidate {
  return {
    title: path.split("/").at(-1) ?? path,
    path,
    sources: ["codex"],
    threadCount: 1,
    lastActiveAt: "2026-08-20T12:00:00.000Z",
    alreadyImported: false,
    ...overrides,
  };
}

describe("partitionOnboardingProjects", () => {
  it("separates already imported projects from available projects", () => {
    const imported = candidate("/projects/current", { alreadyImported: true });
    const available = candidate("/projects/other");

    expect(partitionOnboardingProjects([imported, available], now)).toEqual({
      available: [available],
      recent: [available],
      alreadyImportedCount: 1,
    });
  });

  it("distinguishes an imported-only scan from a scan with no projects", () => {
    expect(
      partitionOnboardingProjects([candidate("/projects/current", { alreadyImported: true })], now),
    ).toMatchObject({
      available: [],
      alreadyImportedCount: 1,
    });

    expect(partitionOnboardingProjects([], now)).toMatchObject({
      available: [],
      alreadyImportedCount: 0,
    });
  });

  it("keeps projects older than 30 days out of the default selection", () => {
    const recent = candidate("/projects/recent");
    const older = candidate("/projects/older", {
      lastActiveAt: "2026-07-01T12:00:00.000Z",
    });

    expect(partitionOnboardingProjects([recent, older], now)).toEqual({
      available: [recent, older],
      recent: [recent],
      alreadyImportedCount: 0,
    });
  });
});
