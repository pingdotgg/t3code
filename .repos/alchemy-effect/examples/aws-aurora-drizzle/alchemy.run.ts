import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { database } from "./src/database.ts";

export default Alchemy.Stack(
  "aws-aurora-drizzle",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const api = yield* Api;
    const db = yield* database;
    return {
      url: api.functionUrl,
      functionName: api.functionName,
      clusterId: db.cluster.dbClusterIdentifier,
      writerId: db.writer.dbInstanceIdentifier,
      vpcId: db.vpc.vpcId,
    };
  }),
);
