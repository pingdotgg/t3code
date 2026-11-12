import { Actor, customer } from "@bank/domain/Actor";
import { CurrentActor } from "@bank/domain/CurrentActor.context";
import { CustomerId } from "@bank/domain/Customer/Customer.id";
import { SESSION_COOKIE, Session, Unauthorized } from "@bank/domain/Session.middleware";
import * as Alchemy from "alchemy";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Cookies from "effect/http/Cookies";
import * as Headers from "effect/http/Headers";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** How long a session lasts. */
const SESSION_DAYS = 7;

/** The key that signs sessions: the same for every request to this stage. */
export class SessionKey extends Context.Service<
  SessionKey,
  Effect.Effect<Redacted.Redacted<string>>
>()("Bank/SessionKey") {}

/** A random key, made once when the stage is first deployed and kept in its state. */
export const SessionKeyLive = Layer.effect(
  SessionKey,
  Effect.gen(function* () {
    const key = yield* Alchemy.Random("SessionKey");
    return yield* key.text;
  }),
);

const hmacKey = Effect.fn(function* () {
  const secret = Redacted.value(yield* yield* SessionKey);
  return yield* Effect.promise(() =>
    crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    ),
  );
});

/** What a session token says: who, and until when. */
const Claims = Schema.fromJsonString(Schema.Struct({ actor: Actor, expires: Schema.Number }));

/** A session token for `actor`: its claims and their HMAC, so no one without the key can make one. */
export const signSession = Effect.fn(function* (actor: Actor) {
  const expires = (yield* Clock.currentTimeMillis) + SESSION_DAYS * 24 * 60 * 60 * 1000;
  // Encoding our own claims can't fail.
  const json = yield* Schema.encodeEffect(Claims)({ actor, expires }).pipe(Effect.orDie);
  const claims = Base64Url.encode(json);
  const key = yield* hmacKey();
  const mac = yield* Effect.promise(() =>
    crypto.subtle.sign("HMAC", key, new TextEncoder().encode(claims)),
  );
  return `${claims}.${Base64Url.encode(new Uint8Array(mac))}`;
});

/** The actor a token was signed for, if its signature checks out and it hasn't expired. */
const verifySession = Effect.fn(function* (token: string) {
  const [claims, mac, ...rest] = token.split(".");
  if (!claims || !mac || rest.length > 0) return Option.none<Actor>();
  const signature = Base64Url.decode(mac);
  if (Result.isFailure(signature)) return Option.none<Actor>();
  const key = yield* hmacKey();
  // `verify` compares in constant time.
  const valid = yield* Effect.promise(() =>
    crypto.subtle.verify(
      "HMAC",
      key,
      new Uint8Array(signature.success),
      new TextEncoder().encode(claims),
    ),
  );
  const json = Base64Url.decodeString(claims);
  if (!valid || Result.isFailure(json)) return Option.none<Actor>();
  const decoded = yield* Schema.decodeEffect(Claims)(json.success).pipe(Effect.option);
  const now = yield* Clock.currentTimeMillis;
  return Option.flatMap(decoded, (c) => (c.expires > now ? Option.some(c.actor) : Option.none()));
});

/** The token a request carries: its session cookie (browsers), or `Authorization: Bearer` (scripts). */
const tokenOf = (headers: Headers.Headers): Option.Option<string> =>
  Option.orElse(
    Option.flatMap(Headers.get(headers, "cookie"), (cookie) =>
      Option.fromNullishOr(Cookies.parseHeader(cookie)[SESSION_COOKIE]),
    ),
    () =>
      Option.flatMap(Headers.get(headers, "authorization"), (value) =>
        value.startsWith("Bearer ") ? Option.some(value.slice("Bearer ".length)) : Option.none(),
      ),
  );

/** Who a request is from, if it carries a valid session. */
export const actorOf = Effect.fn(function* (headers: Headers.Headers) {
  const token = tokenOf(headers);
  return Option.isNone(token) ? Option.none<Actor>() : yield* verifySession(token.value);
});

/** The {@link Session} middleware: provides the request's actor, or fails with Unauthorized. */
export const SessionLive = Layer.effect(
  Session,
  Effect.gen(function* () {
    const key = yield* SessionKey;
    return (effect, { headers }) =>
      actorOf(headers).pipe(
        Effect.provideService(SessionKey, key),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new Unauthorized()),
            onSome: (actor) => Effect.provideService(effect, CurrentActor, actor),
          }),
        ),
      );
  }),
);

const SignIn = Schema.Struct({ customerId: CustomerId });

/**
 * `POST /api/session` signs a customer in: it sets the signed session cookie,
 * and returns the same token for scripts to send as `Authorization: Bearer`.
 * `DELETE` signs them out. `HttpOnly` keeps the cookie from scripts, and
 * `SameSite=Strict` keeps it off cross-site requests, WebSocket upgrades
 * included. Demo only: anyone may sign in as any customer. Check a password,
 * a magic link or a provider here before signing.
 */
export const sessionRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest;
  const options = { httpOnly: true, secure: true, sameSite: "strict", path: "/" } as const;
  if (request.method === "DELETE") {
    return HttpServerResponse.empty({ status: 204 }).pipe(
      HttpServerResponse.setCookieUnsafe(SESSION_COOKIE, "", { ...options, maxAge: 0 }),
    );
  }
  if (request.method !== "POST") return HttpServerResponse.empty({ status: 405 });
  const body = yield* request.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SignIn)),
    Effect.option,
  );
  if (Option.isNone(body))
    return HttpServerResponse.text("Expected { customerId }", { status: 400 });
  const token = yield* signSession(customer(body.value.customerId));
  return yield* HttpServerResponse.json({ token }).pipe(
    Effect.map(
      HttpServerResponse.setCookieUnsafe(SESSION_COOKIE, token, {
        ...options,
        maxAge: `${SESSION_DAYS} days`,
      }),
    ),
  );
});
