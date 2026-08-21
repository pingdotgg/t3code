/**
 * MirrorHooks - host-side side effects after mirror contents change.
 *
 * MirrorService stays ignorant of terminals, search indexes, and VCS status
 * broadcasting; server wiring provides the real implementations. Tests and
 * the origin-side runtime use the no-op layer.
 *
 * @module MirrorHooks
 */
import type { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface MirrorChangedInput {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
}

export class MirrorHooks extends Context.Service<
  MirrorHooks,
  {
    /** Bulk mirror change landed: refresh search index and VCS status. */
    readonly afterMirrorChanged: (input: MirrorChangedInput) => Effect.Effect<void>;
    /** Seed completed: run the project's runOnWorktreeCreate scripts. */
    readonly runSeedScripts: (input: MirrorChangedInput) => Effect.Effect<void>;
  }
>()("t3/mirror/MirrorHooks") {}

export const noopLayer = Layer.succeed(
  MirrorHooks,
  MirrorHooks.of({
    afterMirrorChanged: () => Effect.void,
    runSeedScripts: () => Effect.void,
  }),
);
