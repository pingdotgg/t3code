import { Function } from "@/Railway/Function.ts";
import * as pathe from "pathe";
import { Partition, Site } from "./suite-env.ts";

export { Site };

/**
 * Async-style Function: `main` points at {@link ./async-ping.ts} and there
 * is no `Effect.gen` implementation, so Alchemy marks it `isExternal` and
 * bundles without the Effect bootstrap (stays under the 96KB canvas cap).
 */
export const AsyncPing = Function("AsyncPing", {
  project: Site,
  environment: Partition,
  main: pathe.resolve(import.meta.dirname, "async-ping.ts"),
});
