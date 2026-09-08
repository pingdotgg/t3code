import * as Prisma from "alchemy/Prisma";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Connection, Project, region, appNameConfig } from "./Database.ts";

const messageConfig = Config.string("PRISMA_EFFECT_MESSAGE").pipe(
  Effect.orElseSucceed(() => "hello from Effect-native Prisma Compute"),
);

export default class Api extends Prisma.Compute<Api>()(
  "Api",
  Effect.gen(function* () {
    const project = yield* Project;

    return {
      project,
      appName: yield* appNameConfig,
      regionId: region,
      branchGitName: "main",
      main: import.meta.filename,
      port: 3000,
      healthCheck: { path: "/api/health" },
      env: {
        PRISMA_EFFECT_MESSAGE: yield* messageConfig,
      },
      destroyOldDeployment: true,
    };
  }),
  Effect.gen(function* () {
    const db = yield* Prisma.Connect(Connection);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");

        if (url.pathname !== "/" && url.pathname !== "/api/health") {
          return HttpServerResponse.text("Not found", { status: 404 });
        }

        if (request.method !== "GET") {
          return HttpServerResponse.text("Method not allowed", { status: 405 });
        }

        yield* db.databaseUrl;

        const response: Record<string, string | boolean> = {
          ok: true,
          mode: "effect-native",
          databaseBinding: "ready",
        };

        if (url.pathname === "/") {
          response.message = yield* messageConfig;
        }

        return yield* HttpServerResponse.json(response);
      }),
    };
  }).pipe(Effect.provide(Prisma.ConnectBinding)),
) {}
