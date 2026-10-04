import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationLayerLive } from "../runtimeLayer.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

function git(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/**
 * Regression test for the review-workflow outage where every
 * `thread.create` carrying `sourceWorktreePath` failed with
 * "Checkpoint snapshot service is unavailable; refusing a HEAD-only fork."
 *
 * The engine had looked the store up with `Effect.serviceOption`, which
 * declares no layer requirement, so no composition ever provided it and the
 * lookup silently resolved to `None` in production. The store is now a
 * required dependency provided inside `OrchestrationLayerLive`, and this
 * test dispatches a dirty-source fork through that exact production layer to
 * prove the wiring holds end to end.
 */
describe("orchestration layer snapshot fork wiring", () => {
  it("forks a dirty source worktree through the production layer", async () => {
    const root = mkdtempSync(join(tmpdir(), "t3-engine-snapshot-fork-"));
    try {
      const source = join(root, "source");
      mkdirSync(source, { recursive: true });
      git(source, ["init"]);
      git(source, ["config", "user.name", "Fork Test"]);
      git(source, ["config", "user.email", "fork@example.test"]);
      writeFileSync(join(source, "tracked.txt"), "base\n");
      execFileSync("git", ["-C", source, "add", "."]);
      git(source, ["commit", "-m", "base"]);
      const head = git(source, ["rev-parse", "HEAD"]);
      writeFileSync(join(source, "tracked.txt"), "dirty\n");
      writeFileSync(join(source, "untracked.txt"), "untracked\n");

      const layer = OrchestrationLayerLive.pipe(
        Layer.provideMerge(RepositoryIdentityResolverLive),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-engine-snapshot-fork-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      );
      const runtime = ManagedRuntime.make(layer);
      try {
        const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
        const projectId = ProjectId.make("fork-wiring-project");
        const threadId = ThreadId.make("fork-wiring-thread");
        const createdAt = new Date().toISOString();
        await runtime.runPromise(
          engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("fork-wiring-project-create"),
            projectId,
            title: "Fork wiring",
            workspaceRoot: source,
            createdAt,
          }),
        );
        await runtime.runPromise(
          engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("fork-wiring-thread-create"),
            threadId,
            projectId,
            title: "Fork child",
            modelSelection: { instanceId: ProviderInstanceId.make("copilot"), model: "test" },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            sourceWorktreePath: source,
            createdAt,
          }),
        );
        const thread = (await runtime.runPromise(engine.getReadModel())).threads.find(
          (entry) => entry.id === threadId,
        );
        const childPath = thread?.worktreePath;
        expect(childPath).toBeTruthy();
        expect(childPath).not.toBe(source);
        expect(git(childPath!, ["rev-parse", "HEAD^"])).toBe(head);
        expect(git(childPath!, ["show", "HEAD:tracked.txt"])).toBe("dirty");
        expect(git(childPath!, ["show", "HEAD:untracked.txt"])).toBe("untracked");
        expect(git(source, ["rev-parse", "HEAD"])).toBe(head);
      } finally {
        await runtime.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
