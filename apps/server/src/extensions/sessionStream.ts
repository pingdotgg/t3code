import { AuthOrchestrationReadScope, ExtensionOperationError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import type { SessionStore } from "../auth/SessionStore.ts";

const denied = () =>
  new ExtensionOperationError({
    operation: "api.subscribe",
    detail: "The authenticated extension session is no longer authorized.",
  });

/** Bind extension streams to the verified session, including while a producer is silent. */
export function guardExtensionSessionStream<A, E, R>(
  stream: Stream.Stream<A, E, R>,
  session: AuthenticatedSession,
  sessions: Pick<SessionStore["Service"], "revalidate" | "watchChanges">,
) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const watched = yield* sessions.watchChanges();
      const changes = yield* Stream.toPull(watched);
      const check = Effect.fn("Extensions.revalidateStreamSession")(function* () {
        const current = yield* sessions
          .revalidate(session.sessionId)
          .pipe(Effect.mapError(() => denied()));
        const now = yield* DateTime.now;
        if (
          current.subject !== session.subject ||
          current.method !== session.method ||
          !session.scopes.includes(AuthOrchestrationReadScope) ||
          !current.scopes.includes(AuthOrchestrationReadScope) ||
          (session.expiresAt !== undefined &&
            DateTime.toEpochMillis(session.expiresAt) <= DateTime.toEpochMillis(now))
        )
          return yield* denied();
        return current;
      });
      const current = yield* check();
      const expiresAt = Math.min(
        DateTime.toEpochMillis(current.expiresAt),
        session.expiresAt === undefined ? Infinity : DateTime.toEpochMillis(session.expiresAt),
      );
      const now = yield* DateTime.now;
      const revoked = Effect.gen(function* () {
        while (true) {
          const batch = yield* changes.pipe(Effect.mapError(() => denied()));
          if (
            batch.some(
              (change) => change.type === "clientRemoved" && change.sessionId === session.sessionId,
            )
          ) {
            return yield* denied();
          }
        }
      });
      const expired = Effect.sleep(Math.max(0, expiresAt - DateTime.toEpochMillis(now))).pipe(
        Effect.andThen(Effect.fail(denied())),
      );
      return stream.pipe(
        Stream.mapEffect((frame) => check().pipe(Effect.as(frame))),
        Stream.interruptWhen(Effect.raceFirst(revoked, expired)),
      );
    }),
  );
}
