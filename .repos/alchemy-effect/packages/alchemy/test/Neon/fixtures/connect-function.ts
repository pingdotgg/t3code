import { Function } from "@/Neon/Function";
import * as Effect from "effect/Effect";
import { ConnectBranch } from "./connect-database.ts";
import { connectHandler } from "./connect-handler.ts";

export default class ConnectFunction extends Function<ConnectFunction>()(
  "ConnectFunction",
  Effect.gen(function* () {
    return { branch: yield* ConnectBranch, main: import.meta.url };
  }),
  connectHandler,
) {}
