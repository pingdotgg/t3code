import * as Console from "effect/Console";
import { Argument, Command } from "effect/unstable/cli";

import {
  ANTIGRAVITY_AUTH_BROWSER_MARKER,
  ANTIGRAVITY_BROWSER_HELPER_COMMAND,
} from "../provider/antigravityAuthSupport.ts";

/**
 * Hosts the no-browser helper inside the single executable. Script installs
 * run the equivalent inline source under Node, while a SEA has no Node
 * interpreter for `-e` and invokes this hidden subcommand instead.
 */
export const antigravityBrowserCommand = Command.make(ANTIGRAVITY_BROWSER_HELPER_COMMAND, {
  url: Argument.string("url"),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ url }) =>
    Console.error(`${ANTIGRAVITY_AUTH_BROWSER_MARKER}${JSON.stringify(url)}`),
  ),
);
