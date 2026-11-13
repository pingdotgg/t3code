import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Connector } from "./src/Connector.ts";
import { Hyperdrive } from "./src/Hyperdrive.ts";

export default Alchemy.Stack(
  "CloudflareHyperdriveAwsVpc",
  {
    providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers(), Alchemy.RandomProvider()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    yield* Connector;
    const hd = yield* Hyperdrive;
    const worker = yield* Cloudflare.Worker("Api", {
      main: "./src/worker.ts",
      compatibility: { flags: ["nodejs_compat"] },
      env: { DB: hd },
    });
    return {
      url: worker.url,
      hyperdriveId: hd.hyperdriveId,
    };
  }),
);
