import * as ACME from "@alchemy.run/acme";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import AcmeIssueZeroSslWorker from "./issue-worker-zerossl.ts";

export default Alchemy.Stack(
  "AcmeIssueZeroSslStack",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), ACME.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* AcmeIssueZeroSslWorker;
    return { url: worker.url.as<string>() };
  }),
);
