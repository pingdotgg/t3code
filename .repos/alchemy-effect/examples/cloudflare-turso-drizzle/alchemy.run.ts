import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle";
import * as Turso from "@alchemy.run/turso";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";
import { Template } from "./src/Db.ts";

export default Alchemy.Stack(
  "CloudflareTursoDrizzleExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Turso.providers(), Drizzle.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const template = yield* Template;
    const api = yield* Api;

    return {
      url: api.url.as<string>(),
      template: template.name,
    };
  }),
);
