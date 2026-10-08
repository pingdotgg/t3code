import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { BootstrapDatabase } from "./src/bootstrap.ts";
import { Database } from "./src/database.ts";

export default Alchemy.Stack(
  "aws-dsql-drizzle",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const cluster = yield* Database;
    const api = yield* Api;
    const schemaVersion = yield* BootstrapDatabase({
      endpoint: cluster.endpoint,
      roleArn: api.roleArn,
      version: "1",
    });
    return {
      url: api.functionUrl,
      functionName: api.functionName,
      roleName: api.roleName,
      clusterId: cluster.clusterId,
      schemaVersion,
    };
  }),
);
