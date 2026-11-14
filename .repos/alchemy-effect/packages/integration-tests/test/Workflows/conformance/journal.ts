import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * What the conformance workflows did, outside the engine: each activity
 * appends an entry to its run's journal, so a case can check an activity ran
 * once however many times its workflow replayed. Each cloud provides it over
 * its own storage.
 */
export class Journal extends Context.Service<
  Journal,
  {
    readonly append: (id: string, entry: string) => Effect.Effect<void, never, RuntimeContext>;
    readonly list: (id: string) => Effect.Effect<ReadonlyArray<string>, never, RuntimeContext>;
  }
>()("WorkflowConformance/Journal") {}
