import * as Context from "effect/Context";
import { GenericService } from "./Util/service.ts";

export interface Self<
  R extends { Type: string } = { Type: string },
> extends Context.ServiceClass<Self<R>, `Self<${R["Type"]}>`, R> {}

export const Self = GenericService<{
  <R extends { Type: string }>(type: R["Type"]): Self<R>;
}>()("Alchemy::Self");
