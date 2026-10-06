import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import Gateway from "./src/Gateway.ts";
import Quotes from "./src/Quotes.ts";

export default Alchemy.Stack(
  "GcpServiceToServiceExample",
  { providers: GCP.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const quotes = yield* Quotes;
    const gateway = yield* Gateway;

    return {
      url: gateway.uri,
      gatewayName: gateway.name,
      gatewayServiceAccount: gateway.serviceAccount,
      quotesUrl: quotes.uri,
      quotesName: quotes.name,
    };
  }),
);
