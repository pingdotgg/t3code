import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { HomeError, type HomeErrorReason } from "@t3tools/contracts";
import { msg } from "gt-react";
import * as Schema from "effect/Schema";

import type { MessageResolver } from "../../i18n/messages";

const HOME_ERROR_MESSAGES = {
  off: msg("Home is off. Turn it on first."),
  "no-model": msg("Choose a model for Home first."),
  "launch-failed": msg("Home's thread could not be started."),
  "settings-unavailable": msg("Home's settings could not be read or saved."),
} satisfies Record<HomeErrorReason, string>;

const isHomeError = Schema.is(HomeError);

export interface HomeFailure {
  readonly reason: HomeErrorReason | null;
  readonly message: string;
}

/** What a failed Home command says, or null when it succeeded or was interrupted. */
export function homeFailure(
  result: AtomCommandResult<unknown, unknown>,
  m: MessageResolver,
): HomeFailure | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  if (isHomeError(error)) {
    return { reason: error.reason, message: m(HOME_ERROR_MESSAGES[error.reason]) };
  }
  return {
    reason: null,
    message: error instanceof Error ? error.message : m(msg("An error occurred.")),
  };
}
