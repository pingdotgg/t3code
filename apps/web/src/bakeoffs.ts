import {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ThreadId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Schema from "effect/Schema";

import { ensureEnvironmentApi } from "./environmentApi";
import { useLocalStorage } from "./hooks/useLocalStorage";
import { newCommandId, newMessageId, newThreadId, randomHex, randomUUID } from "./lib/utils";
import type { AgentRun } from "./runs";
import type { Project } from "./types";

export const BAKEOFFS_STORAGE_KEY = "t3code:bakeoffs:v1";

export const BakeoffContestant = Schema.Struct({
  threadId: ThreadId,
  label: Schema.String,
  modelSelection: ModelSelection,
  launchError: Schema.optionalKey(Schema.String),
});
export type BakeoffContestant = typeof BakeoffContestant.Type;

export const Bakeoff = Schema.Struct({
  id: Schema.String,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  title: Schema.String,
  prompt: Schema.String,
  baseBranch: Schema.String,
  createdAt: Schema.String,
  contestants: Schema.Array(BakeoffContestant),
  winnerThreadId: Schema.NullOr(ThreadId),
});
export type Bakeoff = typeof Bakeoff.Type;

export const Bakeoffs = Schema.Array(Bakeoff);

export interface BakeoffView {
  bakeoff: Bakeoff;
  contestants: ReadonlyArray<{
    contestant: BakeoffContestant;
    run: AgentRun | null;
  }>;
}

export function useBakeoffs() {
  return useLocalStorage(BAKEOFFS_STORAGE_KEY, [], Bakeoffs);
}

export function buildBakeoffViews(
  bakeoffs: ReadonlyArray<Bakeoff>,
  runs: ReadonlyArray<AgentRun>,
): BakeoffView[] {
  const runsByThreadKey = new Map(
    runs.map((run) => [`${run.thread.environmentId}:${run.thread.id}`, run]),
  );
  return bakeoffs
    .map((bakeoff) => ({
      bakeoff,
      contestants: bakeoff.contestants.map((contestant) => ({
        contestant,
        run: runsByThreadKey.get(`${bakeoff.environmentId}:${contestant.threadId}`) ?? null,
      })),
    }))
    .toSorted((left, right) => right.bakeoff.createdAt.localeCompare(left.bakeoff.createdAt));
}

export function bakeoffThreadKeys(bakeoffs: ReadonlyArray<Bakeoff>): ReadonlySet<string> {
  return new Set(
    bakeoffs.flatMap((bakeoff) =>
      bakeoff.contestants.map((contestant) => `${bakeoff.environmentId}:${contestant.threadId}`),
    ),
  );
}

export async function launchBakeoff(input: {
  project: Project;
  title: string;
  prompt: string;
  contestants: ReadonlyArray<Pick<BakeoffContestant, "label" | "modelSelection">>;
  runtimeMode?: RuntimeMode;
  interactionMode?: ProviderInteractionMode;
}): Promise<Bakeoff> {
  const api = ensureEnvironmentApi(input.project.environmentId);
  const refs = await api.vcs.listRefs({ cwd: input.project.cwd, limit: 100 });
  if (!refs.isRepo) {
    throw new Error(
      "Bakeoffs require a Git repository so every contestant can use an isolated worktree.",
    );
  }
  const baseBranch =
    refs.refs.find((ref) => ref.current)?.name ?? refs.refs.find((ref) => ref.isDefault)?.name;
  if (!baseBranch) {
    throw new Error("Could not resolve a base branch for the bakeoff.");
  }

  const createdAt = new Date().toISOString();
  const title = input.title.trim() || input.prompt.trim().split(/\s+/u).slice(0, 8).join(" ");
  const contestants: BakeoffContestant[] = input.contestants.map((contestant) => ({
    threadId: newThreadId(),
    label: contestant.label,
    modelSelection: contestant.modelSelection,
  }));
  const runtimeMode = input.runtimeMode ?? "full-access";
  const interactionMode = input.interactionMode ?? "default";

  const results = await Promise.allSettled(
    contestants.map((contestant) =>
      api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: contestant.threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: input.prompt,
          attachments: [],
        },
        modelSelection: contestant.modelSelection,
        titleSeed: `${title} · ${contestant.label}`,
        runtimeMode,
        interactionMode,
        bootstrap: {
          createThread: {
            projectId: input.project.id,
            title: `${title} · ${contestant.label}`,
            modelSelection: contestant.modelSelection,
            runtimeMode,
            interactionMode,
            branch: null,
            worktreePath: null,
            createdAt,
          },
          prepareWorktree: {
            projectCwd: input.project.cwd,
            baseBranch,
            branch: buildTemporaryWorktreeBranchName(randomHex),
          },
          runSetupScript: true,
        },
        createdAt,
      }),
    ),
  );

  return {
    id: randomUUID(),
    environmentId: input.project.environmentId,
    projectId: input.project.id,
    title,
    prompt: input.prompt,
    baseBranch,
    createdAt,
    contestants: contestants.map((contestant, index) => {
      const result = results[index];
      return result?.status === "rejected"
        ? {
            ...contestant,
            launchError:
              result.reason instanceof Error
                ? result.reason.message
                : "Contestant failed to launch.",
          }
        : contestant;
    }),
    winnerThreadId: null,
  };
}
