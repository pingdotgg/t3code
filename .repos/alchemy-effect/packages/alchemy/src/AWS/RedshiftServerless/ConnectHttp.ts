import * as serverless from "@distilled.cloud/aws/redshift-serverless";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import { formatSqlConnectionUrl } from "../Connection/internal.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { Connect, connectEnvPrefix, type ConnectOptions } from "./Connect.ts";
import type { Workgroup } from "./Workgroup.ts";

const DEFAULT_PORT = 5439;
const DEFAULT_DATABASE = "dev";

const unwrap = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

/**
 * SDK-backed implementation of {@link Connect}. Deploy half attaches the
 * `redshift-serverless:GetCredentials` policy on the workgroup ARN and
 * publishes `REDSHIFT_SERVERLESS_{LOGICAL_ID}_{HOST,PORT}` on the host
 * Function; runtime half mints temporary credentials via
 * `redshift-serverless:GetCredentials` and formats a pgwire connection URL.
 */
export const ConnectHttp = Layer.effect(
  Connect,
  Effect.gen(function* () {
    const getCredentials = yield* serverless.getCredentials;

    return Effect.fn(function* (
      workgroup: Workgroup,
      options: ConnectOptions = {},
    ) {
      const WorkgroupName = yield* workgroup.workgroupName;
      const Host = yield* workgroup.endpointAddress;
      const Port = yield* workgroup.endpointPort;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const prefix = connectEnvPrefix(workgroup.LogicalId);
          yield* host.bind`Allow(${host}, AWS.RedshiftServerless.Connect(${workgroup}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["redshift-serverless:GetCredentials"],
                  Resource: [workgroup.workgroupArn],
                },
              ],
              env: {
                [`${prefix}_HOST`]: workgroup.endpointAddress,
                // Lambda environment variables are strings — stringify the port.
                [`${prefix}_PORT`]: Output.interpolate`${workgroup.endpointPort}`,
              },
            },
          );
        }
      }

      const database = options.database ?? DEFAULT_DATABASE;

      return Effect.gen(function* () {
        const workgroupName = yield* WorkgroupName;
        const host = yield* Host;
        const port = (yield* Port) ?? DEFAULT_PORT;
        if (!host) {
          return yield* Effect.die(
            `Redshift Serverless workgroup endpoint for '${workgroup.LogicalId}' is not available yet`,
          );
        }
        const credentials = yield* getCredentials({
          workgroupName,
          dbName: database,
          durationSeconds: toWireSeconds(options.duration),
        });
        const username = unwrap(credentials.dbUser);
        const rawPassword = unwrap(credentials.dbPassword);
        const password =
          rawPassword === undefined ? undefined : Redacted.make(rawPassword);
        return {
          host,
          port,
          database,
          username,
          password,
          // Redshift Serverless endpoints require TLS.
          ssl: true,
          expiration: credentials.expiration,
          url: formatSqlConnectionUrl({
            host,
            port,
            database,
            username,
            password,
            ssl: true,
          }),
        };
      });
    });
  }),
);
