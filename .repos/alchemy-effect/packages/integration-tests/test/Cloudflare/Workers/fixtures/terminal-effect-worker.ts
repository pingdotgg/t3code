import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Terminal from "effect/Terminal";

/**
 * Effect-native Worker on the default compatibility date, where `process`
 * has a `stdin`: the runtime still provides `Terminal` to its handlers.
 */
export default class TerminalEffectWorker extends Cloudflare.Worker<TerminalEffectWorker>()(
  "TerminalEffectWorker",
  {
    main: import.meta.url,
  },
  Effect.succeed({
    fetch: Effect.gen(function* () {
      const terminal = yield* Terminal.Terminal;
      const columns = yield* terminal.columns;
      return HttpServerResponse.text(`Terminal provided (${typeof columns})`);
    }),
  }),
) {}
