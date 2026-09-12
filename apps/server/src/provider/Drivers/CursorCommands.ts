import type { ServerProvider, ServerProviderSlashCommand } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as AcpSchema from "effect-acp/schema";

import { discoverCursorSkills } from "./CursorSkills.ts";

type WorkspaceSnapshot = NonNullable<ServerProvider["workspaceSnapshots"]>[number];
const MAX_WORKSPACE_SNAPSHOTS = 16;

export const makeCursorCommandCatalog = Effect.fn("makeCursorCommandCatalog")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaces = yield* SubscriptionRef.make<ReadonlyArray<WorkspaceSnapshot>>([]);

  const withCommands = Effect.fn("CursorCommandCatalog.withCommands")(function* (
    snapshot: ServerProvider,
  ) {
    const current = yield* SubscriptionRef.get(workspaces);
    if (current.length === 0) return snapshot;
    return {
      ...snapshot,
      workspaceSnapshots: current.map((workspace) => ({
        ...workspace,
        slashCommands: [
          ...snapshot.slashCommands,
          ...workspace.slashCommands.filter(
            (command) => !snapshot.slashCommands.some((builtin) => builtin.name === command.name),
          ),
        ],
      })),
    } satisfies ServerProvider;
  });

  const onAvailableCommands = Effect.fn("CursorCommandCatalog.onAvailableCommands")(function* (
    cwd: string,
    commands: ReadonlyArray<AcpSchema.AvailableCommand>,
  ) {
    const seen = new Set<string>();
    const slashCommands = commands.flatMap((command): ServerProviderSlashCommand[] => {
      const name = command.name.trim();
      if (!name || seen.has(name)) return [];
      seen.add(name);
      const description = command.description.trim();
      const hint = command.input?.hint.trim();
      return [
        { name, ...(description ? { description } : {}), ...(hint ? { input: { hint } } : {}) },
      ];
    });
    const skills = yield* discoverCursorSkills(cwd, environment).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(workspaces, (current) =>
      [
        ...current.filter((workspace) => workspace.cwd !== cwd),
        { cwd, checkedAt, slashCommands, skills },
      ].slice(-MAX_WORKSPACE_SNAPSHOTS),
    );
  });

  return {
    onAvailableCommands,
    recordSkills: Effect.fn("CursorCommandCatalog.recordSkills")(function* (
      cwd: string,
      skills: ServerProvider["skills"],
    ) {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      yield* SubscriptionRef.update(workspaces, (current) =>
        [
          ...current.filter((workspace) => workspace.cwd !== cwd),
          {
            cwd,
            checkedAt,
            skills,
            slashCommands: current.find((workspace) => workspace.cwd === cwd)?.slashCommands ?? [],
          },
        ].slice(-MAX_WORKSPACE_SNAPSHOTS),
      );
    }),
    withCommands,
    streamChanges: SubscriptionRef.changes(workspaces),
  };
});
