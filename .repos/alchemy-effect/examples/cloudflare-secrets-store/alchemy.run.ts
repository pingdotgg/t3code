import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import Api from "./src/Api.ts";
import { Store } from "./src/Store.ts";

export default Alchemy.Stack(
  "CloudflareSecretsStoreExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const store = yield* Store;
    const api = yield* Api;

    return {
      url: api.url.as<string>(),
      storeId: store.storeId,
    };
  }),
);
