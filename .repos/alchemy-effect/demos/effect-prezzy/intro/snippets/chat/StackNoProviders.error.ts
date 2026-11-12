import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Chat from "./ChatModules.ts";

// #region show
export default Alchemy.Stack(
  "Chat",
  {
    // #region providers
    providers: Layer.empty,
    // #endregion providers
    // #region state
    state: Cloudflare.state(),
    // #endregion state
  },
  Effect.gen(function* () {
    // #region chat
    const chat = yield* Chat;
    // #endregion chat
    // #region ret
    return { url: chat.url.as<string>() };
    // #endregion ret
  }),
);
// #endregion show
