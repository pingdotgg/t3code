import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";
import {
  connectorSource,
  schemaSource,
  unlinkedDatasources,
} from "../common.ts";

/** Data Connect service with an unlinked Postgres datasource. */
export const App = GCP.FirebaseDataConnect.Service("App", {
  labels: { env: "test" },
});

/** Service + schema + connector (list query, insert mutation). */
export const Queries = Effect.gen(function* () {
  const service = yield* App;
  const schema = yield* GCP.FirebaseDataConnect.ServicesSchema("Main", {
    service: service.name,
    source: schemaSource(),
    datasources: unlinkedDatasources,
    labels: { env: "test" },
  });
  return yield* GCP.FirebaseDataConnect.ServicesConnector("Queries", {
    service: schema.service,
    source: {
      files: [
        ...connectorSource.files,
        {
          path: "mutations.gql",
          content:
            "mutation CreateAlchemyNote($title: String!) @auth(level: PUBLIC) { alchemyNote_insert(data: { title: $title }) }",
        },
      ],
    },
    labels: { env: "test" },
  });
});

/**
 * Effect-native Cloud Run service exercising every Data Connect binding as
 * its own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class DataConnectBindingsHost extends GCP.Function<DataConnectBindingsHost>()(
  "DataConnectBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const service = yield* App;
    const connector = yield* Queries;
    const executeGraphql =
      yield* GCP.FirebaseDataConnect.ExecuteGraphql(service);
    const executeGraphqlRead =
      yield* GCP.FirebaseDataConnect.ExecuteGraphqlRead(service);
    const executeQuery = yield* GCP.FirebaseDataConnect.ExecuteQuery(connector);
    const executeMutation =
      yield* GCP.FirebaseDataConnect.ExecuteMutation(connector);

    return {
      fetch: serveProbes({
        executeGraphql: executeGraphql({ body: { query: "{ __typename }" } }),
        executeGraphqlRead: executeGraphqlRead({
          body: { query: "{ __typename }" },
        }),
        executeQuery: executeQuery({
          body: { operationName: "ListAlchemyNotes" },
        }),
        executeMutation: executeMutation({
          body: {
            operationName: "CreateAlchemyNote",
            variables: { title: "hello" },
          },
        }),
      }),
    };
  }).pipe(
    Effect.provide(GCP.FirebaseDataConnect.ExecuteGraphqlHttp),
    Effect.provide(GCP.FirebaseDataConnect.ExecuteGraphqlReadHttp),
    Effect.provide(GCP.FirebaseDataConnect.ExecuteQueryHttp),
    Effect.provide(GCP.FirebaseDataConnect.ExecuteMutationHttp),
  ),
) {}
