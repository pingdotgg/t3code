import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Neon from "@alchemy.run/neon";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import Chat from "./ChatModules.ts";

// #region show
export default Alchemy.Stack(
  "Chat",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Neon.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const chat = yield* Chat;
    // #region comment
    const pullRequest = yield* Config.Int("PULL_REQUEST").pipe(
      Config.option,
      Config.map(Option.getOrUndefined),
    );

    if (pullRequest) {
      yield* GitHub.Comment("Preview", {
        owner: "alchemy-run",
        repository: "chat",
        issueNumber: pullRequest,
        body: Output.interpolate`🚀 Preview deployed to ${chat.url}`,
      });
    }
    // #endregion comment
    return { url: chat.url.as<string>() };
  }),
);
// #endregion show
