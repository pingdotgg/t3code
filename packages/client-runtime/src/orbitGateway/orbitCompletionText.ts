import { ORBIT_CONTAINER_PROCESS_INACTIVE, ORBIT_CREATE_WORKSPACE_FAILED } from "./client.ts";
import { orbitCompletionCancelled, orbitCompletionPhase } from "./orbitCompletion.ts";
import { orbitCompletionProcessFailureCanRetry } from "./orbitCompletionPolicy.ts";
import type { OrbitThreadStart } from "./threadStart.ts";

/**
 * Conn: the words of a start's setup card, shared by the desktop card and the phone's start row
 * so both say the same. Only Conn's existing strings live here.
 */

export const ORBIT_SETUP_FAILED_TITLE = "Instance setup failed";
export const ORBIT_SETUP_CANCELLED_TITLE = "Instance setup cancelled";
export const ORBIT_INSTANCE_STAYS_LINE = "The Instance stays; remove it in Orbit.";
export const ORBIT_WORKSPACE_FAILED_TEXT = "Orbit could not set up the workspace.";

/**
 * A Project process that did not start. With a Retry the process can be changed in the Project's
 * settings first; without one the Instance must be made again.
 */
export function orbitProcessFailureText(
  unit: string | null | undefined,
  canRetry: boolean,
): string {
  const name = unit?.trim();
  const next = canRetry
    ? "Change or remove this process in the Project's Orbit settings, then retry."
    : "Fix the Project, remove this Instance in Orbit, then create it again.";
  return `A process of this Project did not start${name ? `: ${name}` : ""}. ${next}`;
}

/** Orbit's code and detail as one line, `code · detail`; null without a detail. */
export function orbitErrorDetailText(
  code: string | null | undefined,
  detail: string | null | undefined,
): string | null {
  const text = detail?.trim();
  if (!text) return null;
  return code ? `${code} · ${text}` : text;
}

/** What a failed (or cancelled, with a Retry) completion shows: title, message, detail, Retry. */
export interface OrbitCompletionFailure {
  readonly title: string;
  /** Conn's message for the code; null for codes without one (spec Q2). */
  readonly message: string | null;
  /** `code · detail`, or the code alone when there is no message and no detail. */
  readonly detailLine: string | null;
  readonly canRetry: boolean;
  /** "The Instance stays; remove it in Orbit." fits, unless the process line names the next step. */
  readonly instanceStays: boolean;
}

/** Null unless the start's completion failed, or was cancelled outside a removal. */
export function orbitCompletionFailure(start: OrbitThreadStart): OrbitCompletionFailure | null {
  if (orbitCompletionPhase(start) !== "failed") return null;
  const code = start.completionErrorCode ?? null;
  const message =
    code === ORBIT_CREATE_WORKSPACE_FAILED
      ? ORBIT_WORKSPACE_FAILED_TEXT
      : code === ORBIT_CONTAINER_PROCESS_INACTIVE
        ? orbitProcessFailureText(
            start.completionProcessUnit,
            orbitCompletionProcessFailureCanRetry(start),
          )
        : null;
  return {
    title: orbitCompletionCancelled(start) ? ORBIT_SETUP_CANCELLED_TITLE : ORBIT_SETUP_FAILED_TITLE,
    message,
    detailLine:
      orbitErrorDetailText(code, start.completionErrorDetail) ?? (message === null ? code : null),
    canRetry: start.completionRetryable === true,
    instanceStays: code !== ORBIT_CONTAINER_PROCESS_INACTIVE,
  };
}
