import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as WebTools from "../../../web/WebTools.ts";
import { WebToolkit } from "./tools.ts";

// Every web tools error message is built on the server and tells the agent what to do next.
const toFailure = (error: WebTools.WebToolsError) =>
  new OrchestratorMcpFailure({
    code: error._tag === "WebToolsDisabledError" ? "capability_denied" : "provider_unavailable",
    message: error.message,
  });

const isHttpUrl = (value: string) => {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

export const layer = WebToolkit.toLayer({
  web_search: (input) =>
    Effect.gen(function* () {
      const web = yield* WebTools.WebTools;
      return yield* web.search(input).pipe(Effect.mapError(toFailure));
    }),
  web_fetch: (input) =>
    Effect.gen(function* () {
      if (!isHttpUrl(input.url)) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Pass an http or https URL.",
        });
      }
      const web = yield* WebTools.WebTools;
      return yield* web.fetch(input).pipe(Effect.mapError(toFailure));
    }),
});
