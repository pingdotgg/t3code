import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Admin from "./src/Admin.ts";
import Home from "./src/Home.ts";
import Orders from "./src/Orders.ts";
import Products from "./src/Products.ts";

/**
 * One URL, four Workers, no gateway Worker in between.
 *
 * `Home` owns the hostname as a custom domain; `Products`, `Orders` and
 * `Admin` each claim a path with a zone route. Cloudflare matches routes
 * before custom domains, so a request goes straight to the Worker that
 * owns its path. `alchemy dev` emulates the same routing table on `Home`'s
 * local URL.
 */
export default Alchemy.Stack(
  "CloudflareFederatedApi",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const home = yield* Home;
    yield* Products;
    yield* Orders;
    yield* Admin;

    return {
      url: home.url.as<string>(),
    };
  }),
);
