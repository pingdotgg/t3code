import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

/** The message of the error a failed engine command ended with. */
export function failureText(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : String(failure);
}
