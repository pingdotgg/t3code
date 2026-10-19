import * as Context from "effect/Context";

/** Marks background host reads without granting rate-limit privileges. */
export const Background = Context.Reference<boolean>(
  "@t3tools/source-control-core/server/SourceControlReadContext/Background",
  { defaultValue: () => false },
);
