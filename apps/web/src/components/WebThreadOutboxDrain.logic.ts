import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

export function shouldPauseWebThreadOutboxDelivery(
  result: AtomCommandResult<unknown, unknown>,
): boolean {
  return result._tag === "Failure" && !isAtomCommandInterrupted(result);
}
