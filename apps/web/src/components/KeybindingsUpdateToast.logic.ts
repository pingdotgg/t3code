import type { ServerConfig, ServerConfigStreamEvent } from "@t3tools/contracts";

export const KEYBINDINGS_SUCCESS_TOAST_COOLDOWN_MS = 2_000;

export type KeybindingsUpdateToastDecision =
  | { readonly _tag: "Success" }
  | { readonly _tag: "InvalidConfiguration"; readonly message: string };

export interface KeybindingsUpdateToastController {
  readonly handle: (event: ServerConfigStreamEvent | null) => KeybindingsUpdateToastDecision | null;
  /** Seed once from boot/unchanged configs that arrive without a snapshot event. */
  readonly seed: (issues: ServerConfig["issues"]) => void;
}

// Malformed files can change issues without changing keybindings.
function keybindingsUpdateFromEvent(event: ServerConfigStreamEvent | null) {
  if (event?.type === "keybindingsUpdated") {
    return { keybindingsChanged: true, issues: event.payload.issues };
  }
  if (event?.type !== "configDelta") return null;
  const { keybindings, issues } = event.changes;
  if (keybindings === undefined && issues === undefined) return null;
  return { keybindingsChanged: keybindings !== undefined, issues: issues ?? null };
}

function keybindingsIssue(issues: ServerConfig["issues"]) {
  return issues.find((entry) => entry.kind.startsWith("keybindings."));
}

export function createKeybindingsUpdateToastController(input: {
  readonly now?: () => number;
}): KeybindingsUpdateToastController {
  const now = input.now ?? Date.now;
  let lastSuccessToastAt: number | null = null;
  // A delta that only changes other issues must not repeat a standing warning.
  let reportedIssueMessage: string | null = null;
  let seeded = false;

  return {
    seed: (issues) => {
      if (seeded) return;
      seeded = true;
      reportedIssueMessage = keybindingsIssue(issues)?.message ?? null;
    },
    handle: (event) => {
      // Seed standing issues so clearing one later counts as a fix.
      if (event?.type === "snapshot") {
        seeded = true;
        reportedIssueMessage = keybindingsIssue(event.config.issues)?.message ?? null;
        return null;
      }
      const update = keybindingsUpdateFromEvent(event);
      if (update === null) {
        return null;
      }

      let fixed = false;
      if (update.issues !== null) {
        const issue = keybindingsIssue(update.issues);
        const repeated = !update.keybindingsChanged && issue?.message === reportedIssueMessage;
        fixed = !issue && reportedIssueMessage !== null;
        reportedIssueMessage = issue?.message ?? null;
        if (issue && !repeated) {
          return {
            _tag: "InvalidConfiguration",
            message: issue.message,
          };
        }
        if (issue) {
          return null;
        }
      }
      if (!update.keybindingsChanged && !fixed) {
        return null;
      }

      const currentTime = now();
      if (
        lastSuccessToastAt !== null &&
        currentTime - lastSuccessToastAt < KEYBINDINGS_SUCCESS_TOAST_COOLDOWN_MS
      ) {
        return null;
      }

      lastSuccessToastAt = currentTime;
      return { _tag: "Success" };
    },
  };
}
