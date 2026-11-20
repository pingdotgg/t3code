import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type ServerSettings,
  type StorageCleanupReport,
  type StorageCleanupReportEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cleanupValues,
  formatBytes,
  hasCleanupRules,
  latestReport,
  parseDays,
  type ProjectRef,
  removedWorktreePaths,
  reportEntryName,
  resetOverride,
  saveBranchNaming,
  saveCleanupMode,
  saveCleanupRules,
  saveSetupScript,
  worktreeValues,
} from "./settingsModel";

const ALPHA = ProjectId.make("project-alpha");
const BETA = ProjectId.make("project-beta");

const envSetup = {
  id: "setup",
  name: "Setup",
  command: "pnpm install",
  icon: "configure",
  runOnWorktreeCreate: true,
} as const;
const test = {
  id: "test",
  name: "Test",
  command: "pnpm test",
  icon: "test",
  runOnWorktreeCreate: false,
} as const;
const alphaSetup = { ...envSetup, id: "alpha-setup", command: "make bootstrap" } as const;

const settings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  projectSettingsFolded: true,
  worktreesDirectory: "/srv/worktrees",
  defaultProjectScripts: [test, envSetup],
  branchNamePrefix: "t3",
  storageCleanup: {
    ...DEFAULT_SERVER_SETTINGS.storageCleanup,
    worktreeSettledAfterDays: 3,
    worktreeOnDelete: true,
  },
  projectSettingsOverrides: {
    [ALPHA]: {
      defaultProjectScripts: [alphaSetup],
      branchNamePrefix: "feat",
      worktreeCleanup: {
        mode: "custom",
        rules: {
          worktreeKeepWhen: "any-local-files",
          worktreeAfterDays: 30,
          worktreeSettledAfterDays: 0,
          worktreeOnMerge: true,
          worktreeOnDelete: false,
          worktreeUnchanged: false,
        },
      },
    },
  },
};

const alpha: ProjectRef = { id: ALPHA, scripts: [] };
const beta: ProjectRef = { id: BETA, scripts: [] };

describe("worktreeValues", () => {
  it("Given the environment, when mapped, then values are literal and none is inherited", () => {
    expect(worktreeValues(settings, null)).toEqual({
      setupScript: { value: "pnpm install", inherited: false },
      branchNamingMode: { value: "static", inherited: false },
      branchNamePrefix: { value: "t3", inherited: false },
      branchNameInstructions: { value: "", inherited: false },
      worktreesDirectory: "/srv/worktrees",
    });
  });

  it("Given a project with an override, when mapped, then overridden fields show its values", () => {
    const values = worktreeValues(settings, alpha);
    expect(values.setupScript).toEqual({ value: "make bootstrap", inherited: false });
    expect(values.branchNamePrefix).toEqual({ value: "feat", inherited: false });
  });

  it("Given a project with an override, when mapped, then the other fields are inherited", () => {
    const values = worktreeValues(settings, alpha);
    expect(values.branchNamingMode).toEqual({ value: "static", inherited: true });
    expect(values.branchNameInstructions).toEqual({ value: "", inherited: true });
  });

  it("Given a project with no override, when mapped, then every field is the environment's and inherited", () => {
    const values = worktreeValues(settings, beta);
    expect(values.setupScript).toEqual({ value: "pnpm install", inherited: true });
    expect(values.branchNamePrefix).toEqual({ value: "t3", inherited: true });
  });
});

describe("saveSetupScript", () => {
  it("Given the environment, when the setup script is edited, then the RPC input replaces it and keeps the other actions", () => {
    expect(saveSetupScript(settings, null, "pnpm install\npnpm build\n")).toEqual({
      patch: {
        defaultProjectScripts: [test, { ...envSetup, command: "pnpm install\npnpm build" }],
      },
    });
  });

  it("Given a project that inherits, when its script is edited, then the RPC input stores an override with the whole list", () => {
    expect(saveSetupScript(settings, beta, "yarn")).toEqual({
      patch: {
        projectSettingsOverrides: {
          [BETA]: { defaultProjectScripts: [test, { ...envSetup, command: "yarn" }] },
        },
      },
    });
  });

  it("Given a project with other overrides, when its script is edited, then they are kept", () => {
    const input = saveSetupScript(settings, alpha, "make");
    expect(input.patch.projectSettingsOverrides?.[ALPHA]).toMatchObject({
      branchNamePrefix: "feat",
      defaultProjectScripts: [{ ...alphaSetup, command: "make" }],
    });
  });

  it("Given no setup script, when one is written, then a new action runs on worktree creation", () => {
    const bare = { ...settings, defaultProjectScripts: [test] };
    expect(saveSetupScript(bare, null, "echo hi")).toEqual({
      patch: {
        defaultProjectScripts: [
          test,
          {
            id: "setup",
            name: "Setup",
            command: "echo hi",
            icon: "configure",
            runOnWorktreeCreate: true,
          },
        ],
      },
    });
  });

  it("Given an id taken by another project, when a script is added, then it takes the next free id", () => {
    const bare = { ...settings, defaultProjectScripts: [] };
    const input = saveSetupScript(bare, null, "echo hi");
    expect(input.patch.defaultProjectScripts?.[0]?.id).toBe("setup");
    const taken = {
      ...bare,
      projectSettingsOverrides: { [BETA]: { defaultProjectScripts: [envSetup] } },
    };
    expect(saveSetupScript(taken, alpha, "echo").patch.projectSettingsOverrides).toMatchObject({
      [ALPHA]: { defaultProjectScripts: [{ ...envSetup, id: "setup-2", command: "echo" }] },
    });
  });

  it("Given an empty script, when saved, then the setup action is removed", () => {
    expect(saveSetupScript(settings, null, "  ")).toEqual({
      patch: { defaultProjectScripts: [test] },
    });
  });
});

describe("saveBranchNaming", () => {
  it("Given the environment, when the prefix is edited, then the RPC input is the trimmed prefix", () => {
    expect(saveBranchNaming(settings, null, { branchNamePrefix: " ab/ " })).toEqual({
      patch: { branchNamePrefix: "ab/" },
    });
  });

  it("Given a project, when the mode changes, then it joins the project's overrides", () => {
    const input = saveBranchNaming(settings, alpha, { branchNamingMode: "semantic" });
    expect(input.patch.projectSettingsOverrides?.[ALPHA]).toMatchObject({
      branchNamePrefix: "feat",
      branchNamingMode: "semantic",
    });
  });
});

describe("resetOverride", () => {
  it("Given an override among others, when reset, then only that key is dropped", () => {
    const input = resetOverride(settings, ALPHA, ["branchNamePrefix"]);
    const entry = input.patch.projectSettingsOverrides?.[ALPHA];
    expect(entry).toMatchObject({ defaultProjectScripts: [alphaSetup] });
    expect(entry).not.toHaveProperty("branchNamePrefix");
  });

  it("Given the last override, when reset, then the entry is removed", () => {
    const only = {
      ...settings,
      projectSettingsOverrides: { [ALPHA]: { branchNamePrefix: "feat" } },
    };
    expect(resetOverride(only, ALPHA, ["branchNamePrefix"])).toEqual({
      patch: { projectSettingsOverrides: { [ALPHA]: null } },
    });
  });
});

describe("cleanupValues", () => {
  it("Given the environment, when mapped, then the rules come from storage cleanup and are editable", () => {
    expect(cleanupValues(settings, null)).toEqual({
      mode: null,
      editable: true,
      rules: {
        worktreeKeepWhen: "uncommitted-changes",
        worktreeAfterDays: null,
        worktreeSettledAfterDays: 3,
        worktreeOnMerge: false,
        worktreeOnDelete: true,
        worktreeUnchanged: false,
      },
    });
  });

  it("Given a project with custom rules, when mapped, then its own rules are editable", () => {
    const values = cleanupValues(settings, ALPHA);
    expect(values.mode).toBe("custom");
    expect(values.editable).toBe(true);
    expect(values.rules.worktreeSettledAfterDays).toBe(0);
  });

  it("Given a project that inherits, when mapped, then it shows the environment's rules read-only", () => {
    const values = cleanupValues(settings, BETA);
    expect(values.mode).toBe("inherit");
    expect(values.editable).toBe(false);
    expect(values.rules.worktreeOnDelete).toBe(true);
  });

  it("Given a project set to off, when mapped, then every rule is off", () => {
    const off = {
      ...settings,
      projectSettingsOverrides: { [BETA]: { worktreeCleanup: { mode: "off" as const } } },
    };
    expect(cleanupValues(off, BETA)).toMatchObject({
      mode: "off",
      rules: { worktreeOnDelete: false, worktreeSettledAfterDays: null },
    });
  });
});

describe("saveCleanupRules", () => {
  it("Given the environment, when a rule changes, then the RPC input patches storage cleanup", () => {
    expect(saveCleanupRules(settings, null, { worktreeSettledAfterDays: 0 })).toEqual({
      patch: { storageCleanup: { worktreeSettledAfterDays: 0 } },
    });
  });

  it("Given a custom project, when a rule changes, then the rest of its rules are kept", () => {
    const input = saveCleanupRules(settings, ALPHA, { worktreeOnDelete: true });
    expect(input.patch.projectSettingsOverrides?.[ALPHA]).toMatchObject({
      worktreeCleanup: {
        mode: "custom",
        rules: { worktreeAfterDays: 30, worktreeOnMerge: true, worktreeOnDelete: true },
      },
    });
  });
});

describe("saveCleanupMode", () => {
  it("Given a custom project, when set to inherit, then its policy is dropped", () => {
    const input = saveCleanupMode(settings, ALPHA, "inherit");
    expect(input.patch.projectSettingsOverrides?.[ALPHA]).not.toHaveProperty("worktreeCleanup");
  });

  it("Given an inheriting project, when set to custom, then it starts from the environment's rules", () => {
    const input = saveCleanupMode(settings, BETA, "custom");
    expect(input.patch.projectSettingsOverrides?.[BETA]).toEqual({
      worktreeCleanup: { mode: "custom", rules: cleanupValues(settings, null).rules },
    });
  });

  it("Given a project, when set to off, then the RPC input stores the off policy", () => {
    expect(saveCleanupMode(settings, BETA, "off").patch).toEqual({
      projectSettingsOverrides: { [BETA]: { worktreeCleanup: { mode: "off" } } },
    });
  });
});

describe("hasCleanupRules", () => {
  it("Given every rule off, when checked, then Delete now has nothing to run", () => {
    expect(hasCleanupRules(DEFAULT_SERVER_SETTINGS)).toBe(false);
  });

  it("Given an environment rule, when checked, then it is true", () => {
    expect(hasCleanupRules(settings)).toBe(true);
  });

  it("Given only a project's custom rule, when checked, then it is true", () => {
    const only = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: settings.projectSettingsOverrides,
    };
    expect(hasCleanupRules(only)).toBe(true);
  });
});

describe("parseDays", () => {
  it("Given empty text, when parsed, then the rule is off", () => {
    expect(parseDays("  ", 1)).toBeNull();
  });

  it("Given 0 for settled retention, when parsed, then it is zero days", () => {
    expect(parseDays("0", 0)).toBe(0);
  });

  it("Given 0 for inactive retention, when parsed, then it is refused", () => {
    expect(parseDays("0", 1)).toBe("invalid");
  });

  it("Given a fraction or a number past the limit, when parsed, then it is refused", () => {
    expect(parseDays("1.5", 0)).toBe("invalid");
    expect(parseDays("4000", 0)).toBe("invalid");
  });
});

describe("formatBytes", () => {
  it("Given byte counts, when formatted, then they use the nearest unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(300 * 1024 * 1024)).toBe("300 MB");
  });
});

const entry = (overrides: Partial<StorageCleanupReportEntry>): StorageCleanupReportEntry => ({
  kind: "worktree",
  outcome: "removed",
  reason: "Settled 0 days ago.",
  path: "/work/t3/worktrees/alpha/add-search",
  projectPath: "/home/me/alpha",
  threadId: null,
  threadTitle: null,
  bytes: null,
  files: null,
  ...overrides,
});

const report = (
  finishedAt: string,
  entries: StorageCleanupReportEntry[],
): StorageCleanupReport => ({
  trigger: "manual",
  startedAt: finishedAt,
  finishedAt,
  entries,
  counts: { removed: 0, kept: 0, failed: 0 },
  omittedCount: 0,
  bytesFreed: 0,
});

describe("reportEntryName", () => {
  it("Given a worktree entry, when named, then it is the folder's name", () => {
    expect(reportEntryName(entry({}))).toBe("add-search");
  });

  it("Given a log entry, when named, then it reads as rotated logs", () => {
    expect(reportEntryName(entry({ kind: "logs", path: null }))).toBe("Rotated logs");
  });
});

describe("latestReport", () => {
  const older = report("2026-11-20T10:00:00.000Z", []);
  const newer = report("2026-11-20T11:00:00.000Z", []);

  it("Given two reports, when compared, then the later finish wins in either order", () => {
    expect(latestReport(older, newer)).toBe(newer);
    expect(latestReport(newer, older)).toBe(newer);
  });

  it("Given one report, when compared, then it is returned", () => {
    expect(latestReport(null, older)).toBe(older);
    expect(latestReport(older, null)).toBe(older);
    expect(latestReport(null, null)).toBeNull();
  });
});

describe("removedWorktreePaths", () => {
  it("Given removed, kept, and log entries, when collected, then only removed worktree folders remain", () => {
    const paths = removedWorktreePaths(
      report("2026-11-20T10:00:00.000Z", [
        entry({ path: "/w/a" }),
        entry({ path: "/w/b", outcome: "kept" }),
        entry({ kind: "logs", path: "/w/logs" }),
      ]),
    );
    expect([...paths]).toEqual(["/w/a"]);
  });
});
