import * as Effect from "effect/Effect";

import { makeGitCafeProviderClient } from "./GitCafeProviderClient.ts";
import { makeGitCafeProviderApi } from "./GitCafePullRequestProviderParts.ts";

export * from "./GitCafeProviderModel.ts";

export const make = Effect.gen(function* () {
  const client = yield* makeGitCafeProviderClient;
  return makeGitCafeProviderApi(client);
});
