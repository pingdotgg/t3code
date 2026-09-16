import type { ExternalTerminalId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export function terminalAutomationApp(terminal: ExternalTerminalId, platform: string) {
  if (platform !== "darwin") return null;
  if (terminal === "system" || terminal === "terminal") return "com.apple.Terminal";
  if (terminal === "iterm2") return "com.googlecode.iterm2";
  return null;
}

export class TerminalPermissionError extends Schema.TaggedError<TerminalPermissionError>()(
  "TerminalPermissionError",
  {
    reason: Schema.Literals(["denied", "timeout", "unavailable"]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    switch (this.reason) {
      case "denied":
        return "Terminal access was denied. Allow T3 Code to control this terminal in System Settings → Privacy & Security → Automation, then select it again.";
      case "timeout":
        return "Terminal permission timed out. Respond to the macOS permission prompt, then select the terminal again.";
      case "unavailable":
        return "Could not prepare this terminal. Check that the app is installed, then select it again.";
    }
  }
}

const isTerminalPermissionError = Schema.is(TerminalPermissionError);

/** A harmless Apple event requests consent without sending a command to a shell. */
export const requestTerminalPermission = Effect.fn("desktop.requestTerminalPermission")(
  function* (terminal: ExternalTerminalId, platform: string) {
    const appId = terminalAutomationApp(terminal, platform);
    if (appId === null) return;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        "/usr/bin/osascript",
        ["-e", `tell application id "${appId}" to count windows`],
        { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
      ),
    );
    const [exitCode, stderr] = yield* Effect.all(
      [child.exitCode, child.stderr.pipe(Stream.decodeText(), Stream.mkString)],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* new TerminalPermissionError({
        reason: stderr.includes("-1743") ? "denied" : "unavailable",
        cause: stderr,
      });
    }
  },
  // Give users time to read and answer the first macOS consent dialog.
  Effect.timeout("2 minutes"),
  Effect.scoped,
  Effect.mapError((cause) =>
    isTerminalPermissionError(cause)
      ? cause
      : new TerminalPermissionError({
          reason: cause._tag === "TimeoutError" ? "timeout" : "unavailable",
          cause,
        }),
  ),
);
