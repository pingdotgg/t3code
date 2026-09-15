import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { localState } from "alchemy/State";

import CanaryEdgeLive, { CanaryEdge } from "./src/transport/CanaryEdgeWorker.ts";

export default Alchemy.Stack(
  "T3RelayEdgeCanary",
  {
    providers: Cloudflare.providers(),
    // This operational canary is intentionally disposable and keeps its
    // deployment ledger local so testing it cannot mutate shared Alchemy state.
    state: localState(),
  },
  Effect.gen(function* () {
    const edge = yield* CanaryEdge;
    return {
      workerName: edge.workerName,
      url: edge.url,
    };
  }).pipe(Effect.provide(CanaryEdgeLive)),
);
