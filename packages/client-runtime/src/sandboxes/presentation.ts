import type { AgentctlSandbox, AgentctlSandboxesSnapshot } from "@t3tools/contracts";

export type SandboxTone = "success" | "info" | "warning" | "error" | "muted";

/** What a Sandbox is doing, with T3's own pending request taking precedence. */
export function sandboxStatus(sandbox: AgentctlSandbox): {
  readonly label: string;
  readonly tone: SandboxTone;
} {
  switch (sandbox.action) {
    case "creating":
      return { label: "Creating…", tone: "info" };
    case "starting":
      return { label: "Starting…", tone: "info" };
    case "stopping":
      return { label: "Stopping…", tone: "info" };
    case "deleting":
      return { label: "Deleting…", tone: "info" };
    case null:
      break;
  }
  switch (sandbox.phase) {
    case "ready":
      if (!sandbox.sshAccess) return { label: "Running, no SSH", tone: "warning" };
      if (sandbox.connectError !== null) return { label: "Cannot connect", tone: "error" };
      // T3 installs and starts its server in the Sandbox before it is reachable.
      if (sandbox.environmentId === null) return { label: "Connecting…", tone: "info" };
      return { label: "Running", tone: "success" };
    case "stopped":
      return { label: "Stopped", tone: "muted" };
    case "pending":
    case "provisioning":
      return { label: "Provisioning…", tone: "info" };
    case "starting":
      return { label: "Starting…", tone: "info" };
    case "stopping":
      return { label: "Stopping…", tone: "info" };
    case "retrying":
      return { label: "Retrying", tone: "warning" };
    case "unresponsive":
      return { label: "Unresponsive", tone: "error" };
    case "failed":
      return { label: "Failed", tone: "error" };
    case "terminating":
      return { label: "Deleting…", tone: "info" };
  }
}

/** The line that explains the status: progress, or why something failed. */
export function sandboxStatusDetail(sandbox: AgentctlSandbox): string | null {
  if (sandbox.actionError !== null) return sandbox.actionError;
  if (!sandbox.sshAccess)
    return "Add `access: [{type: ssh}]` to its manifest to use it from T3 Code.";
  return sandbox.connectError ?? sandbox.detail;
}

export const canStartSandbox = (sandbox: AgentctlSandbox) =>
  sandbox.action === null && sandbox.phase === "stopped";

// Stop and Delete stay available while a create or start is pending, so a
// Sandbox agentctl is stuck on is never out of reach.
const isLeaving = (sandbox: AgentctlSandbox) =>
  sandbox.action === "stopping" || sandbox.action === "deleting" || sandbox.phase === "terminating";

export const canStopSandbox = (sandbox: AgentctlSandbox) =>
  !isLeaving(sandbox) && sandbox.phase !== "stopped" && sandbox.phase !== "stopping";

export const canDeleteSandbox = (sandbox: AgentctlSandbox) => !isLeaving(sandbox);

/** What the composer says about a thread's Sandbox when it cannot reach it. */
export function sandboxBannerState(sandbox: AgentctlSandbox): "stopped" | "starting" | null {
  if (sandbox.action === null && sandbox.phase === "stopped") return "stopped";
  if (sandbox.action === "starting" || sandbox.phase === "starting") return "starting";
  return null;
}

/** "4 CPUs · 6Gi memory · 32Gi disk · mediated network", from the manifest. */
export function sandboxSpecLine(sandbox: AgentctlSandbox): string | null {
  const parts = [
    sandbox.cpu === null ? null : `${sandbox.cpu} ${sandbox.cpu === "1" ? "CPU" : "CPUs"}`,
    sandbox.memory === null ? null : `${sandbox.memory} memory`,
    sandbox.disk === null ? null : `${sandbox.disk} disk`,
    sandbox.network === null ? null : `${sandbox.network} network`,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** "3 threads, 1 running". */
export function sandboxThreadSummary(threads: number, running: number): string {
  if (threads === 0) return "No threads";
  return `${threads} ${threads === 1 ? "thread" : "threads"}${running > 0 ? `, ${running} running` : ""}`;
}

/** "2 Sandboxes", or why a host has none to show. */
export function sandboxHostSummary(snapshot: AgentctlSandboxesSnapshot): string {
  if (snapshot.status === "unavailable") return "agentctl is not available";
  if (snapshot.status === "loading") return "Looking for Sandboxes…";
  const count = snapshot.sandboxes.length;
  return `${count} ${count === 1 ? "Sandbox" : "Sandboxes"}`;
}

/** "worker on desktop" once two hosts have Sandboxes, since each can have a "worker". */
export function sandboxTitle(name: string, hostLabel: string | null): string {
  return hostLabel === null ? name : `${name} on ${hostLabel}`;
}

export interface SandboxConfirmation {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly destructive: boolean;
}

function workingWarning(working: number): string {
  if (working === 0) return "";
  return ` ${working === 1 ? "1 thread is" : `${working} threads are`} still working there.`;
}

/** Stop asks first, and warns as a destructive step when threads are still working there. */
export function stopSandboxConfirmation(title: string, working: number): SandboxConfirmation {
  return {
    title: `Stop ${title}?`,
    message: `Its disk is kept, so you can start it again. Agents running in it stop with it.${workingWarning(working)}`,
    confirmLabel: "Stop",
    destructive: working > 0,
  };
}

export function deleteSandboxConfirmation(title: string, working: number): SandboxConfirmation {
  return {
    title: `Delete ${title}?`,
    message: `The Sandbox and its disk are deleted, including work that was not pushed. Its project and threads leave T3 Code.${workingWarning(working)}`,
    confirmLabel: "Delete",
    destructive: true,
  };
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Names a new Sandbox `<name>-N`, one past the highest number Sandboxes of
 * that name already use. A manifest name that ends in a number keeps it as
 * the starting point instead of getting a second one.
 */
export function suggestSandboxName(
  agentName: string | null,
  existing: ReadonlyArray<Pick<AgentctlSandbox, "name">>,
): string {
  const name = agentName ?? "sandbox";
  const numbered = /^(.*)-(\d+)$/.exec(name);
  const base = numbered?.[1] ?? name;
  const pattern = new RegExp(`^${escapeRegExp(base)}-(\\d+)$`);
  let highest = numbered ? Number(numbered[2]) - 1 : 0;
  for (const sandbox of existing) {
    const match = pattern.exec(sandbox.name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${base}-${highest + 1}`;
}
