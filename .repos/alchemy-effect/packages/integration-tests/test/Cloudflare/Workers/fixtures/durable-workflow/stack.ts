import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import EuDurableWorkflowWorker from "./eu-worker.ts";
import NativeEngineWorker from "./native-worker.ts";
import DurableWorkflowWorker from "./worker.ts";

const stacks = {
  "durable-object": { name: "DurableWorkflowStack", worker: DurableWorkflowWorker },
  "durable-object-eu": { name: "EuDurableWorkflowStack", worker: EuDurableWorkflowWorker },
  native: { name: "NativeEngineStack", worker: NativeEngineWorker },
};

export default (state = Cloudflare.state(), engine: keyof typeof stacks = "durable-object") =>
  Alchemy.Stack(
    stacks[engine].name,
    { providers: Cloudflare.providers(), state },
    Effect.gen(function* () {
      const worker = yield* stacks[engine].worker;
      return { url: worker.url.as<string>() };
    }),
  );
