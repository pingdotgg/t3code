import * as Logger from "effect/Logger";
import { ANSI_RESET, colorsEnabled } from "./Terminal.ts";

/** Effect pretty prefixes with selective color and untouched message styling. */
export const makePlainConsoleSink = (colors = colorsEnabled()) => {
  const pretty = Logger.consolePretty({ colors });
  if (!colors) return pretty;
  return Logger.make<unknown, void>((options) => {
    const messages = Array.isArray(options.message)
      ? options.message
      : [options.message];
    pretty.log({
      ...options,
      // consolePretty applies bold cyan around the first string. Reset that
      // wrapper before the content; any intentional ANSI inside the message
      // still takes effect normally.
      message: [
        `${ANSI_RESET}${String(messages[0] ?? "")}`,
        ...messages.slice(1),
      ],
    });
  });
};
