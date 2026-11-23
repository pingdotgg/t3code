import type { VibeAppServerClient } from "@t3tools/vibe-app-server/client";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  EMPTY_TOTALS,
  tokenCount,
  type ProviderUsageReader,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { VibeSettings } from "../settings.ts";
import { withVibeAppServerClient } from "./appServerSupport.ts";

export const readVibeUsage = Effect.fn("VibeUsage.read")(function* (
  client: VibeAppServerClient["Service"],
  sinceMs: number,
) {
  const records: UsageRecord[] = [];
  const sessions = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let partial = false;
  do {
    const page: Effect.Success<ReturnType<typeof client.sessionList>> = yield* client.sessionList({
      cursor,
      limit: 100,
      includeArchived: true,
    });
    const pageRecords = yield* Effect.forEach(
      page.items,
      Effect.fnUntraced(function* (session) {
        const timestampMs = session.updatedAt;
        if (timestampMs === undefined || timestampMs < sinceMs || sessions.has(session.id)) return;
        sessions.add(session.id);
        const usage = session.tokenUsage;
        const input = tokenCount(usage?.inputTokens);
        const cached = Math.min(input, tokenCount(usage?.cachedInputTokens ?? usage?.cachedTokens));
        const output = tokenCount(usage?.outputTokens);
        if (input + output === 0) return;
        // Vibe's list omits model pins. Read only the details of sessions with billable usage.
        const model =
          session.model?.trim() ||
          (yield* client
            .sessionRead({ sessionId: session.id, history: { limit: 1 }, turns: { limit: 1 } })
            .pipe(
              Effect.map(({ state }) => state.session.model?.trim()),
              Effect.orElseSucceed(() => undefined),
            ));
        if (!model) partial = true;
        return {
          provider: "vibe",
          timestampMs,
          model: model || "vibe-unknown",
          ...(model === "mistral-large-4-0-3" ? { rateModel: "mistral/mistral-large-4-0" } : {}),
          sessionId: session.id,
          totals: {
            ...EMPTY_TOTALS,
            uncachedInputTokens: input - cached,
            cachedInputTokens: cached,
            outputTokens: output,
          },
          reportedCostUsd: null,
          speed: "standard",
          dedupeKey: `vibe:${session.id}`,
        } satisfies UsageRecord;
      }),
      { concurrency: 4 },
    );
    records.push(...pageRecords.filter((record) => record !== undefined));
    if (
      page.items.some((session) => session.updatedAt !== undefined && session.updatedAt < sinceMs)
    )
      break;
    cursor = page.nextCursor ?? null;
    if (cursor !== null) {
      if (cursors.has(cursor)) {
        partial = true;
        break;
      }
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return { records, partial };
});

export type VibeUsageEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path;

export const vibeUsageReader: ProviderUsageReader<VibeSettings, VibeUsageEnv> = {
  kind: "scan",
  provider: "vibe",
  scan: Effect.fn("VibeUsage.scan")(function* ({ instances, windowStartMs, retentionCutoffMs }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const cwd = yield* HostProcess.WorkingDirectory;
    const homes = new Map<string, (typeof instances)[number]>();
    for (const instance of instances) {
      const userHome = instance.environment.HOME || instance.environment.USERPROFILE || home;
      const vibeHome = instance.environment.VIBE_HOME?.trim();
      const dir = path.join(
        vibeHome
          ? path.resolve(cwd, expandHomePath(vibeHome, userHome))
          : path.join(userHome, ".vibe"),
        "logs",
        "session",
      );
      const canonical = yield* fileSystem.realPath(dir).pipe(Effect.orElseSucceed(() => dir));
      if (!homes.has(canonical)) homes.set(canonical, instance);
    }

    return yield* Effect.forEach(
      homes,
      ([dir, instance]) =>
        Effect.gen(function* () {
          if (
            !instance.configured &&
            !(yield* fileSystem.exists(dir).pipe(Effect.orElseSucceed(() => false)))
          ) {
            return { dir, files: null };
          }
          return yield* Effect.scoped(
            withVibeAppServerClient(
              { settings: instance.config, environment: instance.environment, cwd },
              (client) => readVibeUsage(client, Math.max(windowStartMs, retentionCutoffMs)),
            ),
          ).pipe(
            Effect.timeout("20 seconds"),
            Effect.map(({ records, partial }) => ({
              dir,
              files: [{ path: path.join(dir, "session-usage"), records }],
              status: partial ? ("partial" as const) : ("ok" as const),
              ...(records.length === 0
                ? {}
                : {
                    message: partial
                      ? "Vibe reports totals per session on the last activity date. Some sessions have incomplete model or usage data."
                      : "Vibe reports totals per session on the last activity date. Sessions that changed models use the last model reported by Vibe.",
                  }),
            })),
            Effect.orElseSucceed(() => ({
              dir,
              status: "failed" as const,
              message: "Vibe session usage could not be read.",
              files: [],
            })),
          );
        }),
      { concurrency: 2 },
    );
  }),
};
