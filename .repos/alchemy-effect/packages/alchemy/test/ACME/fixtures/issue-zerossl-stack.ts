import * as ACME from "@/ACME";
import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
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
