import { AuthTerminalOperateScope, type TcpPortForwardHost } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as SessionStore from "../auth/SessionStore.ts";

const TICKET_TTL = Duration.seconds(30);

interface TicketRecord {
  readonly webSocketToken: string;
  readonly remoteHost: TcpPortForwardHost;
  readonly remotePort: number;
  readonly expiresAtEpochMs: number;
}

export class TcpForwardTicketIssueError extends Schema.TaggedErrorClass<TcpForwardTicketIssueError>()(
  "TcpForwardTicketIssueError",
  { cause: Schema.Defect() },
) {}

export class TcpForwardTicketInvalidError extends Schema.TaggedErrorClass<TcpForwardTicketInvalidError>()(
  "TcpForwardTicketInvalidError",
  {},
) {}

export class TcpForwardTicketStore extends Context.Service<
  TcpForwardTicketStore,
  {
    readonly issue: (input: {
      readonly sessionId: SessionStore.VerifiedSession["sessionId"];
      readonly remoteHost: TcpPortForwardHost;
      readonly remotePort: number;
    }) => Effect.Effect<
      { readonly ticket: string; readonly expiresAt: DateTime.Utc },
      TcpForwardTicketIssueError
    >;
    readonly consume: (ticket: string) => Effect.Effect<
      {
        readonly session: SessionStore.VerifiedSession;
        readonly remoteHost: TcpPortForwardHost;
        readonly remotePort: number;
      },
      TcpForwardTicketInvalidError
    >;
  }
>()("t3/portForward/TcpForwardTicketStore") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const sessions = yield* SessionStore.SessionStore;
  const records = yield* Ref.make(new Map<string, TicketRecord>());

  const issue: TcpForwardTicketStore["Service"]["issue"] = Effect.fn("TcpForwardTicketStore.issue")(
    function* (input) {
      const ticket = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => new TcpForwardTicketIssueError({ cause })),
      );
      const issued = yield* sessions
        .issueWebSocketToken(input.sessionId, { ttl: TICKET_TTL })
        .pipe(Effect.mapError((cause) => new TcpForwardTicketIssueError({ cause })));
      yield* Ref.update(records, (current) => {
        const next = new Map(
          [...current].filter(
            ([, record]) =>
              record.expiresAtEpochMs >
              issued.expiresAt.epochMilliseconds - Duration.toMillis(TICKET_TTL),
          ),
        );
        next.set(ticket, {
          webSocketToken: issued.token,
          remoteHost: input.remoteHost,
          remotePort: input.remotePort,
          expiresAtEpochMs: issued.expiresAt.epochMilliseconds,
        });
        return next;
      });
      return { ticket, expiresAt: DateTime.toUtc(issued.expiresAt) };
    },
  );

  const consume: TcpForwardTicketStore["Service"]["consume"] = Effect.fn(
    "TcpForwardTicketStore.consume",
  )(function* (ticket) {
    const record = yield* Ref.modify(records, (current) => {
      const next = new Map(current);
      const found = next.get(ticket);
      next.delete(ticket);
      return [Option.fromUndefinedOr(found), next] as const;
    });
    if (Option.isNone(record)) {
      return yield* new TcpForwardTicketInvalidError({});
    }
    const now = yield* DateTime.now;
    if (record.value.expiresAtEpochMs <= now.epochMilliseconds) {
      return yield* new TcpForwardTicketInvalidError({});
    }
    const session = yield* sessions
      .verifyWebSocketToken(record.value.webSocketToken)
      .pipe(Effect.mapError(() => new TcpForwardTicketInvalidError({})));
    if (!session.scopes.includes(AuthTerminalOperateScope)) {
      return yield* new TcpForwardTicketInvalidError({});
    }
    return {
      session,
      remoteHost: record.value.remoteHost,
      remotePort: record.value.remotePort,
    };
  });

  return TcpForwardTicketStore.of({ issue, consume });
});

export const layer = Layer.effect(TcpForwardTicketStore, make);
