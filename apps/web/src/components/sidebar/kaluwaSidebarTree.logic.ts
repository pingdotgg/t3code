// Fork: Kaluwa's folder tree extras: sub-agents nested under their parent thread, the marker
// for a child that needs the user, and the chip saying which machine a project lives on.
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { hasUnseenRunFailure } from "@t3tools/client-runtime/state/thread-settled";
import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ExecutionEnvironmentPlatformOs,
  isProviderNativeSubagentThread,
} from "@t3tools/contracts";

export type KaluwaChildStatus =
  | "working"
  | "waiting"
  | "approval"
  | "input"
  | "failed"
  | "done"
  | "idle";

export type KaluwaChildAttention = "failed" | "approval" | "input";

export interface KaluwaSubagentChild {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: EnvironmentThreadShell["id"];
  /** `native` runs inside its parent's turn and is read-only; `delegated` is a full thread. */
  readonly kind: "delegated" | "native";
  readonly title: string;
  readonly providerInstanceId: string;
  readonly status: KaluwaChildStatus;
  /** A failure the user has not opened yet, which marks the parent. */
  readonly unseenFailure: boolean;
  readonly createdAt: string;
}

type ChildShell = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "title"
  | "lineage"
  | "delegatedFrom"
  | "archivedAt"
  | "createdAt"
  | "providerInstanceId"
  | "modelSelection"
  | "runtime"
  | "latestRun"
  | "blockedOnThreadWait"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "lastVisitedAt"
> & { readonly source: Pick<EnvironmentThreadShell["source"], "creationSource" | "lineage"> };

const ACTIVE_RUNTIME = new Set(["queued", "preparing", "starting", "running", "waiting"]);

export function resolveKaluwaChildStatus(
  thread: Pick<
    ChildShell,
    | "runtime"
    | "latestRun"
    | "blockedOnThreadWait"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
  >,
  kind: KaluwaSubagentChild["kind"],
): KaluwaChildStatus {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") return "approval";
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") return "input";
  const runtime = thread.runtime?.status;
  if (runtime === "running" && thread.blockedOnThreadWait === true) {
    return kind === "native" ? "working" : "waiting";
  }
  if (runtime !== undefined && ACTIVE_RUNTIME.has(runtime)) return "working";
  if (runtime === "failed" || thread.latestRun?.status === "failed") return "failed";
  if (thread.latestRun?.status === "completed") return "done";
  return kind === "native" && thread.latestRun !== null ? "done" : "idle";
}

/** The listed thread a child shows under, or null when it is not a sub-agent. */
function parentKeyOf(thread: ChildShell): string | null {
  if (thread.lineage.sideChat === true || thread.lineage.workflowStep === true) return null;
  if (thread.lineage.relationshipToParent === "subagent") {
    return thread.lineage.parentThreadId === null
      ? null
      : scopedThreadKey(scopeThreadRef(thread.environmentId, thread.lineage.parentThreadId));
  }
  const from = thread.delegatedFrom;
  return from == null ? null : scopedThreadKey(scopeThreadRef(from.environmentId, from.threadId));
}

function toKaluwaSubagentChild(thread: ChildShell): KaluwaSubagentChild {
  const kind = isProviderNativeSubagentThread({
    lineage: thread.source.lineage,
    creationSource: thread.source.creationSource,
  })
    ? "native"
    : "delegated";
  const status = resolveKaluwaChildStatus(thread, kind);
  return {
    key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    environmentId: thread.environmentId,
    threadId: thread.id,
    kind,
    title: thread.title,
    providerInstanceId: thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId,
    status,
    unseenFailure: status === "failed" && hasUnseenRunFailure(thread),
    createdAt: thread.createdAt,
  };
}

/**
 * Sub-agents by their parent's thread key, oldest first. Only shells the client holds count: a
 * server that trims idle sub-agents from the shell sends live ones only, so finished children can
 * be missing until the thread view loads them.
 */
export function groupKaluwaSubagentChildren(
  threads: ReadonlyArray<ChildShell>,
): ReadonlyMap<string, ReadonlyArray<KaluwaSubagentChild>> {
  const byParent = new Map<string, KaluwaSubagentChild[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const parentKey = parentKeyOf(thread);
    if (parentKey === null) continue;
    const child = toKaluwaSubagentChild(thread);
    const siblings = byParent.get(parentKey);
    if (siblings) siblings.push(child);
    else byParent.set(parentKey, [child]);
  }
  for (const children of byParent.values()) {
    children.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.key.localeCompare(right.key),
    );
  }
  return byParent;
}

export function sameKaluwaChildren(
  left: ReadonlyArray<KaluwaSubagentChild>,
  right: ReadonlyArray<KaluwaSubagentChild>,
): boolean {
  return (
    left.length === right.length &&
    left.every((child, index) => {
      const other = right[index]!;
      return (
        child.key === other.key &&
        child.kind === other.kind &&
        child.title === other.title &&
        child.providerInstanceId === other.providerInstanceId &&
        child.status === other.status &&
        child.unseenFailure === other.unseenFailure
      );
    })
  );
}

/**
 * What a parent's marker says. `pendingSubagentRequest` already rolls up requests from deeper
 * descendants and from tasks on linked environments, so it covers children not listed here.
 */
export function resolveKaluwaChildAttention(
  children: ReadonlyArray<Pick<KaluwaSubagentChild, "status" | "unseenFailure">>,
  pendingSubagentRequest: EnvironmentThreadShell["pendingSubagentRequest"],
): KaluwaChildAttention | null {
  if (children.some((child) => child.unseenFailure)) return "failed";
  if (
    pendingSubagentRequest === "approval" ||
    children.some((child) => child.status === "approval")
  ) {
    return "approval";
  }
  if (
    pendingSubagentRequest === "user_input" ||
    children.some((child) => child.status === "input")
  ) {
    return "input";
  }
  return null;
}

export type KaluwaConnectionKind = "local" | "tailscale" | "lan" | "relay" | "ssh" | "direct";
export type KaluwaMachineState = "online" | "connecting" | "offline";

export interface KaluwaMachineFacts {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machineKind: EnvironmentMachineKind;
  readonly os: ExecutionEnvironmentPlatformOs | null;
  readonly arch: string | null;
  readonly hostname: string | null;
  readonly targetTag:
    | "PrimaryConnectionTarget"
    | "BearerConnectionTarget"
    | "RelayConnectionTarget"
    | "SshConnectionTarget";
  readonly displayUrl: string | null;
  readonly phase: string;
}

export interface KaluwaMachineChipModel {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  readonly machineKind: EnvironmentMachineKind;
  readonly os: ExecutionEnvironmentPlatformOs | null;
  readonly arch: string | null;
  readonly hostname: string | null;
  readonly connection: KaluwaConnectionKind;
  readonly state: KaluwaMachineState;
  /** The folder's other machines, for the hover card. */
  readonly others: ReadonlyArray<Pick<KaluwaMachineChipModel, "environmentId" | "label">>;
  /** Index into the machine colour palette; the primary machine is always 0. */
  readonly colorIndex: number;
}

const TAILNET_HOST = /(^|\.)ts\.net$/i;

function isTailnetAddress(host: string): boolean {
  if (TAILNET_HOST.test(host)) return true;
  const octets = host.split(".").map(Number);
  // Tailscale hands out 100.64.0.0/10.
  return (
    octets.length === 4 &&
    octets[0] === 100 &&
    octets[1] !== undefined &&
    octets[1] >= 64 &&
    octets[1] <= 127
  );
}

function isPrivateAddress(host: string): boolean {
  return (
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(host) ||
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".lan")
  );
}

export function resolveKaluwaConnectionKind(
  facts: Pick<KaluwaMachineFacts, "targetTag" | "displayUrl">,
): KaluwaConnectionKind {
  switch (facts.targetTag) {
    case "PrimaryConnectionTarget":
      return "local";
    case "RelayConnectionTarget":
      return "relay";
    case "SshConnectionTarget":
      return "ssh";
    case "BearerConnectionTarget": {
      let host: string | null = null;
      try {
        host = facts.displayUrl === null ? null : new URL(facts.displayUrl).hostname;
      } catch {
        host = null;
      }
      if (host === null) return "direct";
      if (isTailnetAddress(host)) return "tailscale";
      return isPrivateAddress(host) ? "lan" : "direct";
    }
  }
}

export function resolveKaluwaMachineState(phase: string): KaluwaMachineState {
  if (phase === "connected" || phase === "available") return "online";
  if (phase === "connecting" || phase === "reconnecting") return "connecting";
  return "offline";
}

/** Stable colour slot per machine, so a machine keeps its edge colour across folders. */
function kaluwaMachineColorIndex(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  slots: number,
): number {
  if (environmentId === primaryEnvironmentId) return 0;
  let hash = 0;
  for (let index = 0; index < environmentId.length; index += 1) {
    hash = (hash * 31 + environmentId.charCodeAt(index)) | 0;
  }
  return 1 + (Math.abs(hash) % (slots - 1));
}

const KALUWA_MACHINE_COLOR_SLOTS = 6;

/**
 * The chip for a folder: its first machine, with the rest named on hover. Null while only one
 * machine is known, since a chip that always says "this machine" says nothing.
 */
export function resolveKaluwaMachineChip(input: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly machines: ReadonlyMap<EnvironmentId, KaluwaMachineFacts>;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): KaluwaMachineChipModel | null {
  if (input.machines.size < 2) return null;
  const ids = [...new Set(input.environmentIds)];
  // The primary machine leads, so a folder on this machine and a linked one reads "this machine".
  ids.sort(
    (left, right) =>
      Number(right === input.primaryEnvironmentId) - Number(left === input.primaryEnvironmentId),
  );
  const firstId = ids[0];
  if (firstId === undefined) return null;
  const facts = input.machines.get(firstId);
  const isPrimary = firstId === input.primaryEnvironmentId;
  return {
    environmentId: firstId,
    label: facts?.label ?? firstId,
    isPrimary,
    machineKind: facts?.machineKind ?? "server",
    os: facts?.os ?? null,
    arch: facts?.arch ?? null,
    hostname: facts?.hostname ?? null,
    connection: facts ? resolveKaluwaConnectionKind(facts) : "direct",
    state: facts ? resolveKaluwaMachineState(facts.phase) : "offline",
    others: ids.slice(1).map((environmentId) => ({
      environmentId,
      label: input.machines.get(environmentId)?.label ?? environmentId,
    })),
    colorIndex: kaluwaMachineColorIndex(
      firstId,
      input.primaryEnvironmentId,
      KALUWA_MACHINE_COLOR_SLOTS,
    ),
  };
}
