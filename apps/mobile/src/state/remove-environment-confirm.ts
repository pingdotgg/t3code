import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";

export const REMOVE_ENVIRONMENT_CONFIRM_TITLE = "Remove from this device?";
export const REMOVE_ENVIRONMENT_FAILURE_TITLE = "Could not remove environment";

export type RemoveEnvironmentConfirmRequest = {
  readonly title: string;
  readonly message: string;
  readonly confirmText: string;
  readonly destructive?: boolean;
  readonly onConfirm: () => void;
};

/** Prefer a trimmed display name, otherwise the environment id. */
function resolveRemoveEnvironmentLabel(
  environmentLabel: string | undefined,
  environmentId: EnvironmentId,
): string {
  const trimmed = environmentLabel?.trim();
  return trimmed === undefined || trimmed.length === 0 ? environmentId : trimmed;
}

/** Body copy for the remove-from-this-device confirm. */
function removeEnvironmentConfirmMessage(label: string): string {
  return `Forget ${label} and its cached threads on this device. Switch it off instead to keep it saved.`;
}

/** Persist-failure copy; use the Error message when one exists. */
function removeEnvironmentFailureMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : "The environment could not be removed from this device.";
}

/**
 * Trash on Settings → Environments lives in a nested iOS form sheet, where
 * `Alert.alert` never becomes visible. Always present an in-tree confirm,
 * even when the row is missing from the connected list, then surface a
 * persist failure instead of leaving a Keychain-backed row that looks gone.
 */
export function presentRemoveSavedEnvironment(input: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel?: string;
  readonly remove: (environmentId: EnvironmentId) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly presentConfirm: (request: RemoveEnvironmentConfirmRequest) => void;
  readonly presentError: (title: string, message: string) => void;
}): void {
  const label = resolveRemoveEnvironmentLabel(input.environmentLabel, input.environmentId);
  input.presentConfirm({
    title: REMOVE_ENVIRONMENT_CONFIRM_TITLE,
    message: removeEnvironmentConfirmMessage(label),
    confirmText: "Remove",
    destructive: true,
    /** After confirm, persist catalog removal and surface a Keychain write failure. */
    onConfirm: () => {
      void removeSavedEnvironment(input.remove, input.environmentId, input.presentError);
    },
  });
}

/** Drop the catalog row, then show an error if the Keychain write fails. */
async function removeSavedEnvironment(
  remove: (environmentId: EnvironmentId) => Promise<AtomCommandResult<unknown, unknown>>,
  environmentId: EnvironmentId,
  presentError: (title: string, message: string) => void,
): Promise<void> {
  const result = await remove(environmentId);
  if (AsyncResult.isSuccess(result) || isAtomCommandInterrupted(result)) {
    return;
  }
  presentError(
    REMOVE_ENVIRONMENT_FAILURE_TITLE,
    removeEnvironmentFailureMessage(squashAtomCommandFailure(result)),
  );
}
