import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";

export type BoardThreadSource = Pick<
  EnvironmentThreadShell,
  "id" | "projectId" | "environmentId" | "title" | "updatedAt"
>;

export type BoardProjectSource = Pick<
  EnvironmentProject,
  "id" | "environmentId" | "title" | "workspaceRoot" | "faviconPath"
>;

export interface BoardCard<TThread extends BoardThreadSource, TProject extends BoardProjectSource> {
  readonly thread: TThread;
  readonly project: TProject | null;
  readonly projectKey: string;
  readonly projectTitle: string;
  readonly environmentLabel: string | null;
}

export interface BoardProjectSection<
  TThread extends BoardThreadSource,
  TProject extends BoardProjectSource,
> {
  readonly projectKey: string;
  readonly projectTitle: string;
  readonly cards: ReadonlyArray<BoardCard<TThread, TProject>>;
}

function projectKey(environmentId: EnvironmentId, projectId: string): string {
  return JSON.stringify([environmentId, projectId]);
}

export function buildBoardCards<
  TThread extends BoardThreadSource,
  TProject extends BoardProjectSource,
>(input: {
  readonly threads: ReadonlyArray<TThread>;
  readonly projects: ReadonlyArray<TProject>;
  readonly environmentLabels?: ReadonlyMap<EnvironmentId, string>;
}): ReadonlyArray<BoardCard<TThread, TProject>> {
  const projectsByKey = new Map(
    input.projects.map((project) => [projectKey(project.environmentId, project.id), project]),
  );

  // The route supplies the same active-thread projection as the sidebar,
  // including server capability checks and raised-hand snoozes. Keeping that
  // lifecycle decision at the route boundary prevents this pure card mapper
  // from inventing a second, subtly different definition of “active”.
  return input.threads
    .map((thread) => {
      const key = projectKey(thread.environmentId, thread.projectId);
      const project = projectsByKey.get(key) ?? null;
      return {
        thread,
        project,
        projectKey: key,
        projectTitle: project?.title ?? "Unknown project",
        environmentLabel: input.environmentLabels?.get(thread.environmentId) ?? null,
      };
    })
    .toSorted(
      (left, right) =>
        Date.parse(right.thread.updatedAt) - Date.parse(left.thread.updatedAt) ||
        left.thread.id.localeCompare(right.thread.id),
    );
}

export function groupBoardCardsByProject<
  TThread extends BoardThreadSource,
  TProject extends BoardProjectSource,
>(
  cards: ReadonlyArray<BoardCard<TThread, TProject>>,
): ReadonlyArray<BoardProjectSection<TThread, TProject>> {
  const grouped = new Map<
    string,
    {
      readonly projectKey: string;
      readonly projectTitle: string;
      readonly cards: Array<BoardCard<TThread, TProject>>;
    }
  >();
  for (const card of cards) {
    const existing = grouped.get(card.projectKey);
    if (existing) {
      existing.cards.push(card);
      continue;
    }
    grouped.set(card.projectKey, {
      projectKey: card.projectKey,
      projectTitle: card.projectTitle,
      cards: [card],
    });
  }
  return [...grouped.values()].toSorted(
    (left, right) =>
      left.projectTitle.localeCompare(right.projectTitle, undefined, { sensitivity: "base" }) ||
      left.projectKey.localeCompare(right.projectKey),
  );
}
