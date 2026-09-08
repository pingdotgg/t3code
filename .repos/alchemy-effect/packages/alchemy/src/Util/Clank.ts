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
 * Uses `Effect.callback` so fiber interruption propagates to the clack
 * prompt through its abort signal, releasing stdin and restoring the cursor.
 */
export const prompt = <T>(
  fn: (signal: AbortSignal) => Promise<T | symbol>,
): Effect.Effect<T, PromptCancelled> =>
  Effect.callback<T, PromptCancelled>((resume, signal) => {
    let settled = false;
    fn(signal).then(
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
type TextOptions = Omit<p.TextOptions, "validate"> & {
  validate?: (value: string) => string | Error | undefined;
};

type PasswordOptions = Omit<p.PasswordOptions, "validate"> & {
  validate?: (value: string) => string | Error | undefined;
};

export const text = (opts: TextOptions) => {
  const validate = opts.validate;
  return prompt<string>((signal) =>
    p.text({
      ...opts,
      signal,
      validate:
        validate === undefined ? undefined : (value) => validate(value ?? ""),
    }),
  );
};
export const password = (opts: PasswordOptions) => {
  const validate = opts.validate;
  return prompt<string>((signal) =>
    p.password({
      ...opts,
      signal,
      validate:
        validate === undefined ? undefined : (value) => validate(value ?? ""),
    }),
  );
};
export const select = <Value>(opts: p.SelectOptions<Value>) =>
  prompt((signal) => p.select<Value>({ ...opts, signal }));
export const confirm = (opts: p.ConfirmOptions) =>
  prompt((signal) => p.confirm({ ...opts, signal }));
export const multiselect = <Value>(opts: p.MultiSelectOptions<Value>) =>
  prompt((signal) => p.multiselect<Value>({ ...opts, signal }));

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
