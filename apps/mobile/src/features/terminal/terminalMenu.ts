import { type KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import { DEFAULT_TERMINAL_ID, type ProjectScript } from "@t3tools/contracts";
import { fileBasename, isWindowsAbsolutePath } from "@t3tools/shared/path";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import { resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabelsCopy";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

export { resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabelsCopy";

export interface TerminalMenuSession {
  readonly terminalId: string;
  readonly cwd: string | null;
  readonly status: "starting" | "running" | "exited" | "error" | "closed";
  readonly hasRunningSubprocess: boolean;
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
  // A backslash is a legal character in POSIX folder names, so only Windows paths split on it.
  if (isWindowsAbsolutePath(input)) {
    return fileBasename(input);
  }
  const normalized = input.replace(/\/+$/, "");
  return normalized.length === 0 ? "/" : normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function getTerminalStatusLabel(
  input: {
    readonly status: TerminalMenuSession["status"];
    readonly hasRunningSubprocess?: boolean;
  },
  resolve: MessageResolver = m,
): string {
  if (input.status === "running") {
    return input.hasRunningSubprocess
      ? resolve(msg("Task running", { $context: "terminal status" }))
      : resolve(msg("Ready", { $context: "terminal status" }));
  }
  if (input.status === "starting") {
    return resolve(msg("Starting", { $context: "terminal status" }));
  }
  if (input.status === "exited") {
    return resolve(msg("Exited", { $context: "terminal status" }));
  }
  if (input.status === "error") {
    return resolve(msg("Error", { $context: "terminal status" }));
  }

  return resolve(msg("Not started", { $context: "terminal status" }));
}

/** Count the mounted terminal before sessions load, or new-terminal navigation may replace it with itself. */
export function nextOpenTerminalId(input: {
  readonly listedTerminalIds: ReadonlyArray<string>;
  readonly activeRouteTerminalId?: string | null;
  readonly uniqueSuffix?: string;
}): string {
  const listed = input.listedTerminalIds.filter((id) => id.trim().length > 0);
  const routeId = input.activeRouteTerminalId?.trim() ? input.activeRouteTerminalId : null;

  if (!routeId || listed.includes(routeId)) {
    return nextTerminalId(listed, input.uniqueSuffix);
  }

  return nextTerminalId([...listed, routeId], input.uniqueSuffix);
}

export function buildTerminalMenuSessions(
  input: {
    readonly knownSessions: ReadonlyArray<KnownTerminalSession>;
    readonly workspaceRoot: string | null;
    readonly currentSession?: TerminalMenuSession | null;
  },
  resolve: MessageResolver = m,
): ReadonlyArray<TerminalMenuSession> {
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
      displayLabel: resolveTerminalSessionLabel(
        session.target.terminalId,
        session.state.summary,
        resolve,
      ),
      updatedAt: session.state.updatedAt,
    });
  }

  if (input.currentSession && !sessionsById.has(input.currentSession.terminalId)) {
    sessionsById.set(input.currentSession.terminalId, input.currentSession);
  }

  return Arr.sort(sessionsById.values(), terminalMenuSessionOrder);
}

/** Returns null when no other live session remains; dismiss the terminal UI. */
export function previousLiveTerminalId(input: {
  readonly sessions: ReadonlyArray<TerminalMenuSession>;
  readonly exitedTerminalId: string;
}): string | null {
  const live = Arr.sort(
    input.sessions.filter(
      (session) =>
        session.terminalId !== input.exitedTerminalId &&
        (session.status === "running" || session.status === "starting"),
    ),
    terminalMenuSessionOrder,
  );
  if (live.length === 0) {
    return null;
  }

  const below = live.filter(
    (session) =>
      session.terminalId.localeCompare(input.exitedTerminalId, undefined, { numeric: true }) < 0,
  );
  return (below[below.length - 1] ?? live[0])?.terminalId ?? null;
}

export function resolveProjectScriptTerminalId(input: {
  readonly existingTerminalIds: ReadonlyArray<string>;
  readonly hasRunningTerminal: boolean;
  readonly uniqueSuffix?: string;
}): string {
  if (!input.hasRunningTerminal && input.uniqueSuffix === undefined) {
    return DEFAULT_TERMINAL_ID;
  }

  return nextTerminalId(input.existingTerminalIds, input.uniqueSuffix);
}

export function projectScriptMenuIcon(icon: ProjectScript["icon"]) {
  if (icon === "test") return "flask";
  if (icon === "lint") return "checklist";
  if (icon === "configure") return "wrench.and.screwdriver";
  if (icon === "build") return "hammer";
  if (icon === "debug") return "ladybug";
  return "play";
}
