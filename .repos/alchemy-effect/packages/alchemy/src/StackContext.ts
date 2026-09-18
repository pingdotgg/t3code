import * as Context from "effect/Context";
import type { Stack, StackSpec } from "./Stack.ts";

export const StackContext = Context.Service<Stack, Omit<StackSpec, "output">>()(
  "Stack",
);
