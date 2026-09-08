import { withLock } from "@/Auth/Lock.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

const key = process.argv[2];
if (!key) throw new Error("Missing lock key");

await Effect.runPromise(
  withLock(
    key,
    Effect.sync(() => process.stdout.write("ready\n")).pipe(
      Effect.andThen(Effect.never),
    ),
  ).pipe(Effect.provide(NodeServices.layer)),
);
