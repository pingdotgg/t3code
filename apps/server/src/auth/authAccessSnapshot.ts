import type { AuthAccessSnapshot, AuthSessionId } from "@t3tools/contracts";
import { Effect } from "effect";

import type { ServerAuthShape } from "./Services/ServerAuth.ts";

type AuthAccessReader = Pick<ServerAuthShape, "listPairingLinks" | "listClientSessions">;

export const loadAuthAccessSnapshot = (
  serverAuth: AuthAccessReader,
  currentSessionId: AuthSessionId,
): Effect.Effect<AuthAccessSnapshot, never> =>
  Effect.all(
    {
      pairingLinks: serverAuth.listPairingLinks().pipe(Effect.orDie),
      clientSessions: serverAuth.listClientSessions(currentSessionId).pipe(Effect.orDie),
    },
    { concurrency: "unbounded" },
  );
