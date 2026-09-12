import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Uploads } from "./src/Uploads.ts";

export default Alchemy.Stack(
  "Demo",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    const uploads = yield* Uploads;
    return {
      url: api.url.as<string>(),
      bucket: uploads.bucketName,
    };
  }),
);
