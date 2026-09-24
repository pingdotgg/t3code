import * as railway from "@distilled.cloud/railway";
import * as Effect from "effect/Effect";
import { OwnedBySomeoneElse, Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { waitUntilDeleted } from "./GraphQL.ts";
import { createRailwayName, matchesAlchemyPhysicalName } from "./Metadata.ts";
import { ownedProjects, projectEnvironmentIds } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import type { SandboxIdentity } from "./Sandbox.ts";

const selection = {
  id: true,
  key: true,
  environmentId: true,
  createdAt: true,
} as const satisfies railway.Selection<"SandboxCheckpoint">;

type CloudCheckpoint = railway.Result<"SandboxCheckpoint!", typeof selection>;

export interface SandboxCheckpointProps {
  /**
   * Running sandbox to capture. Accepts a Railway.Sandbox or a
   * `{ sandboxId, environmentId }` identity. Changing either ID replaces
   * the checkpoint; the old checkpoint is deleted first when reusing its name.
   */
  sandbox: SandboxIdentity;
  /**
   * Checkpoint name, unique within the environment. Defaults to an
   * instance-specific physical name. Changing it renames the existing
   * snapshot without capturing the source again. Removing it restores
   * the generated name.
   */
  name?: string;
}

export type SandboxCheckpoint = Resource<
  "Railway.SandboxCheckpoint",
  SandboxCheckpointProps,
  {
    /** Railway checkpoint ID. May change when the checkpoint is renamed. */
    sandboxCheckpointId: string;
    /** Environment that stores the snapshot. */
    environmentId: string;
    /** Source sandbox ID, or undefined for checkpoints discovered by listing. */
    sandboxId: string | undefined;
    /** Checkpoint name, usable as Sandbox's `template.name`. */
    name: string;
    /** Railway checkpoint key, identical to the checkpoint name. */
    key: string;
    /** RFC3339 capture timestamp; also distinguishes recaptures under the same ID. */
    createdAt: string;
  },
  never,
  Providers
>;

/**
 * A managed, named snapshot of a running Railway sandbox's disk. Capture is
 * synchronous: the checkpoint is bootable when deployment completes. Files
 * survive restoration, but running processes and memory do not.
 *
 * The snapshot is captured once, not on every deploy. Changing the source
 * replaces it; changing the name renames it. Existing explicit names require
 * adoption. Persisted ID and capture time protect against deleting or
 * overwriting a different capture that later occupies the same name.
 * Interrupted renames are recovered from the persisted attempted name and
 * original capture time. Recovery never searches arbitrary names by timestamp;
 * losing either piece of evidence requires explicit operator recovery.
 * Railway exposes no conditional mutations, so concurrent external writers
 * must not mutate the same checkpoint while Alchemy is reconciling it.
 *
 * ### Capture a sandbox
 * **Example:** Managed snapshot
 * ```typescript
 * const box = yield* Railway.Sandbox("Box", { environment: site });
 * const checkpoint = yield* Railway.SandboxCheckpoint("Prepared", {
 *   sandbox: box,
 * });
 * ```
 *
 * ### Restore a checkpoint
 * **Example:** Boot an independent sandbox
 * ```typescript
 * const restored = yield* Railway.Sandbox("Restored", {
 *   environment: site,
 *   template: { name: checkpoint.key },
 * });
 * ```
 *
 * ### Adopt an existing checkpoint
 * **Example:** Manage a named snapshot without recapturing it
 * ```typescript
 * const checkpoint = yield* Railway.SandboxCheckpoint("Prepared", {
 *   sandbox: box,
 *   name: "after-deps",
 * }).pipe(Alchemy.adopt(true));
 * ```
 *
 * @see https://docs.railway.com/sandboxes#checkpoints
 *
 * @resource
 * @product Railway
 */
export const SandboxCheckpoint = Resource<SandboxCheckpoint>(
  "Railway.SandboxCheckpoint",
);

const listCheckpoints = (environmentId: string) =>
  railway
    .sandboxCheckpoints({ environmentId }, selection)
    .pipe(railway.catchTags("RailwayNotFound", () => Effect.succeed([])));

const toAttrs = (
  checkpoint: CloudCheckpoint,
  sandboxId?: string,
): SandboxCheckpoint["Attributes"] => ({
  sandboxCheckpointId: checkpoint.id,
  environmentId: checkpoint.environmentId,
  sandboxId,
  name: checkpoint.key,
  key: checkpoint.key,
  createdAt: checkpoint.createdAt,
});

const sameCapture = (
  checkpoint: CloudCheckpoint,
  output: SandboxCheckpoint["Attributes"],
) =>
  checkpoint.id === output.sandboxCheckpointId &&
  checkpoint.createdAt === output.createdAt;

const findRecordedCheckpoint = Effect.fn(function* (
  id: string,
  props: SandboxCheckpointProps | undefined,
  output: SandboxCheckpoint["Attributes"],
  items: readonly CloudCheckpoint[],
) {
  const byId = items.find((item) => item.id === output.sandboxCheckpointId);
  if (byId !== undefined) return byId;
  if (
    props?.sandbox?.environmentId !== output.environmentId ||
    props?.sandbox?.sandboxId !== output.sandboxId
  ) {
    return undefined;
  }
  // Updating rows retain attempted props alongside the pre-rename attributes.
  const attemptedName = props?.name ?? (yield* createRailwayName(id));
  return items.find((item) => item.key === attemptedName);
});

const conflict = (id: string, name: string) =>
  new OwnedBySomeoneElse({
    message: `Sandbox checkpoint ${name} belongs to another capture; adopt it explicitly or choose a different name`,
    resourceType: "Railway.SandboxCheckpoint",
    logicalId: id,
    physicalName: name,
  });

export const SandboxCheckpointProvider = () =>
  Provider.succeed(SandboxCheckpoint, {
    stables: ["environmentId", "sandboxId"],
    nuke: { dependsOn: ["Railway.Project", "Railway.Environment"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return;
      if (
        news.sandbox.sandboxId !== output.sandboxId ||
        news.sandbox.environmentId !== output.environmentId
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            news.sandbox.environmentId === output.environmentId &&
            news.name === output.name,
        };
      }
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const environmentId =
        output?.environmentId ?? olds?.sandbox?.environmentId;
      if (environmentId === undefined) return;
      const items = yield* listCheckpoints(environmentId);
      if (output !== undefined) {
        const found = yield* findRecordedCheckpoint(id, olds, output, items);
        if (found === undefined) return;
        if (found.createdAt !== output.createdAt) {
          return yield* conflict(id, found.key);
        }
        return toAttrs(found, output.sandboxId);
      }
      const generatedName = yield* createRailwayName(id);
      const name = olds?.name ?? generatedName;
      const found = items.find((item) => item.key === name);
      if (found === undefined) return;
      const attrs = toAttrs(found, olds?.sandbox?.sandboxId);
      return found.key === generatedName ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const projects = yield* ownedProjects();
      const rows = yield* Effect.forEach(projects, (project) =>
        Effect.gen(function* () {
          const environments = yield* projectEnvironmentIds(project);
          return (yield* Effect.forEach(environments, (environmentId) =>
            listCheckpoints(environmentId).pipe(
              Effect.map((items) =>
                items
                  .filter((item) => matchesAlchemyPhysicalName(item.key))
                  .map((item) => toAttrs(item)),
              ),
            ),
          )).flat();
        }),
      );
      return rows.flat();
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { sandboxId, environmentId } = news.sandbox;
      const generatedName = yield* createRailwayName(id);
      const name = news.name ?? generatedName;
      const items = yield* listCheckpoints(environmentId);
      let current = output
        ? items.find((item) => item.id === output.sandboxCheckpointId)
        : items.find((item) => item.key === name);
      if (
        current !== undefined &&
        (output ? !sameCapture(current, output) : current.key !== generatedName)
      ) {
        return yield* conflict(id, current.key);
      }
      const target = items.find((item) => item.key === name);
      if (target !== undefined && target.id !== current?.id) {
        // Rename can succeed before state persistence; capture time survives it.
        if (
          output !== undefined &&
          current === undefined &&
          target.createdAt === output.createdAt
        ) {
          current = target;
        } else {
          return yield* conflict(id, name);
        }
      }
      if (current === undefined) {
        current = yield* railway.createSandboxCheckpoint(
          { environmentId, sandboxId, name },
          selection,
        );
      }
      if (current.key !== name) {
        current = yield* railway.renameSandboxCheckpoint(
          { environmentId, id: current.id, name },
          selection,
        );
      }
      return toAttrs(current, sandboxId);
    }),

    delete: Effect.fn(function* ({ id, olds, output }) {
      const items = yield* listCheckpoints(output.environmentId);
      const current = yield* findRecordedCheckpoint(id, olds, output, items);
      if (current === undefined || current.createdAt !== output.createdAt)
        return;
      yield* railway
        .deleteSandboxCheckpoint({
          environmentId: output.environmentId,
          id: current.id,
        })
        .pipe(railway.catchTags("RailwayNotFound", () => Effect.void));
      yield* waitUntilDeleted(
        "SandboxCheckpoint",
        current.id,
        listCheckpoints(output.environmentId).pipe(
          Effect.map(
            (rows) =>
              !rows.some(
                (item) =>
                  item.id === current.id &&
                  item.createdAt === current.createdAt,
              ),
          ),
        ),
        10,
      );
    }),
  });
