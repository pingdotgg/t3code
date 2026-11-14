import * as Config from "effect/Config";
import * as Option from "effect/Option";

export const SOURCE_CHECKOUT_ENV = "T3CODE_SOURCE_CHECKOUT";
const SOURCE_UPDATE_COMMAND_ENV = "T3CODE_SOURCE_UPDATE_COMMAND";
export const SOURCE_UPDATE_SERVICE_ENV = "T3CODE_SOURCE_UPDATE_SERVICE";

/** The git checkout this server runs from; setting it opts into source updates. */
export const sourceCheckoutConfig = Config.String(SOURCE_CHECKOUT_ENV).pipe(
  Config.map((path) => path.trim()),
  Config.option,
  Config.map(Option.filter((path) => path.length > 0)),
);

/** The command line Update runs, split like a shell would; defaults to the checkout's `scripts/self-update.sh`. */
export const sourceUpdateCommandConfig = Config.String(SOURCE_UPDATE_COMMAND_ENV).pipe(
  Config.map((command) => command.trim()),
  Config.option,
  Config.map(Option.filter((command) => command.length > 0)),
);

/** The systemd user unit Update restarts, when this server runs inside it. */
export const sourceUpdateServiceConfig = Config.String(SOURCE_UPDATE_SERVICE_ENV).pipe(
  Config.map((service) => service.trim()),
  Config.withDefault("t3code"),
);
