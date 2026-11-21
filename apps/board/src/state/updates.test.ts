import {
  type OrchestrationV2ShellThreadStatus,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  countActiveRuns,
  decideUpdate,
  providerItem,
  providerOffer,
  summarizeResults,
  unannounced,
  updateEverythingQueue,
  type UpdateRow,
} from "./updates";

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);

interface Fixture {
  readonly instanceId: string;
  readonly driver: string;
  readonly advisory?: {
    readonly status: "unknown" | "current" | "behind_latest";
    readonly current?: string;
    readonly latest?: string;
    readonly command?: string;
    readonly canUpdate?: boolean;
  };
  readonly latestVersionStatus?: "broken" | "supported";
  readonly updateState?: { readonly status: string; readonly message?: string };
  readonly enabled?: boolean;
}

const provider = (fixture: Fixture) =>
  decodeProvider({
    instanceId: fixture.instanceId,
    driver: fixture.driver,
    enabled: fixture.enabled ?? true,
    installed: true,
    version: fixture.advisory?.current ?? null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-20T06:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(fixture.advisory === undefined
      ? {}
      : {
          versionAdvisory: {
            status: fixture.advisory.status,
            currentVersion: fixture.advisory.current ?? null,
            latestVersion: fixture.advisory.latest ?? null,
            updateCommand: fixture.advisory.command ?? null,
            canUpdate: fixture.advisory.canUpdate ?? false,
            checkedAt: "2026-11-20T06:00:00.000Z",
            message: null,
          },
        }),
    ...(fixture.latestVersionStatus === undefined
      ? {}
      : {
          compatibilityAdvisory: {
            status: "supported",
            latestVersionStatus: fixture.latestVersionStatus,
            message: null,
            recommendedVersion: null,
            recommendedRange: null,
          },
        }),
    ...(fixture.updateState === undefined
      ? {}
      : {
          updateState: {
            startedAt: null,
            finishedAt: null,
            message: fixture.updateState.message ?? null,
            output: null,
            status: fixture.updateState.status,
          },
        }),
  });

const claudeBehind = provider({
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  advisory: {
    status: "behind_latest",
    current: "2.1.300",
    latest: "2.1.312",
    command: "claude update",
    canUpdate: true,
  },
});

const offer = { version: "2.1.312", canUpdate: true };
const idle = { automatic: false, busy: false, activeRuns: 0 };

describe("deciding an update's action", () => {
  it.each([
    ["an offer and the switch off", { ...idle, offer }, "notify"],
    [
      "an automatic switch and no active run, or a run that went idle",
      { ...idle, offer, automatic: true },
      "start",
    ],
    [
      "an automatic switch and an active run",
      { ...idle, offer, automatic: true, activeRuns: 2 },
      "wait",
    ],
    [
      "an instance that cannot update itself",
      { ...idle, offer: { version: "2.1.312", canUpdate: false }, automatic: true },
      "notify",
    ],
    ["no offer", { ...idle, offer: null, automatic: true }, "none"],
    ["an update that runs or already ran", { ...idle, offer, automatic: true, busy: true }, "none"],
  ])("Given %s, when decided, then the action is %s", (_case, input, action) => {
    expect(decideUpdate(input)).toBe(action);
  });
});

describe("counting active runs", () => {
  it("Given threads in several states, when counted, then only unfinished runs count, per instance", () => {
    const thread = (
      status: OrchestrationV2ShellThreadStatus,
      instanceId: string,
      activityRunStatus: "running" | null = null,
    ) => ({ status, providerInstanceId: ProviderInstanceId.make(instanceId), activityRunStatus });
    expect(
      countActiveRuns([
        thread("running", "claudeAgent"),
        thread("waiting", "claudeAgent"),
        thread("idle", "claudeAgent"),
        thread("completed", "claudeAlt"),
        thread("idle", "claudeAlt", "running"),
        thread("failed", "claudeAlt"),
      ]),
    ).toEqual({ total: 3, byInstance: { claudeAgent: 2, claudeAlt: 1 } });
  });
});

describe("reading a provider's offer", () => {
  it("Given a provider behind latest with an update command, when read, then it offers a one-click update", () => {
    expect(providerOffer(claudeBehind)).toEqual({ version: "2.1.312", canUpdate: true });
  });

  it("Given a provider that cannot update itself, when read, then it offers the command only", () => {
    const manual = provider({
      instanceId: "claudeAlt",
      driver: "claudeAgent",
      advisory: {
        status: "behind_latest",
        current: "0.8.0",
        latest: "0.9.1",
        command: "npm i -g @anthropic-ai/claude-code",
      },
    });
    expect(providerItem(manual, "Claude Code", 0)).toMatchObject({
      offer: { version: "0.9.1", canUpdate: false },
      command: "npm i -g @anthropic-ai/claude-code",
      status: "behind",
    });
  });

  it("Given a current, disabled, or broken-latest provider, when read, then nothing is offered", () => {
    const current = provider({
      instanceId: "claudeAlt",
      driver: "claudeAgent",
      advisory: { status: "current", current: "0.9.1", latest: "0.9.1" },
    });
    const disabled = provider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      enabled: false,
      advisory: { status: "behind_latest", latest: "2.1.312", canUpdate: true, command: "x" },
    });
    const broken = provider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      latestVersionStatus: "broken",
      advisory: { status: "behind_latest", latest: "2.1.312", canUpdate: true, command: "x" },
    });
    expect([current, disabled, broken].map(providerOffer)).toEqual([null, null, null]);
    expect(providerItem(broken, "Claude Code", 0).status).toBe("unknown");
  });
});

describe("a provider that is not installed", () => {
  it("Given a provider missing on the host, when listed, then it is flagged and offers nothing", () => {
    const missing = decodeProvider({
      instanceId: "claudeAlt",
      driver: "claudeAgent",
      enabled: true,
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      checkedAt: "2026-11-20T06:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    });
    expect(providerItem(missing, "Claude Code (alt)", 0)).toMatchObject({
      missing: true,
      installed: null,
      offer: null,
      status: "unknown",
    });
  });
});

describe("a provider's progress line", () => {
  it("Given a running update, when listed, then the row is running with the engine's message", () => {
    const running = provider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      advisory: { status: "behind_latest", latest: "2.1.312", canUpdate: true, command: "x" },
      updateState: { status: "running", message: "Installing 2.1.312" },
    });
    expect(providerItem(running, "Claude Code", 0)).toMatchObject({
      running: true,
      note: { text: "Installing 2.1.312", tone: "progress" },
    });
  });

  it("Given a finished update, when listed, then the row keeps the engine's success message", () => {
    const succeeded = provider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      advisory: { status: "current", current: "2.1.312", latest: "2.1.312" },
      updateState: { status: "succeeded", message: "Updated to 2.1.312" },
    });
    expect(providerItem(succeeded, "Claude Code", 0)).toMatchObject({
      running: false,
      note: { text: "Updated to 2.1.312", tone: "progress" },
    });
  });

  it("Given a failed update, when listed, then the row shows the failure as a problem", () => {
    const failed = provider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      advisory: { status: "behind_latest", latest: "2.1.312", canUpdate: true, command: "x" },
      updateState: { status: "failed", message: "EACCES" },
    });
    expect(providerItem(failed, "Claude Code", 0)).toMatchObject({
      running: false,
      note: { text: "EACCES", tone: "problem" },
    });
  });
});

const row = (
  key: string,
  kind: "engine" | "provider",
  fields: Partial<UpdateRow> = {},
): UpdateRow => ({
  key,
  kind,
  name: key,
  driver: null,
  installed: "1.0.0",
  missing: false,
  latest: "1.1.0",
  status: "behind",
  offer: { version: "1.1.0", canUpdate: true },
  command: null,
  running: false,
  note: null,
  activeRuns: 0,
  action: "notify",
  ...fields,
});

describe("update everything", () => {
  it("Given the engine and two providers offered, when queued, then providers go first and the engine last", () => {
    const queue = updateEverythingQueue([
      row("engine", "engine"),
      row("claudeAgent", "provider"),
      row("claudeAlt", "provider"),
    ]);
    expect(queue.map((entry) => entry.key)).toEqual(["claudeAgent", "claudeAlt", "engine"]);
  });

  it("Given a running update, a manual-only offer, and a current item, when queued, then they are skipped", () => {
    const queue = updateEverythingQueue([
      row("a", "provider", { running: true }),
      row("b", "provider", { offer: { version: "1.1.0", canUpdate: false } }),
      row("c", "provider", { offer: null }),
      row("d", "provider"),
    ]);
    expect(queue.map((entry) => entry.key)).toEqual(["d"]);
  });
});

describe("announcing offers", () => {
  it("Given an announced release and a newer one, when filtered, then only the new release is announced", () => {
    const rows = [
      row("claudeAgent", "provider", { offer: { version: "2.1.312", canUpdate: true } }),
      row("claudeAlt", "provider", { offer: { version: "2.1.313", canUpdate: true } }),
      row("engine", "engine", { action: "start" }),
    ];
    expect(
      unannounced(rows, { claudeAgent: "2.1.312", claudeAlt: "2.1.312" }).map((entry) => entry.key),
    ).toEqual(["claudeAlt"]);
  });
});

describe("summarizing a batch of updates", () => {
  it("Given one update, when summarized, then the toast names the item and version", () => {
    expect(summarizeResults([{ name: "Claude Code", version: "2.1.312", failure: null }])).toEqual({
      tone: "success",
      title: "Claude Code updated to 2.1.312",
      description: null,
    });
  });

  it("Given three updates, when summarized, then the toast lists them", () => {
    expect(
      summarizeResults(
        ["Claude Code", "Claude Code (alt)", "Engine"].map((name) => ({
          name,
          version: "1",
          failure: null,
        })),
      )?.title,
    ).toBe("Updated Claude Code, Claude Code (alt), and Engine");
  });

  it("Given a mix of results, when summarized, then the toast counts the failures and says why", () => {
    expect(
      summarizeResults([
        { name: "Claude Code", version: "2.1.312", failure: null },
        { name: "Claude Code (alt)", version: null, failure: "EACCES" },
      ]),
    ).toEqual({
      tone: "error",
      title: "1 of 2 updates failed",
      description: "Claude Code (alt): EACCES",
    });
  });

  it("Given nothing ran, when summarized, then there is no toast", () => {
    expect(summarizeResults([])).toBeNull();
  });
});
