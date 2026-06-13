import * as Cloudflare from "alchemy/Cloudflare";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { Layer } from "effect";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Hyperdrive } from "./Db.ts";
import * as schema from "./schema.ts";
import { relations, Users } from "./schema.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.filename,
    compatibility: {
      date: "2026-03-17",
      flags: ["nodejs_compat"],
    },
  },
  Effect.gen(function* () {
    const conn = yield* Cloudflare.Hyperdrive.bind(Hyperdrive);

    return {
      fetch: Effect.gen(function* () {
        const connectionString = yield* conn.connectionString;
        const db = drizzle(Redacted.value(connectionString), {
          schema,
          relations,
          mode: "default",
        });

        const close = Effect.tryPromise({
          try: () => db.$client.end(),
          catch: (cause) => cause,
        }).pipe(Effect.catch(() => Effect.void));

        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* Effect.gen(function* () {
          switch (request.method) {
            case "GET": {
              if (request.url === "/") {
                const users = yield* Effect.tryPromise({
                  try: () => db.select().from(Users),
                  catch: (cause) => cause,
                });
                return yield* HttpServerResponse.json({ users });
              }
              const id = Number(request.url.split("/").pop());
              if (Number.isNaN(id)) {
                return yield* HttpServerResponse.json(
                  { error: "Invalid user ID" },
                  { status: 400 },
                );
              }
              const user = yield* Effect.tryPromise({
                try: () =>
                  db.query.Users.findFirst({
                    where: { id },
                    with: { posts: true },
                  }),
                catch: (cause) => cause,
              });
              return yield* HttpServerResponse.json({ user });
            }
            case "POST": {
              const [created] = yield* Effect.tryPromise({
                try: () =>
                  db
                    .insert(Users)
                    .values({
                      name: crypto.randomUUID(),
                      email: crypto.randomUUID(),
                    })
                    .$returningId(),
                catch: (cause) => cause,
              });
              const user = yield* Effect.tryPromise({
                try: () =>
                  db.select().from(Users).where(eq(Users.id, created.id)),
                catch: (cause) => cause,
              });
              return yield* HttpServerResponse.json({ user });
            }
            case "DELETE": {
              const id = Number(request.url.split("/").pop());
              if (Number.isNaN(id)) {
                return yield* HttpServerResponse.json(
                  { error: "Invalid user ID" },
                  { status: 400 },
                );
              }
              const [user] = yield* Effect.tryPromise({
                try: () => db.select().from(Users).where(eq(Users.id, id)),
                catch: (cause) => cause,
              });
              yield* Effect.tryPromise({
                try: () => db.delete(Users).where(eq(Users.id, id)),
                catch: (cause) => cause,
              });
              return yield* HttpServerResponse.json({ user });
            }
            default: {
              return yield* HttpServerResponse.json(
                { error: "Method not allowed" },
                { status: 405 },
              );
            }
          }
        }).pipe(Effect.ensuring(close));
      }).pipe(
        Effect.catch((cause: any) => {
          const peel = (e: any): any => (e?.cause ? peel(e.cause) : e);
          const root = peel(cause);
          return HttpServerResponse.json(
            {
              ok: false,
              error: String(cause),
              rootError: root?.message ?? String(root),
              rootCode: root?.code,
            },
            { status: 500 },
          );
        }),
      ),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Cloudflare.HyperdriveBindingLive))),
) {}
