import * as Config from "effect/Config";
import * as Option from "effect/Option";

export const SOURCE_CHECKOUT_ENV = "T3CODE_SOURCE_CHECKOUT";
const SOURCE_UPDATE_COMMAND_ENV = "T3CODE_SOURCE_UPDATE_COMMAND";

/** The git checkout this server runs from; setting it opts into source updates. */
export const sourceCheckoutConfig = Config.String(SOURCE_CHECKOUT_ENV).pipe(
  Config.map((path) => path.trim()),
  Config.option,
  Config.map(Option.filter((path) => path.length > 0)),
);

/** The program Update runs; defaults to the checkout's `scripts/self-update.sh`. */
export const sourceUpdateCommandConfig = Config.String(SOURCE_UPDATE_COMMAND_ENV).pipe(
  Config.map((command) => command.trim()),
  Config.option,
  Config.map(Option.filter((command) => command.length > 0)),
);
