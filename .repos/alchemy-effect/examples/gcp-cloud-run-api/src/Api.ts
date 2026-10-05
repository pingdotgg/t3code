import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { ApiKey, Links } from "./resources.ts";

/** Base62 so codes stay short and URL-safe. */
const ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

const newCode = () =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(7)),
    (byte) => ALPHABET[byte % ALPHABET.length],
  ).join("");

/**
 * Cloud Run terminates TLS at its front end and forwards plain HTTP, so
 * the public origin comes from the forwarded headers.
 */
const publicOrigin = (request: HttpServerRequest) =>
  `${request.headers["x-forwarded-proto"] ?? "https"}://${request.headers.host}`;

/** Constant-time comparison so response timing does not leak the key. */
const sameKey = (expected: string, given: string | undefined) => {
  if (given === undefined || given.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index++) {
    diff |= expected.charCodeAt(index) ^ given.charCodeAt(index);
  }
  return diff === 0;
};

interface Link {
  url: string;
  clicks: number;
  createdAt: string;
}

/**
 * A link shortener on Cloud Run.
 *
 * This is the shape of most GCP web services: one Cloud Run container,
 * Firestore for state, Secret Manager for the credential the container
 * needs at runtime. Nothing is wired by hand — each `yield*` of a binding
 * grants the matching IAM role on the service's runtime service account
 * and injects whatever the call needs into the revision.
 *
 * - `POST /links` — mint a code for a URL (requires `x-api-key`).
 * - `GET /l/:code` — redirect and count the click.
 * - `GET /links/:code` — read the link back.
 * - `DELETE /links/:code` — retire a code (requires `x-api-key`).
 *
 * `invokerIamDisabled: true` makes the service publicly reachable, which
 * a link shortener has to be. Drop it and Cloud Run requires a signed
 * Google identity token on every request.
 */
export default class Api extends GCP.Function<Api>()(
  "Api",
  {
    main: import.meta.url,
    invokerIamDisabled: true,
  },
  Effect.gen(function* () {
    const links = yield* Links;
    const apiKey = yield* ApiKey;

    // Each binding grants the runtime service account one role:
    // datastore.user on the project, under an IAM Condition naming only
    // this database, and secretmanager.secretAccessor on the API key
    // secret only.
    const db = yield* GCP.Firestore.ReadWriteDatabase(links);
    const key = yield* GCP.SecretManager.ReadSecret(apiKey);

    const readLink = (code: string) =>
      db.get(`links/${code}`).pipe(
        Effect.map((document): Link | undefined => {
          // `get` answers `undefined` for a missing document, and fields
          // come back as plain JavaScript values.
          const { url, clicks, createdAt } = document?.fields ?? {};
          if (typeof url !== "string") return undefined;
          return {
            url,
            clicks: typeof clicks === "number" ? clicks : 0,
            createdAt: createdAt instanceof Date ? createdAt.toISOString() : "",
          };
        }),
        Effect.orDie,
      );

    /**
     * Secret Manager holds the key; the container reads the `latest`
     * version on demand. Until someone adds a version the API cannot
     * authenticate anyone, so say so instead of failing open.
     */
    const authorize = (request: HttpServerRequest) =>
      key.access().pipe(
        Effect.map((expected) => {
          if (expected === undefined) return "unconfigured" as const;
          return sameKey(expected, request.headers["x-api-key"])
            ? ("ok" as const)
            : ("denied" as const);
        }),
        Effect.orDie,
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const segments = url.pathname.split("/").filter(Boolean);

        if (request.method === "GET" && segments.length === 0) {
          return HttpServerResponse.text("ok");
        }

        // Mint a code. 62^7 keeps collisions rare, and `create` makes
        // them harmless.
        if (request.method === "POST" && url.pathname === "/links") {
          const auth = yield* authorize(request);
          if (auth !== "ok") {
            return yield* HttpServerResponse.json(
              {
                error:
                  auth === "unconfigured"
                    ? "no api key version has been added to the secret"
                    : "invalid api key",
              },
              { status: auth === "unconfigured" ? 503 : 401 },
            );
          }

          const body = (yield* request.json) as { url?: string };
          if (!body.url) {
            return yield* HttpServerResponse.json(
              { error: "url is required" },
              { status: 400 },
            );
          }

          // `create` fails with DocumentAlreadyExists instead of
          // overwriting, so a collision just mints another code.
          const code = yield* Effect.suspend(() => {
            const code = newCode();
            return db
              .create(`links/${code}`, {
                url: body.url,
                clicks: 0,
                createdAt: new Date(),
              })
              .pipe(Effect.as(code));
          }).pipe(
            Effect.retry({
              while: (error) =>
                error._tag === "GCP.Firestore.DocumentAlreadyExists",
              times: 3,
            }),
            Effect.orDie,
          );

          return yield* HttpServerResponse.json(
            { code, shortUrl: `${publicOrigin(request)}/l/${code}` },
            { status: 201 },
          );
        }

        // Follow a link. The click counter is a read-modify-write, which
        // is fine for a counter nobody bills on; a Firestore transaction
        // is the answer when the count has to be exact.
        if (request.method === "GET" && segments[0] === "l" && segments[1]) {
          const link = yield* readLink(segments[1]);
          if (link === undefined) {
            return yield* HttpServerResponse.json(
              { error: "unknown code" },
              { status: 404 },
            );
          }

          // `update` writes only the keys it is given.
          yield* db
            .update(`links/${segments[1]}`, { clicks: link.clicks + 1 })
            .pipe(Effect.orDie);

          return HttpServerResponse.empty({
            status: 302,
            headers: { location: link.url },
          });
        }

        if (
          request.method === "GET" &&
          segments[0] === "links" &&
          segments[1]
        ) {
          const link = yield* readLink(segments[1]);
          if (link === undefined) {
            return yield* HttpServerResponse.json(
              { error: "unknown code" },
              { status: 404 },
            );
          }
          return yield* HttpServerResponse.json({ code: segments[1], ...link });
        }

        if (
          request.method === "DELETE" &&
          segments[0] === "links" &&
          segments[1]
        ) {
          const auth = yield* authorize(request);
          if (auth !== "ok") {
            return yield* HttpServerResponse.json(
              { error: "invalid api key" },
              { status: 401 },
            );
          }
          // Deleting a missing document succeeds.
          yield* db.delete(`links/${segments[1]}`).pipe(Effect.orDie);
          return HttpServerResponse.empty({ status: 204 });
        }

        return yield* HttpServerResponse.json(
          { error: "not found" },
          { status: 404 },
        );
      }),
    };
  }).pipe(
    Effect.provide([
      GCP.Firestore.ReadWriteDatabaseHttp,
      GCP.SecretManager.ReadSecretHttp,
    ]),
  ),
) {}
