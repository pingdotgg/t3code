import * as p from "@clack/prompts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { ChildProcess } from "effect/unstable/process";

export class PromptCancelled extends Data.TaggedError("PromptCancelled") {}
export const retryIfCancelled = Effect.retry({
  while: (e: unknown) => e instanceof PromptCancelled,
});

/**
 * Wraps a clack prompt (which returns a `Promise<T | symbol>` where the
 * symbol indicates user cancellation) in an Effect.
 *
 * Returns `undefined` if the user cancels (Ctrl+C / Escape).
 *
 * Uses `Effect.callback` so fiber interruption propagates via the abort
 * signal to any async resources we own; the clack prompt itself is left
 * to resolve — its result is ignored after interruption.
 */
export const prompt = <T>(
  fn: () => Promise<T | symbol>,
): Effect.Effect<T, PromptCancelled> =>
  Effect.callback<T, PromptCancelled>((resume, signal) => {
    let settled = false;
    fn().then(
      (result) => {
        if (settled || signal.aborted) return;
        settled = true;
        if (p.isCancel(result)) {
          resume(Effect.fail(new PromptCancelled()));
        } else {
          resume(Effect.succeed(result as T));
        }
      },
      (err) => {
        if (settled || signal.aborted) return;
        settled = true;
        resume(Effect.die(err));
      },
    );
  });

export const success = (str: string) => Effect.sync(() => p.log.success(str));
export const warn = (str: string) => Effect.sync(() => p.log.warn(str));
export const error = (str: string) => Effect.sync(() => p.log.error(str));
export const info = (str: string) => Effect.sync(() => p.log.info(str));
export const text = (opts: p.TextOptions) => prompt(() => p.text(opts));
export const password = (opts: p.PasswordOptions) =>
  prompt(() => p.password(opts));
export const select = <Value>(opts: p.SelectOptions<Value>) =>
  prompt(() => p.select<Value>(opts));
export const confirm = (opts: p.ConfirmOptions) =>
  prompt(() => p.confirm(opts));
export const multiselect = <Value>(opts: p.MultiSelectOptions<Value>) =>
  prompt(() => p.multiselect<Value>(opts));

/**
 * Open a URL in the user's default browser.
 *
 * On Windows, uses rundll32's FileProtocolHandler — a built-in shim that
 * opens URLs in the default browser. It accepts the URL as a direct
 * argument (no shell, no quoting of `&`). cmd.exe `start` would treat
 * `&` in OAuth URLs as a command separator, and `explorer.exe` treats
 * its arg as a path.
 */
export const openUrl = (url: string) =>
  Effect.gen(function* () {
    const [cmd, args] =
      process.platform === "win32"
        ? (["rundll32.exe", ["url.dll,FileProtocolHandler", url]] as const)
        : process.platform === "darwin"
          ? (["open", [url]] as const)
          : (["xdg-open", [url]] as const);
    const handle = yield* ChildProcess.make(cmd, [...args], { shell: false });
    yield* handle.exitCode;
  }).pipe(Effect.scoped);
