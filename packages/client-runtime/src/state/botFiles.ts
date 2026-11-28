import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type * as Persistence from "../platform/persistence.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/** A Bot's instructions and notes (a save refreshes the reads), and starting or creating a Bot. */
export function createBotFilesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const files = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:bot-files:read",
    tag: WS_METHODS.botFilesRead,
  });
  const note = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:bot-note:read",
    tag: WS_METHODS.botNoteRead,
  });
  // One queue per Bot, so a note save and a delete of it cannot race.
  const scheduler = createAtomCommandScheduler();
  const botKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly threadId: string };
  }) => JSON.stringify([environmentId, input.threadId]);
  return {
    files,
    note,
    writePreferences: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bot-files:write",
      tag: WS_METHODS.botFilesWrite,
      scheduler,
      concurrency: { mode: "serial", key: botKey },
      onSettled: ({ environmentId, input }, registry) =>
        Effect.sync(() =>
          registry.refresh(files({ environmentId, input: { threadId: input.threadId } })),
        ),
    }),
    writeNote: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bot-note:write",
      tag: WS_METHODS.botNoteWrite,
      scheduler,
      concurrency: { mode: "serial", key: botKey },
      onSettled: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          registry.refresh(files({ environmentId, input: { threadId: input.threadId } }));
          registry.refresh(
            note({ environmentId, input: { threadId: input.threadId, slug: input.slug } }),
          );
        }),
    }),
    deleteNote: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bot-note:delete",
      tag: WS_METHODS.botNoteDelete,
      scheduler,
      concurrency: { mode: "serial", key: botKey },
      onSettled: ({ environmentId, input }, registry) =>
        Effect.sync(() =>
          registry.refresh(files({ environmentId, input: { threadId: input.threadId } })),
        ),
    }),
    // Launches a thread, so a double click must not start two Bots.
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bot:start",
      tag: WS_METHODS.botStart,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bot:create",
      tag: WS_METHODS.botCreate,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
  };
}

const NOTE_SLUG_MAX = 64;

/** A note slug from its title, made unique against the Bot's existing notes. */
export function noteSlugFromTitle(title: string, taken: ReadonlySet<string>): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+/u, "")
      .slice(0, NOTE_SLUG_MAX)
      .replace(/-+$/u, "") || "note";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, NOTE_SLUG_MAX - suffix.length).replace(/-+$/u, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
