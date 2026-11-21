import * as HostProcess from "@lathe/shared/HostProcess";
import { resolveNodeExecutable } from "@lathe/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { collectUint8StreamText } from "@lathe/provider-core/server/collectStreamText";
import { AuthRelayError } from "./AuthRelayError.ts";

/**
 * `BROWSER` hijack for tools that open a sign-in page from the environment, where the user never
 * is. The helper writes the URL to stderr behind a marker and exits successfully, so the tool
 * keeps waiting for its callback; the spawning process relays the marked URL to the flow's client.
 */

export const BROWSER_LAUNCH_URL_MAX_LENGTH = 16_384;
const PREFLIGHT_TIMEOUT = "30 seconds";
const PREFLIGHT_URL = "https://example.invalid/lathe-browser-launch-preflight";
const MAX_MARKER_LINE_LENGTH = 128 + BROWSER_LAUNCH_URL_MAX_LENGTH + 2;
const decodeHelperUrl = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.String));

export interface BrowserLaunchCommand {
  readonly marker: string;
  /** Helper executable, as the spawner and the tool's shell see it. */
  readonly executable: string;
  /** Helper arguments up to the URL. Python substitutes `%s`; other tools append the URL. */
  readonly args: ReadonlyArray<string>;
  /** The `BROWSER` value: the executable and arguments, shell-quoted. */
  readonly command: string;
}

/**
 * Python splits `BROWSER` on the path separator before parsing quotes, so the source avoids colons
 * and semicolons. EPIPE must still exit 0 or Python falls back to an OS browser after cancelling.
 * Python substitutes `%s` while Go and shell tools append the URL, so the helper reports the last
 * argument that is not the literal placeholder.
 */
export function browserLaunchHelperSource(marker: string): string {
  return (
    `process.stderr.on("error",()=>process.exit(0)).write(` +
    `"${marker}"+JSON.stringify(process.argv.filter((a)=>a!=="%s").pop()||"")+"\\n",` +
    `()=>process.exit(0))`
  );
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Builds the `BROWSER` value that runs the inline helper through the Lathe
 * runtime (Node, or Electron with `ELECTRON_RUN_AS_NODE`). Fails when the
 * runtime path cannot survive Python's `BROWSER` splitting.
 */
export const buildBrowserLaunchCommand = Effect.fn("buildBrowserLaunchCommand")(function* (input: {
  readonly marker: string;
  readonly runtimeExecutablePath?: string;
  readonly platform?: NodeJS.Platform;
}): Effect.fn.Return<BrowserLaunchCommand, AuthRelayError, FileSystem.FileSystem | Path.Path> {
  const platform = input.platform ?? (yield* HostProcess.Platform);
  // A packaged Lathe executable cannot run `-e` helpers; resolve a real Node binary.
  const runtimeExecutablePath =
    input.runtimeExecutablePath ??
    (yield* resolveNodeExecutable("Provider sign-in").pipe(
      Effect.mapError(
        (error) =>
          new AuthRelayError({ operation: "browser", detail: error.message, cause: error }),
      ),
    ));
  const executable =
    platform === "win32" ? runtimeExecutablePath.replaceAll("\\", "/") : runtimeExecutablePath;
  if (/[:;\s"'\\]/.test(input.marker)) {
    return yield* new AuthRelayError({
      operation: "browser",
      detail: "The browser launch marker cannot be used in a BROWSER command.",
    });
  }
  const args = ["-e", browserLaunchHelperSource(input.marker), "--", "%s"];
  const command = [executable, ...args].map(quoteShellArgument).join(" ");
  if (
    command.includes(platform === "win32" ? ";" : ":") ||
    executable.includes("\r") ||
    executable.includes("\n") ||
    executable.includes("\0") ||
    executable.includes("%s")
  ) {
    return yield* new AuthRelayError({
      operation: "browser",
      detail: "The Lathe runtime path cannot be used to suppress browser launches.",
    });
  }
  return { marker: input.marker, executable, args, command };
});

/**
 * Runs the helper once with a fake URL and checks that it reports exactly
 * that URL and nothing else. A runtime that cannot run the helper would let
 * the tool fall back to an OS browser, so the flow refuses to start.
 */
export const preflightBrowserLaunchCommand = Effect.fn("preflightBrowserLaunchCommand")(function* (
  command: BrowserLaunchCommand,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<void, AuthRelayError, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const unverified = (detail: string) => new AuthRelayError({ operation: "browser", detail });
  const args = command.args.map((argument) => (argument === "%s" ? PREFLIGHT_URL : argument));
  yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make(command.executable, args, { env, extendEnv: false, shell: false }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: 4_096 }),
        collectUint8StreamText({ stream: child.stderr, maxBytes: 4_096 }),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (
      Number(exitCode) !== 0 ||
      stdout.bytes !== 0 ||
      stdout.truncated ||
      stderr.truncated ||
      stderr.text !== `${command.marker}"${PREFLIGHT_URL}"\n`
    ) {
      return yield* unverified("The browser launch helper could not be verified.");
    }
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: PREFLIGHT_TIMEOUT,
      orElse: () => Effect.fail(unverified("The browser launch helper verification timed out.")),
    }),
    Effect.mapError((error) =>
      error._tag === "AuthRelayError"
        ? error
        : unverified("The browser launch helper could not be verified."),
    ),
  );
});

/**
 * Hands every helper-reported URL in a tool's stderr to `onUrl`, buffering marker lines split
 * across chunks. Other lines and undecodable markers are dropped silently, since stderr can carry
 * anything; `onUrl` failures propagate so the flow owner can stop the process. `readLine` lets a
 * caller recognize an extra native line format, returning its URL or `undefined`.
 */
export function makeBrowserLaunchStderrHandler<E>(input: {
  readonly marker: string;
  readonly onUrl: (url: string) => Effect.Effect<void, E>;
  readonly readLine?: (line: string) => string | undefined;
}): (text: string) => Effect.Effect<void, E> {
  let pending = "";
  const handleLine = (line: string): Effect.Effect<void, E> => {
    const message = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (message.length > MAX_MARKER_LINE_LENGTH) return Effect.void;
    const native = input.readLine?.(message);
    const url: Effect.Effect<string, Schema.SchemaError> | undefined =
      native !== undefined
        ? Effect.succeed(native)
        : message.startsWith(input.marker)
          ? decodeHelperUrl(message.slice(input.marker.length))
          : undefined;
    if (url === undefined) return Effect.void;
    return url.pipe(
      Effect.matchEffect({
        onFailure: () => Effect.void,
        onSuccess: (value) =>
          value.length > BROWSER_LAUNCH_URL_MAX_LENGTH ? Effect.void : input.onUrl(value),
      }),
    );
  };
  return Effect.fn("browserLaunchCapture.handleStderr")(function* (text: string) {
    const lines = `${pending}${text}`.split("\n");
    pending = lines.pop() ?? "";
    if (pending.length > MAX_MARKER_LINE_LENGTH) pending = "";
    yield* Effect.forEach(lines, handleLine, { discard: true });
  });
}
