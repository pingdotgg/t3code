import * as Cloudflare from "@/Cloudflare";
import * as Prisma from "@/Prisma";
import type { RuntimeContext } from "@/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

declare const connection: Prisma.Connection;

type ApiShape = {
  databaseUrl(): Effect.Effect<
    Redacted.Redacted<string>,
    never,
    RuntimeContext
  >;
};

export class PrismaWorkerApi extends Cloudflare.Worker<
  PrismaWorkerApi,
  ApiShape
>()("PrismaWorkerApi") {}

export const PrismaWorkerApiLive = PrismaWorkerApi.make(
  {
    main: import.meta.filename,
    compatibility: {
      flags: ["nodejs_compat"],
    },
  },
  Effect.gen(function* () {
    const db = yield* Prisma.Connect(connection);

    return PrismaWorkerApi.of({
      databaseUrl: () => db.databaseUrl,
      fetch: Effect.gen(function* () {
        const databaseUrl = yield* db.databaseUrl;
        return yield* HttpServerResponse.json({
          ok: true,
          hasDatabaseUrl: Redacted.isRedacted(databaseUrl),
        });
      }),
    });
  }).pipe(Effect.provide(Prisma.ConnectBinding)),
);
