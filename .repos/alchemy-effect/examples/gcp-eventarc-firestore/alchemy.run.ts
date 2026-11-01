import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import Auditor from "./src/Auditor.ts";
import { Shop } from "./src/resources.ts";

export default Alchemy.Stack(
  "GcpEventarcFirestoreExample",
  { providers: GCP.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const shop = yield* Shop;
    const api = yield* Api;
    const auditor = yield* Auditor;

    return {
      url: api.uri,
      auditorService: auditor.serviceId,
      project: shop.project,
      databaseId: shop.databaseId,
      databaseName: shop.name,
    };
  }),
);
