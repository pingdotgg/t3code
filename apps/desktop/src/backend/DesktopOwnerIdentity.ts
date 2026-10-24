import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";

export class DesktopOwnerIdentity extends Context.Service<
  DesktopOwnerIdentity,
  {
    /**
     * This desktop installation's stable identity for the T3 home. The
     * desktop hands it to the server it starts, and the server persists it in
     * its runtime record, so a later launch can tell its own leftover apart
     * from a server the user started by hand.
     *
     * It is not a credential: it only says which desktop installation
     * started a server.
     */
    readonly ownerId: Effect.Effect<string, PlatformError.PlatformError>;
  }
>()("@t3tools/desktop/backend/DesktopOwnerIdentity") {}

const { logWarning: logOwnerIdentityWarning } =
  DesktopObservability.makeComponentLogger("desktop-owner-identity");

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;

  const ownerIdentityPath = environment.path.join(environment.stateDir, "desktop-owner-id");

  // The identity is read once per launch: the ownership check and the
  // bootstrap configuration have to agree on it, and a second read could
  // see a different value than the first one did.
  const ownerId = yield* Effect.cached(
    Effect.gen(function* () {
      const existing = yield* fileSystem.readFileString(ownerIdentityPath).pipe(
        Effect.matchEffect({
          // Only a missing file means "no identity yet". Any other read
          // failure must not regenerate the identity: overwriting it would
          // make the desktop unable to recognize its own leftover, and the
          // server it left behind would look like somebody else's.
          onFailure: (cause) =>
            cause.reason._tag === "NotFound"
              ? Effect.succeed(Option.none<string>())
              : Effect.fail(cause),
          onSuccess: (contents) => Effect.succeed(Option.some(contents)),
        }),
      );
      if (Option.isSome(existing)) {
        const stored = existing.value.trim();
        // An empty id names no owner: the bootstrap contract rejects it, and
        // a record written with it would be accepted by a later launch.
        if (stored.length > 0) {
          return stored;
        }
      }
      // A failed generation is not papered over with an empty id: the
      // desktop that cannot name itself must not claim a server as its own.
      const generated = yield* crypto.randomUUIDv4();
      // The id has to be on disk before it is handed to a server. A server
      // that persists an id the desktop could not save would leave a
      // leftover the desktop can never recognize.
      yield* fileSystem.writeFileString(ownerIdentityPath, `${generated}\n`).pipe(
        Effect.tapError((cause) =>
          logOwnerIdentityWarning("could not persist the desktop owner identity", {
            path: ownerIdentityPath,
            cause,
          }),
        ),
      );
      return generated;
    }),
  );

  return DesktopOwnerIdentity.of({ ownerId });
});

export const layer = Layer.effect(DesktopOwnerIdentity, make);
