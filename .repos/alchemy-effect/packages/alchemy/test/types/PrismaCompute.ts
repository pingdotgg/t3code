import * as Prisma from "@/Prisma";
import type { RuntimeContext } from "@/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

declare const connection: Prisma.Connection;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;
type EffectRequirement<T> =
  T extends Effect.Effect<unknown, unknown, infer R> ? R : never;

type ApiShape = {
  connectionId(): Effect.Effect<string, never, RuntimeContext>;
};

export class PrismaComputeApi extends Prisma.Compute<
  PrismaComputeApi,
  ApiShape
>()("PrismaComputeApi") {}

export const PrismaComputeApiLive = PrismaComputeApi.make(
  {
    project: "project-1",
    appName: "api",
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const db = yield* Prisma.Connect(connection);
    type _DatabaseUrlIsRuntimeOnly = Expect<
      Equal<EffectRequirement<typeof db.databaseUrl>, RuntimeContext>
    >;
    type _ConnectionIdIsRuntimeOnly = Expect<
      Equal<EffectRequirement<typeof db.connectionId>, RuntimeContext>
    >;

    return PrismaComputeApi.of({
      connectionId: () => db.connectionId,
      fetch: Effect.gen(function* () {
        const databaseUrl = yield* db.databaseUrl;
        const exitCode = yield* Effect.gen(function* () {
          const child = yield* ChildProcess.make("echo", ["ok"]);
          return yield* child.exitCode;
        }).pipe(Effect.catch(() => Effect.succeed(-1)));
        return yield* HttpServerResponse.json({
          ok: true,
          hasDatabaseUrl: Redacted.isRedacted(databaseUrl),
          exitCode,
        });
      }),
    });
  }).pipe(Effect.provide(Prisma.ConnectBinding)),
);
