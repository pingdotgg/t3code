import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import {
  groupKaluwaSubagentChildren,
  type KaluwaMachineFacts,
  resolveKaluwaChildAttention,
  resolveKaluwaChildStatus,
  resolveKaluwaConnectionKind,
  resolveKaluwaMachineChip,
  sameKaluwaChildren,
} from "./kaluwaSidebarTree.logic";

const LOCAL = EnvironmentId.make("env-local");
const MINI = EnvironmentId.make("env-mini");
const PARENT = ThreadId.make("parent");

function child(
  id: string,
  options: {
    readonly native?: boolean;
    readonly createdAt?: string;
    readonly environmentId?: EnvironmentId;
    readonly delegatedFromParent?: boolean;
    readonly overrides?: Parameters<typeof makeThreadFixture>[0];
  } = {},
) {
  const threadId = ThreadId.make(id);
  const thread = makeThreadFixture({
    id: threadId,
    environmentId: options.environmentId ?? LOCAL,
    title: `Explore · ${id}`,
    lineage: options.delegatedFromParent
      ? { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null }
      : { rootThreadId: PARENT, parentThreadId: PARENT, relationshipToParent: "subagent" },
    ...options.overrides,
  });
  return {
    ...thread,
    createdAt: options.createdAt ?? thread.createdAt,
    delegatedFrom: options.delegatedFromParent
      ? { environmentId: LOCAL, threadId: PARENT, title: "Parent" }
      : thread.delegatedFrom,
    source: {
      ...thread.source,
      creationSource: options.native ? ("provider" as const) : thread.source.creationSource,
    },
  };
}

const runtime = (status: "running" | "idle") => ({
  status,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: null,
  lastError: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const run = (status: "running" | "completed" | "failed") => ({
  runId: RunId.make("run-1"),
  status,
  requestedAt: null,
  startedAt: null,
  completedAt: status === "running" ? null : "2026-01-01T00:00:00.000Z",
  assistantMessageId: null,
});

describe("groupKaluwaSubagentChildren", () => {
  it("nests sub-agents and cross-machine delegated tasks under their parent, oldest first", () => {
    const parent = makeThreadFixture({ id: PARENT, environmentId: LOCAL });
    const later = child("b", { createdAt: "2026-01-02T00:00:00.000Z" });
    const earlier = child("a", { native: true, createdAt: "2026-01-01T00:00:00.000Z" });
    const remote = child("c", {
      environmentId: MINI,
      delegatedFromParent: true,
      createdAt: "2026-01-03T00:00:00.000Z",
    });
    const groups = groupKaluwaSubagentChildren([parent, later, earlier, remote]);
    const children = groups.get(`${LOCAL}:${PARENT}`) ?? [];
    expect(children.map((entry) => [entry.threadId, entry.kind])).toEqual([
      ["a", "native"],
      ["b", "delegated"],
      ["c", "delegated"],
    ]);
    expect(groups.size).toBe(1);
  });

  it("leaves out side chats, workflow steps and archived children", () => {
    const sideChat = child("side", {
      overrides: {
        lineage: {
          rootThreadId: PARENT,
          parentThreadId: PARENT,
          relationshipToParent: null,
          sideChat: true,
        },
      },
    });
    const archived = child("gone", { overrides: { archivedAt: "2026-01-01T00:00:00.000Z" } });
    expect(groupKaluwaSubagentChildren([sideChat, archived]).size).toBe(0);
  });
});

describe("resolveKaluwaChildStatus", () => {
  const base = {
    runtime: null,
    latestRun: null,
    blockedOnThreadWait: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
  };

  it("puts requests first, then live work, then how the last run ended", () => {
    expect(resolveKaluwaChildStatus({ ...base, hasPendingApprovals: true }, "delegated")).toBe(
      "approval",
    );
    expect(
      resolveKaluwaChildStatus({ ...base, pendingSubagentRequest: "user_input" }, "delegated"),
    ).toBe("input");
    expect(resolveKaluwaChildStatus({ ...base, runtime: runtime("running") }, "delegated")).toBe(
      "working",
    );
    expect(
      resolveKaluwaChildStatus(
        { ...base, runtime: runtime("running"), blockedOnThreadWait: true },
        "delegated",
      ),
    ).toBe("waiting");
    expect(resolveKaluwaChildStatus({ ...base, latestRun: run("failed") }, "delegated")).toBe(
      "failed",
    );
    expect(resolveKaluwaChildStatus({ ...base, latestRun: run("completed") }, "delegated")).toBe(
      "done",
    );
    expect(resolveKaluwaChildStatus(base, "delegated")).toBe("idle");
  });

  it("reads a native sub-agent waiting on its own children as still running", () => {
    expect(
      resolveKaluwaChildStatus(
        { ...base, runtime: runtime("running"), blockedOnThreadWait: true },
        "native",
      ),
    ).toBe("working");
  });
});

describe("resolveKaluwaChildAttention", () => {
  it("marks unseen failures, then approvals, then questions; finished work stays quiet", () => {
    expect(resolveKaluwaChildAttention([{ status: "done", unseenFailure: false }], null)).toBe(
      null,
    );
    expect(
      resolveKaluwaChildAttention(
        [
          { status: "approval", unseenFailure: false },
          { status: "failed", unseenFailure: true },
        ],
        null,
      ),
    ).toBe("failed");
    expect(resolveKaluwaChildAttention([{ status: "input", unseenFailure: false }], null)).toBe(
      "input",
    );
    expect(resolveKaluwaChildAttention([{ status: "failed", unseenFailure: false }], null)).toBe(
      null,
    );
  });

  it("follows a request rolled up from a deeper or remote child the list does not hold", () => {
    expect(resolveKaluwaChildAttention([], "approval")).toBe("approval");
    expect(resolveKaluwaChildAttention([], "user_input")).toBe("input");
  });
});

describe("sameKaluwaChildren", () => {
  it("ignores new objects that show the same thing", () => {
    const first = groupKaluwaSubagentChildren([child("a")]).get(`${LOCAL}:${PARENT}`)!;
    const second = groupKaluwaSubagentChildren([child("a")]).get(`${LOCAL}:${PARENT}`)!;
    expect(first).not.toBe(second);
    expect(sameKaluwaChildren(first, second)).toBe(true);
    const failed = groupKaluwaSubagentChildren([
      child("a", { overrides: { latestRun: run("failed") } }),
    ]).get(`${LOCAL}:${PARENT}`)!;
    expect(sameKaluwaChildren(first, failed)).toBe(false);
  });
});

describe("machine chip", () => {
  const facts = (
    environmentId: EnvironmentId,
    overrides: Partial<KaluwaMachineFacts> = {},
  ): KaluwaMachineFacts => ({
    environmentId,
    label: environmentId === LOCAL ? "nipun-mbp" : "Mac mini",
    machineKind: "laptop",
    os: "darwin",
    arch: "arm64",
    hostname: null,
    targetTag: environmentId === LOCAL ? "PrimaryConnectionTarget" : "BearerConnectionTarget",
    displayUrl: environmentId === LOCAL ? "http://127.0.0.1:3773" : "http://mini.tail1234.ts.net",
    phase: "connected",
    ...overrides,
  });

  it("is hidden while this is the only machine", () => {
    expect(
      resolveKaluwaMachineChip({
        environmentIds: [LOCAL],
        machines: new Map([[LOCAL, facts(LOCAL)]]),
        primaryEnvironmentId: LOCAL,
      }),
    ).toBeNull();
  });

  it("names the folder's machine, leads with this one, and lists the rest", () => {
    const machines = new Map([
      [LOCAL, facts(LOCAL)],
      [MINI, facts(MINI, { phase: "reconnecting" })],
    ]);
    const remote = resolveKaluwaMachineChip({
      environmentIds: [MINI],
      machines,
      primaryEnvironmentId: LOCAL,
    });
    expect(remote).toMatchObject({
      label: "Mac mini",
      isPrimary: false,
      connection: "tailscale",
      state: "connecting",
      others: [],
    });
    expect(remote!.colorIndex).toBeGreaterThan(0);
    const both = resolveKaluwaMachineChip({
      environmentIds: [MINI, LOCAL, MINI],
      machines,
      primaryEnvironmentId: LOCAL,
    });
    expect(both).toMatchObject({
      environmentId: LOCAL,
      isPrimary: true,
      connection: "local",
      colorIndex: 0,
      others: [{ environmentId: MINI, label: "Mac mini" }],
    });
  });

  it("tells LAN, Tailscale, relay and SSH routes apart", () => {
    const kind = (targetTag: KaluwaMachineFacts["targetTag"], displayUrl: string | null) =>
      resolveKaluwaConnectionKind({ targetTag, displayUrl });
    expect(kind("BearerConnectionTarget", "http://100.101.5.6:3773")).toBe("tailscale");
    expect(kind("BearerConnectionTarget", "http://192.168.1.20:3773")).toBe("lan");
    expect(kind("BearerConnectionTarget", "https://code.example.com")).toBe("direct");
    expect(kind("BearerConnectionTarget", null)).toBe("direct");
    expect(kind("RelayConnectionTarget", null)).toBe("relay");
    expect(kind("SshConnectionTarget", "me@box")).toBe("ssh");
  });
});
