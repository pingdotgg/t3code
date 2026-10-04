import * as Effect from "effect/Effect";
import * as ClientIntents from "../../../clientIntents.ts";
import { readThread } from "../../threadAccess.ts";
import { ClientToolkit } from "./tools.ts";

export const ClientToolkitHandlersLive = ClientToolkit.toLayer({
  t3_client_open_thread: (input) =>
    Effect.gen(function* () {
      const {
        scope,
        projection: { thread },
      } = yield* readThread(input.threadId);
      const clientIntents = yield* ClientIntents.ClientIntents;
      const delivered = yield* clientIntents.openThread({
        environmentId: scope.environmentId,
        threadId: thread.id,
        ...(input.panel === undefined ? {} : { panel: input.panel }),
      });
      return { threadId: thread.id, delivered };
    }),
});
