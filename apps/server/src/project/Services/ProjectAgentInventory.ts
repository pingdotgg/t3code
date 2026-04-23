import type { ServerLocalAgentInventory } from "@harness/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface ProjectAgentInventoryShape {
  readonly getInventory: (cwd: string) => Effect.Effect<ServerLocalAgentInventory, never>;
  readonly invalidate: (cwd: string) => Effect.Effect<void, never>;
}

export class ProjectAgentInventory extends Context.Service<
  ProjectAgentInventory,
  ProjectAgentInventoryShape
>()("harness/project/ProjectAgentInventory") {}
