import { msg } from "gt-react-native";
import { m } from "../../i18n/messages";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { Alert } from "react-native";

/** A refusal says what the user can do about it, so it is shown rather than only logged. */
export function alertGroupCommandFailure(
  title: string,
  result: AtomCommandResult<unknown, unknown>,
) {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
  const failure = squashAtomCommandFailure(result);
  Alert.alert(title, failure instanceof Error ? failure.message : m(msg("An error occurred.")));
}
