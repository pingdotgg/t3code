// @effect-diagnostics nodeBuiltinImport:off -- This CLI adapter addresses the desktop app's private local control socket.
import * as NodeOS from "node:os";
import type { T3UpdateCheck } from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { sendDesktopAppControlRequest } from "./app.ts";

export class DesktopCliUpdateError extends Schema.TaggedError<DesktopCliUpdateError>()(
  "DesktopCliUpdateError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}
const safeTransportMessages = new Set([
  "The desktop app socket directory is not private or owned by this user.",
  "The desktop app response is too large.",
  "The desktop app response is not valid JSON.",
  "The desktop app response is invalid.",
  "The desktop app response did not match this request.",
]);

function transportFailure(error: unknown): { state: "unavailable" | "error"; reason: string } {
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
      return {
        state: "unavailable",
        reason:
          "Open or update T3 Code, then run t3 update again. No standalone update was attempted.",
      };
    }
    return {
      state: "error",
      reason:
        "Could not communicate with T3 Code. Check the desktop app and try again. No standalone update was attempted.",
    };
  }
  const message = error instanceof Error ? error.message : "";
  if (
    message === "The desktop app did not respond in time." ||
    message === "The desktop app closed the connection."
  ) {
    return {
      state: "error",
      reason:
        "The desktop app did not confirm the request. Check T3 Code for its status. No standalone update was attempted.",
    };
  }
  const reason = safeTransportMessages.has(message)
    ? `${message} Check T3 Code and try again.`
    : "Could not communicate with T3 Code. Check the desktop app and try again.";
  return { state: "error", reason: `${reason} No standalone update was attempted.` };
}

export const requestDesktopUpdate = Effect.fn("cli.update.desktop")(function* (input: {
  readonly baseDir: string;
  readonly currentVersion: string;
  readonly check: boolean;
}) {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const userId = yield* HostProcess.UserId;
  const check: T3UpdateCheck = {
    schema: "t3.update-check.v1",
    owner: "desktop",
    pathway: "desktop-coordinated",
    coordinated: false,
    currentVersion: input.currentVersion,
    targetVersion: null,
    state: "unavailable",
    reason: "Open or update T3 Code, then run t3 update again. No standalone update was attempted.",
  };
  const response = yield* Effect.tryPromise({
    try: () =>
      sendDesktopAppControlRequest({
        address: resolveDesktopAppControlAddress({
          stateDir: path.join(input.baseDir, "userdata"),
          platform,
          userId,
          tempDir: NodeOS.tmpdir(),
          joinPath: path.join,
        }),
        userId,
        request: {
          version: 1,
          requestId: input.check ? "update-check" : SecureRandom.uuidV4Unsafe(),
          type: input.check ? "update-check" : "update",
        },
        timeoutMs: input.check ? 5_000 : 5 * 60_000,
      }),
    catch: transportFailure,
  }).pipe(
    Effect.match({ onFailure: (failure) => ({ failure }), onSuccess: (result) => ({ result }) }),
  );
  if ("failure" in response) {
    if (input.check) return { ...check, ...response.failure };
    return yield* new DesktopCliUpdateError({ reason: response.failure.reason });
  }
  const result = response.result;
  if (!result.ok) {
    const reason =
      result.code === "invalid-request"
        ? "This desktop app cannot coordinate t3 update. Update the desktop app first. No standalone update was attempted."
        : result.message;
    if (input.check) return { ...check, reason };
    return yield* new DesktopCliUpdateError({ reason });
  }
  if ("check" in result) return result.check;
  if ("status" in result) return result.status;
  return yield* new DesktopCliUpdateError({
    reason: "This desktop app cannot coordinate t3 update. Update the desktop app first.",
  });
});
