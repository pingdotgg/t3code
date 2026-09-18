import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";
import * as CliKit from "../CliKit/index.ts";
import { exitDeclined } from "./errors.ts";

/**
 * A declined confirmation prompt. By the time this propagates the decline
 * message has already been printed and the exit code set, so the
 * `[Runtime.errorReported] = false` marker suppresses the runtime's default
 * failure log — the process just exits 1, matching the CLI's documented
 * "1 = failure or decline" contract.
 */
export class ConfirmationDeclined extends Data.TaggedError(
  "ConfirmationDeclined",
) {
  readonly [Runtime.errorReported] = false;
}

/**
 * Gate a destructive operation behind a confirmation prompt.
 *
 * Returns void when `yes` was passed or the user approves. Otherwise prints
 * `abortMessage` (default "Aborted."), sets the exit code to 1 via
 * {@link exitDeclined}, and fails with {@link ConfirmationDeclined} so the
 * command short-circuits before the destructive work.
 */
export const confirmOrDecline = Effect.fn(function* (options: {
  readonly yes: boolean;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly abortMessage?: string;
}) {
  if (options.yes) return;
  const approved = yield* CliKit.accessors.prompt.confirm({
    message: options.message,
    initialValue: false,
    confirmLabel: options.confirmLabel,
    cancelLabel: options.cancelLabel,
  });
  if (approved) return;
  yield* CliKit.accessors.output.info(options.abortMessage ?? "Aborted.");
  yield* exitDeclined;
  return yield* Effect.fail(new ConfirmationDeclined());
});
