import { Connect, ConnectHttp, connectEnvKeys } from "@/Neon/Connect";
import { CurrentRuntimeContext } from "@/RuntimeContext";
import { Postgres } from "@/SQL/Postgres";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { ConnectBranch, ConnectProject } from "./connect-database.ts";

export const connectHandler = Effect.gen(function* () {
  const context = yield* CurrentRuntimeContext;
  if (!context)
    return yield* Effect.die(new Error("Connect fixture requires a host"));
  const branchResource = yield* ConnectBranch;
  const keys = connectEnvKeys(branchResource);
  const branch = yield* Connect(branchResource);
  const projectResource = yield* ConnectProject;
  const projectKeys = connectEnvKeys(projectResource);
  const project = yield* Connect(projectResource);
  const pooled = yield* Postgres({ url: branch.connectionString });
  const direct = yield* Postgres({ url: branch.directConnectionString });
  const parent = yield* Postgres({ url: project.pooledConnectionString });
  return {
    fetch: Effect.gen(function* () {
      const rows =
        yield* pooled`SELECT current_database() AS database, value FROM alchemy_connect_marker`;
      const directRows =
        yield* direct`SELECT current_database() AS database, value FROM alchemy_connect_marker`;
      const parentRows =
        yield* parent`SELECT current_database() AS database, value FROM alchemy_connect_marker`;
      const accountKey = yield* context.get<string>("NEON_API_KEY");
      return yield* HttpServerResponse.json({
        database: rows[0]?.database,
        directDatabase: directRows[0]?.database,
        parentDatabase: parentRows[0]?.database,
        branchMarker: rows[0]?.value,
        directMarker: directRows[0]?.value,
        parentMarker: parentRows[0]?.value,
        hasAccountKey: accountKey !== undefined,
        injected: yield* context.get<boolean>(keys.injected),
        parentInjected: yield* context.get<boolean>(projectKeys.injected),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        HttpServerResponse.json({
          error: Cause.pretty(cause).replace(
            /postgres(?:ql)?:\/\/[^\s"']+/g,
            "<redacted-database-url>",
          ),
        }),
      ),
      Effect.orDie,
    ),
  };
}).pipe(Effect.provide(ConnectHttp));
