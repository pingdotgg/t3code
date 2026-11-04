import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Neon from "@alchemy.run/neon";
import * as Test from "@alchemy.run/test/Bun";
import * as Layer from "effect/Layer";

// #region show
const { test, beforeAll, deploy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Neon.providers()),
  dev: true,
});
// #endregion show
void [test, beforeAll, deploy];
