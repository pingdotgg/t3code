import * as CodeConnections from "@/AWS/CodeConnections";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Connection names are capped at 32 chars.
export const fixtureConnectionName = "alchemy-test-codeconn-bind";

export class CodeConnectionsTestFunction extends Lambda.Function<Lambda.Function>()(
  "CodeConnectionsTestFunction",
) {}

export default CodeConnectionsTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // The fixture connection stays PENDING (its OAuth handshake is a manual
    // console step) — reading its live state still exercises the bindings.
    const connection = yield* CodeConnections.Connection("BindingsConn", {
      connectionName: fixtureConnectionName,
      providerType: "GitHub",
    });

    // --- connection-scoped binding ---
    const getConnection = yield* CodeConnections.GetConnection(connection);

    // --- account-level bindings ---
    const listConnections = yield* CodeConnections.ListConnections();
    const listHosts = yield* CodeConnections.ListHosts();
    const listRepositoryLinks = yield* CodeConnections.ListRepositoryLinks();

    const bound = {
      getConnection,
      listConnections,
      listHosts,
      listRepositoryLinks,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/connection") {
          // Exercises `ConnectionArn` injection + the IAM grant on the
          // connection ARN (a grant gap would surface AccessDeniedException
          // and fail the route with an opaque 500).
          const result = yield* getConnection();
          return yield* HttpServerResponse.json({
            name: result.Connection?.ConnectionName ?? null,
            status: result.Connection?.ConnectionStatus ?? null,
            providerType: result.Connection?.ProviderType ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/connections") {
          const result = yield* listConnections({
            ProviderTypeFilter: "GitHub",
          });
          return yield* HttpServerResponse.json({
            names: (result.Connections ?? []).map(
              (c) => c.ConnectionName ?? null,
            ),
          });
        }

        if (request.method === "GET" && pathname === "/hosts") {
          const result = yield* listHosts();
          return yield* HttpServerResponse.json({
            names: (result.Hosts ?? []).map((h) => h.Name ?? null),
          });
        }

        if (request.method === "GET" && pathname === "/repository-links") {
          const result = yield* listRepositoryLinks();
          return yield* HttpServerResponse.json({
            repositories: (result.RepositoryLinks ?? []).map(
              (l) => l.RepositoryName ?? null,
            ),
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        CodeConnections.GetConnectionHttp,
        CodeConnections.ListConnectionsHttp,
        CodeConnections.ListHostsHttp,
        CodeConnections.ListRepositoryLinksHttp,
      ),
    ),
  ),
);
