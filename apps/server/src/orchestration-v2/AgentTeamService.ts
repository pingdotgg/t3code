import {
  AgentTeam,
  AgentTeamId,
  type AgentTeamSeatStatus,
  type AgentTeamSeatView,
  type OrchestrationV2AddSpecialistsFromTemplateResult,
  type OrchestrationV2ListOwnedWorkInboxInput,
  type OrchestrationV2ListOwnedWorkInboxResult,
  type OrchestrationV2OwnedWorkInboxEntry,
  type OrchestrationV2ReadAgentTeamInput,
  type OrchestrationV2ReadAgentTeamResult,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ServerSettingsError,
  type ThreadSpecialistKey,
  ownedWorkInboxRelevant,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const LIVE_SHELL_STATUSES = new Set<string>([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
]);

function pendingReviewCount(thread: OrchestrationV2ThreadShell): number {
  return thread.pendingRuntimeRequest?.kind === "work_review" ? 1 : 0;
}

function seatStatus(
  thread: OrchestrationV2ThreadShell | undefined,
  teamArchived: boolean,
): AgentTeamSeatStatus {
  if (teamArchived) return "archived";
  if (thread === undefined || thread.deletedAt !== null) return "archived";
  if (thread.archivedAt !== null) return "archived";
  if ((thread.activityRunStatus ?? null) !== null) return "active";
  if (LIVE_SHELL_STATUSES.has(thread.status)) return "active";
  if (pendingReviewCount(thread) > 0) return "needs_attention";
  if (thread.pendingRuntimeRequest !== null) return "needs_attention";
  if ((thread.openOwnedWorkCount ?? 0) > 0) return "needs_attention";
  return "idle";
}

export class AgentTeamService extends Context.Service<
  AgentTeamService,
  {
    readonly read: (
      input: OrchestrationV2ReadAgentTeamInput,
    ) => Effect.Effect<OrchestrationV2ReadAgentTeamResult, never>;
    readonly listOwnedWorkInbox: (
      input: OrchestrationV2ListOwnedWorkInboxInput,
    ) => Effect.Effect<OrchestrationV2ListOwnedWorkInboxResult, never>;
    readonly recordInstall: (input: {
      readonly projectId: ProjectId;
      readonly result: OrchestrationV2AddSpecialistsFromTemplateResult;
    }) => Effect.Effect<void, ServerSettingsError>;
  }
>()("t3/orchestration-v2/AgentTeamService") {}

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const random = yield* SecureRandom.SecureRandom;

  const specialistThreads = (projectId: ProjectId) =>
    threads.getShellSnapshot({ projectId }).pipe(
      Effect.map((snapshot) => {
        const byKey = new Map<ThreadSpecialistKey, OrchestrationV2ThreadShell>();
        for (const thread of [...snapshot.threads, ...snapshot.archivedThreads]) {
          if (thread.deletedAt !== null) continue;
          const key = thread.specialist?.key;
          if (key === undefined) continue;
          if (!byKey.has(key)) byKey.set(key, thread);
        }
        return byKey;
      }),
    );

  const readImpl = Effect.fn("AgentTeamService.read")(function* (
    input: OrchestrationV2ReadAgentTeamInput,
  ) {
    const settings = yield* serverSettings.getSettings;
    const team = settings.agentTeams[input.projectId] ?? null;
    if (team === null) {
      return { team: null, seats: [] } satisfies OrchestrationV2ReadAgentTeamResult;
    }

    const boundThreads = yield* specialistThreads(input.projectId);
    const teamArchived = team.archivedAt !== null;
    const seats = team.seatKeys.flatMap((key) => {
      const thread = boundThreads.get(key);
      if (thread === undefined) return [];
      return [
        {
          key,
          label: thread.specialist?.label ?? key,
          threadId: thread.id,
          status: seatStatus(thread, teamArchived),
          openOwnedWorkCount: thread.openOwnedWorkCount ?? 0,
          pendingReviewCount: pendingReviewCount(thread),
        },
      ] satisfies ReadonlyArray<AgentTeamSeatView>;
    });

    return { team, seats } satisfies OrchestrationV2ReadAgentTeamResult;
  });
  const read = (input: OrchestrationV2ReadAgentTeamInput) => readImpl(input).pipe(Effect.orDie);

  const listOwnedWorkInboxImpl = Effect.fn("AgentTeamService.listOwnedWorkInbox")(function* (
    input: OrchestrationV2ListOwnedWorkInboxInput,
  ) {
    const snapshot = yield* threads.getShellSnapshot({ projectId: input.projectId });
    const homes = [...snapshot.threads, ...snapshot.archivedThreads].filter(
      (thread) =>
        thread.deletedAt === null &&
        thread.id !== input.actorThreadId &&
        (thread.openOwnedWorkCount ?? 0) > 0,
    );

    const entries: OrchestrationV2OwnedWorkInboxEntry[] = [];
    for (const home of homes) {
      const projection = yield* threads.getThreadProjection(home.id);
      for (const item of projection.thread.ownedWorkItems ?? []) {
        if (!ownedWorkInboxRelevant(item, input.actorThreadId)) continue;
        const homeLabel =
          home.specialist?.label ?? (home.title.trim() === "" ? undefined : home.title);
        entries.push({
          homeThreadId: home.id,
          ...(home.specialist?.key === undefined ? {} : { homeSpecialistKey: home.specialist.key }),
          ...(homeLabel === undefined ? {} : { homeLabel }),
          item,
        });
      }
    }

    entries.sort((left, right) => right.item.updatedAt.localeCompare(left.item.updatedAt));
    return { entries } satisfies OrchestrationV2ListOwnedWorkInboxResult;
  });
  const listOwnedWorkInbox = (input: OrchestrationV2ListOwnedWorkInboxInput) =>
    listOwnedWorkInboxImpl(input).pipe(Effect.orDie);

  const recordInstall = Effect.fn("AgentTeamService.recordInstall")(function* (input: {
    readonly projectId: ProjectId;
    readonly result: OrchestrationV2AddSpecialistsFromTemplateResult;
  }) {
    const settings = yield* serverSettings.getSettings;
    const now = DateTime.formatIso(yield* DateTime.now);
    const seatKeys = input.result.specialists.map((entry) => entry.specialist.key);
    if (seatKeys.length === 0) return;
    const nonEmptySeatKeys = seatKeys as unknown as readonly [
      ThreadSpecialistKey,
      ...ThreadSpecialistKey[],
    ];
    const leadKey = nonEmptySeatKeys[0];

    const existing = settings.agentTeams[input.projectId];
    const id = existing?.id ?? AgentTeamId.make(`agent-team:${yield* random.uuidV4()}`);

    const team = {
      id,
      projectId: input.projectId,
      name: input.result.name,
      installedFrom: input.result.source,
      seatKeys: nonEmptySeatKeys,
      leadKey,
      archivedAt: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    } satisfies AgentTeam;

    yield* serverSettings.updateSettings({
      agentTeams: { ...settings.agentTeams, [input.projectId]: team },
    });
  });

  return AgentTeamService.of({ read, listOwnedWorkInbox, recordInstall });
});

export const layer: Layer.Layer<
  AgentTeamService,
  never,
  | ServerSettings.ServerSettingsService
  | ThreadManagement.ThreadManagementService
  | SecureRandom.SecureRandom
> = Layer.effect(AgentTeamService, make);
