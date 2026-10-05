import { GcpEnvironment } from "@/GCP/Environment";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);
export const location = "us-central1";

export const missingService = (serviceId = "alchemy-missing-service") =>
  currentProject.pipe(
    Effect.map(
      (project) =>
        `projects/${project}/locations/${location}/services/${serviceId}`,
    ),
  );

export const missingSchema = (serviceId = "alchemy-missing-service") =>
  missingService(serviceId).pipe(Effect.map((name) => `${name}/schemas/main`));

export const missingConnector = (serviceId = "alchemy-missing-service") =>
  missingService(serviceId).pipe(
    Effect.map((name) => `${name}/connectors/alchemy-missing-connector`),
  );

export const schemaSource = (extraField?: string) => ({
  files: [
    {
      path: "schema.gql",
      content:
        extraField === undefined
          ? "type AlchemyNote @table { title: String! }"
          : `type AlchemyNote @table { title: String! ${extraField} }`,
    },
  ],
});

export const unlinkedDatasources = [
  { postgresql: { unlinked: true as const } },
];

export const connectorSource = {
  files: [
    {
      path: "queries.gql",
      content:
        "query ListAlchemyNotes @auth(level: PUBLIC) { alchemyNotes { id title } }",
    },
  ],
};
