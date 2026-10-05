import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { ApiKey, Links } from "./src/resources.ts";

export default Alchemy.Stack(
  "GcpCloudRunApiExample",
  { providers: GCP.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const links = yield* Links;
    const apiKey = yield* ApiKey;
    const api = yield* Api;

    return {
      url: api.uri,
      databaseId: links.databaseId,
      databaseName: links.name,
      // Seed the key with:
      //   printf 'my-key' | gcloud secrets versions add "$secretId" --data-file=-
      secretId: apiKey.secretId,
      secretName: apiKey.name,
    };
  }),
);
