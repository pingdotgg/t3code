import * as Drizzle from "@alchemy.run/drizzle";
import * as GCP from "@alchemy.run/gcp";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";
import { database } from "./src/database.ts";
import { storePassword } from "./src/password.ts";

export const providers = () =>
  Layer.mergeAll(GCP.providers(), Drizzle.providers(), Alchemy.RandomProvider());

export default Alchemy.Stack(
  "GcpCloudSqlDrizzleExample",
  { providers: providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const { instance, db, user, passwordSecret } = yield* database;
    yield* storePassword;
    const api = yield* Api;
    return {
      url: api.uri,
      serviceName: api.name,
      instanceName: instance.instanceName,
      connectionName: instance.connectionName,
      databaseName: db.databaseName,
      userName: user.userName,
      passwordSecretName: passwordSecret.name,
    };
  }),
);
