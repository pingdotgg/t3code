import * as GCP from "@alchemy.run/gcp";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Chat from "./src/Chat.ts";

export default Alchemy.Stack(
  "GcpVertexAiExample",
  { providers: GCP.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const chat = yield* Chat;
    return {
      url: chat.uri,
      serviceName: chat.name,
      serviceAccount: chat.serviceAccount,
    };
  }),
);
