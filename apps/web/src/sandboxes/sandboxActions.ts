import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { HostedSandbox } from "@t3tools/client-runtime/state/sandboxes";
import type { AgentctlActionResult, AgentctlSandbox, EnvironmentId } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { requestConfirmDialog } from "../confirmDialog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { sandboxEnvironment } from "../state/sandboxes";
import { environmentThreadShells } from "../state/threads";
import { sandboxesOnSeveralHostsAtom } from "./useSandboxes";

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

/** A command's value, or why it failed, such as a host that is not connected. */
function commandOutcome<A, E>(
  result: AtomCommandResult<A, E>,
): { readonly value: A } | { readonly error: string } {
  if (result._tag === "Success") return { value: result.value };
  const failure = squashAtomCommandFailure(result);
  return { error: failure instanceof Error ? failure.message : String(failure) };
}

/** Runs one of the host's Sandbox commands, as the page, palette and banners all do. */
export async function runOnHost<Input, A, E>(
  command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: Input }, A, E>,
  hostEnvironmentId: EnvironmentId,
  input: Input,
) {
  return commandOutcome(
    await runAtomCommand(
      appAtomRegistry,
      command,
      { environmentId: hostEnvironmentId, input },
      { reportFailure: false },
    ),
  );
}

async function runAction(
  title: string,
  command: typeof sandboxEnvironment.start,
  sandbox: HostedSandbox,
) {
  const outcome = await runOnHost(command, sandbox.hostEnvironmentId, { name: sandbox.name });
  const error = "error" in outcome ? outcome.error : (outcome.value as AgentctlActionResult).error;
  if (error === null) return true;
  toastManager.add(stackedThreadToast({ type: "error", title, description: error }));
  return false;
}

// One request of each kind per Sandbox at a time, so a double click does not
// run it twice; a pending start does not block a stop or delete.
const inFlight = new Set<string>();

async function once(sandbox: HostedSandbox, kind: string, run: () => Promise<boolean>) {
  const key = `${kind}:${sandbox.hostEnvironmentId}:${sandbox.name}`;
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  try {
    return await run();
  } finally {
    inFlight.delete(key);
  }
}

/** Threads working in the Sandbox now, read at confirm time from any entry point. */
function runningThreads(sandbox: AgentctlSandbox): number {
  if (sandbox.environmentId === null) return 0;
  return appAtomRegistry
    .get(environmentThreadShells.threadShellsAtom)
    .filter(
      (thread) =>
        thread.environmentId === sandbox.environmentId && threadRuntimeIsActive(thread.runtime),
    ).length;
}

function runningWarning(sandbox: AgentctlSandbox): string {
  const running = runningThreads(sandbox);
  if (running === 0) return "";
  return ` ${running === 1 ? "1 thread is" : `${running} threads are`} still working there.`;
}

async function confirm(message: string, destructive: boolean) {
  return (
    (await requestConfirmDialog(message, destructive ? { variant: "destructive" } : undefined)) ??
    false
  );
}

/** "worker on desktop" once two hosts have Sandboxes, since each can have a "worker". */
function sandboxTitle(sandbox: HostedSandbox): string {
  if (!appAtomRegistry.get(sandboxesOnSeveralHostsAtom)) return sandbox.name;
  const host = appAtomRegistry
    .get(environmentPresentations.presentationsAtom)
    .get(sandbox.hostEnvironmentId)?.entry.target.label;
  return host === undefined ? sandbox.name : `${sandbox.name} on ${host}`;
}

export function startSandbox(sandbox: HostedSandbox): Promise<boolean> {
  return once(sandbox, "start", () =>
    runAction(`Could not start ${sandboxTitle(sandbox)}`, sandboxEnvironment.start, sandbox),
  );
}

export function stopSandbox(sandbox: HostedSandbox): Promise<boolean> {
  return once(sandbox, "stop", () => runStop(sandbox));
}

async function runStop(sandbox: HostedSandbox): Promise<boolean> {
  const busy = runningWarning(sandbox);
  const confirmed = await confirm(
    `Stop ${sandboxTitle(sandbox)}?\nIts disk is kept, so you can start it again. Agents running in it stop with it.${busy}`,
    busy !== "",
  );
  if (!confirmed) return false;
  return runAction(`Could not stop ${sandboxTitle(sandbox)}`, sandboxEnvironment.stop, sandbox);
}

export function deleteSandbox(sandbox: HostedSandbox): Promise<boolean> {
  return once(sandbox, "delete", () => runDelete(sandbox));
}

async function runDelete(sandbox: HostedSandbox): Promise<boolean> {
  const confirmed = await confirm(
    `Delete ${sandboxTitle(sandbox)}?\nThe Sandbox and its disk are deleted, including work that was not pushed. Its project and threads leave T3 Code.${runningWarning(sandbox)}`,
    true,
  );
  if (!confirmed) return false;
  return runAction(`Could not delete ${sandboxTitle(sandbox)}`, sandboxEnvironment.remove, sandbox);
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Names a new Sandbox `<name>-N`, one past the highest number Sandboxes of
 * that name already use. A manifest name that ends in a number keeps it as
 * the starting point instead of getting a second one.
 */
export function suggestSandboxName(
  agentName: string | null,
  existing: ReadonlyArray<AgentctlSandbox>,
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
