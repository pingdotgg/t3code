import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Neon from "@/Neon/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Hyperdrive, NeonDb } from "./db.ts";
import DrizzleWorkflowWorker from "./worker.ts";

/**
 * Deploys a Neon project + branch, a Cloudflare Hyperdrive pointed at it, and
 * the {@link DrizzleWorkflowWorker} that hosts the Drizzle-in-Workflow
 * regression workflow.
 */
export default Alchemy.Stack(
  "DrizzleWorkflowStack",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Neon.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    yield* NeonDb;
    yield* Hyperdrive;
    const worker = yield* DrizzleWorkflowWorker;
    return { url: worker.url.as<string>() };
  }),
);
