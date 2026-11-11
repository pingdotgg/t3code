import * as Cloudflare from "@alchemy.run/cloudflare";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

// #region show
// #region top
export default Cloudflare.Worker(
  "Chat",
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    return {
      main: import.meta.url,
      // #region preview
      preview: stage.startsWith("pr-")
        ? { of: yield* Cloudflare.Worker.ref("Chat", { stage: "staging" }) }
        : undefined,
      // #endregion preview
    };
  }),
  Effect.gen(function* () {
    // #endregion top
    return {
      fetch: Effect.succeed(HttpServerResponse.text("hello")),
    };
    // #region bottom
  }),
);
// #endregion bottom
// #endregion show
