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
    catch: () => new DesktopCliUpdateError({ reason: check.reason! }),
  }).pipe(Effect.option);
  if (response._tag === "None") {
    if (input.check) return check;
    return yield* new DesktopCliUpdateError({ reason: check.reason! });
  }
  const result = response.value;
  if (!result.ok) {
    if (input.check) return { ...check, reason: result.message };
    return yield* new DesktopCliUpdateError({ reason: result.message });
  }
  if ("check" in result) return result.check;
  if ("status" in result) return result.status;
  return yield* new DesktopCliUpdateError({
    reason: "This desktop app cannot coordinate t3 update. Update the desktop app first.",
  });
});
