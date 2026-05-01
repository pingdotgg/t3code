import { WorktreeLocationResolverError } from "@t3tools/contracts";
import { Effect, Context, Layer } from "effect";
import path from "node:path";

export interface ResolveCreateWorktreePathInput {
  readonly projectRoot: string;
  readonly name: string;
}

export interface WorktreeLocationResolverShape {
  readonly resolveCreateWorktreePath: (
    input: ResolveCreateWorktreePathInput,
  ) => Effect.Effect<string, WorktreeLocationResolverError>;
}

export class WorktreeLocationResolver extends Context.Service<
  WorktreeLocationResolver,
  WorktreeLocationResolverShape
>()("t3/project/Services/WorktreeLocationResolver") {
  static readonly layerTest = ({
    resolveCreateWorktreePath = (input) =>
      Effect.succeed(
        path.join(input.projectRoot, ".mock-worktrees", input.name.replace(/\//g, "-")),
      ),
  }: {
    resolveCreateWorktreePath?: WorktreeLocationResolverShape["resolveCreateWorktreePath"];
  } = {}) =>
    Layer.succeed(WorktreeLocationResolver, {
      resolveCreateWorktreePath,
    });
}
