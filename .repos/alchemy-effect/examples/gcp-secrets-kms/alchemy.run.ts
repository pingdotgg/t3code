import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { ApiKey, DataKey, Keys } from "./src/resources.ts";

export default Alchemy.Stack(
  "GcpSecretsKmsExample",
  { providers: GCP.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const keys = yield* Keys;
    const dataKey = yield* DataKey;
    const apiKey = yield* ApiKey;
    const api = yield* Api;

    return {
      url: api.uri,
      serviceName: api.name,
      keyRingName: keys.name,
      cryptoKeyName: dataKey.name,
      // Seed the key with:
      //   printf 'my-key' | gcloud secrets versions add "$secretId" --data-file=-
      secretId: apiKey.secretId,
      secretName: apiKey.name,
    };
  }),
);
