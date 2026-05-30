import type { KnownTerminalSession } from "@t3tools/client-runtime";
import { DEFAULT_TERMINAL_ID, type ProjectScript } from "@t3tools/contracts";
import { nextTerminalId, resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

export {
  getTerminalLabel,
  nextTerminalId,
  resolveTerminalSessionLabel,
} from "@t3tools/shared/terminalLabels";

export interface TerminalMenuSession {
  readonly terminalId: string;
  readonly cwd: string | null;
  readonly status: "starting" | "running" | "exited" | "error" | "closed";
  readonly hasRunningSubprocess: boolean;
  /** Server-authoritative title with the same fallback rules as web. */
  readonly displayLabel: string;
  readonly updatedAt: string | null;
}

const terminalMenuSessionOrder = Order.make<TerminalMenuSession>((left, right) => {
  const comparison = left.terminalId.localeCompare(right.terminalId, undefined, { numeric: true });
  if (comparison === 0) {
    return 0;
  }
  return comparison < 0 ? -1 : 1;
});

export function basename(input: string | null): string | null {
  if (!input) {
    return null;
  }

  const normalized = input.replace(/\/+$/, "");
  if (normalized.length === 0) {
    return "/";
  }

  const segments = normalized.split("/");
  return segments[segments.length - 1] ?? normalized;
}

export function getTerminalStatusLabel(input: {
  readonly status: TerminalMenuSession["status"];
  readonly hasRunningSubprocess?: boolean;
}): string {
  if (input.status === "running") {
    return input.hasRunningSubprocess ? "Task running" : "Ready";
  }
  if (input.status === "starting") {
    return "Starting";
  }
  if (input.status === "exited") {
    return "Exited";
  }
  if (input.status === "error") {
    return "Error";
  }

  return "Not started";
}

/**
 * Picks an id for "open another shell". Counts the terminal screen already mounted
 * (`activeRouteTerminalId`) as occupied so an empty session list on the primary route
 * still advances to `term-2` instead of `replace`-navigating to the same `default` tab.
 */
export function nextOpenTerminalId(input: {
  readonly listedTerminalIds: ReadonlyArray<string>;
  readonly activeRouteTerminalId?: string | null;
}): string {
  const listed = input.listedTerminalIds.filter((id) => id.trim().length > 0);
  const routeId = input.activeRouteTerminalId?.trim() ? input.activeRouteTerminalId : null;

  if (!routeId || listed.includes(routeId)) {
    return nextTerminalId(listed);
  }

  return nextTerminalId([...listed, routeId]);
}

export function buildTerminalMenuSessions(input: {
  readonly knownSessions: ReadonlyArray<KnownTerminalSession>;
  readonly workspaceRoot: string | null;
  readonly currentSession?: TerminalMenuSession | null;
}): ReadonlyArray<TerminalMenuSession> {
  const sessionsById = new Map<string, TerminalMenuSession>();

  for (const session of input.knownSessions) {
    if (
      session.state.status !== "running" &&
      session.state.status !== "starting" &&
      session.target.terminalId !== input.currentSession?.terminalId
    ) {
      continue;
    }

    sessionsById.set(session.target.terminalId, {
      terminalId: session.target.terminalId,
      cwd: session.state.summary?.cwd ?? input.workspaceRoot,
      status: session.state.status,
      hasRunningSubprocess: session.state.hasRunningSubprocess,
      displayLabel: resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      updatedAt: session.state.updatedAt,
    });
  }

  if (input.currentSession && !sessionsById.has(input.currentSession.terminalId)) {
    sessionsById.set(input.currentSession.terminalId, input.currentSession);
  }

  return Arr.sort(sessionsById.values(), terminalMenuSessionOrder);
}

export function resolveProjectScriptTerminalId(input: {
  readonly existingTerminalIds: ReadonlyArray<string>;
  readonly hasRunningTerminal: boolean;
}): string {
  if (!input.hasRunningTerminal) {
    return DEFAULT_TERMINAL_ID;
  }

  return nextTerminalId(input.existingTerminalIds);
}

export function projectScriptMenuLabel(script: ProjectScript): string {
  return script.runOnWorktreeCreate ? `${script.name} (setup)` : script.name;
}

export function projectScriptMenuIcon(icon: ProjectScript["icon"]) {
  if (icon === "test") return "flask";
  if (icon === "lint") return "checklist";
  if (icon === "configure") return "wrench.and.screwdriver";
  if (icon === "build") return "hammer";
  if (icon === "debug") return "ladybug";
  return "play";
}
