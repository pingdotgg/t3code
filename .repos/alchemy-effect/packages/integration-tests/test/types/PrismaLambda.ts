import * as AWS from "@alchemy.run/aws";
import * as Prisma from "@alchemy.run/prisma";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";

declare const connection: Prisma.Connection;

type ApiShape = {
  databaseUrl(): Effect.Effect<Redacted.Redacted<string>, never, RuntimeContext>;
};

export class PrismaLambdaApi extends AWS.Lambda.Function<PrismaLambdaApi, ApiShape>()(
  "PrismaLambdaApi",
) {}

export const PrismaLambdaApiLive = PrismaLambdaApi.make(
  {
    main: import.meta.filename,
    functionUrl: true,
  },
  Effect.gen(function* () {
    const db = yield* Prisma.Connect(connection);

    return PrismaLambdaApi.of({
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
