import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";

export interface SidebarPreviewFolder {
  readonly key: string;
  readonly name: string;
  /** The user's own project, or null for a sample folder. */
  readonly project: Pick<
    EnvironmentProject,
    "environmentId" | "workspaceRoot" | "title" | "faviconPath" | "projectIcon"
  > | null;
  /** One thread per folder fits the preview and still shows the grouping. */
  readonly thread: { readonly title: string; readonly updatedAt: string };
}

const HOUR = 60 * 60_000;
const SAMPLE_FOLDERS = [
  { name: "website", title: "Fix the signup form", age: 2 * HOUR },
  { name: "api", title: "Rate limit the upload route", age: 5 * HOUR },
];

const MAX_FOLDERS = 2;

/**
 * What the Boring sidebar would show first: the newest open thread of the user's two most
 * recent projects. Grouping needs two projects to show, so anyone with fewer sees sample folders.
 */
export function sidebarPreviewFolders(
  projects: ReadonlyArray<EnvironmentProject>,
  shells: ReadonlyArray<
    Pick<
      EnvironmentThreadShell,
      | "environmentId"
      | "projectId"
      | "title"
      | "updatedAt"
      | "archivedAt"
      | "deletedAt"
      | "settledAt"
      | "lineage"
    >
  >,
  now: number,
): ReadonlyArray<SidebarPreviewFolder> {
  const projectByKey = new Map(
    projects
      .filter((project) => project.isScratch !== true)
      .map((project) => [`${project.environmentId}\u0000${project.id}`, project]),
  );
  const recent = shells
    .filter(
      (shell) =>
        shell.archivedAt === null &&
        shell.deletedAt === null &&
        shell.settledAt === null &&
        shell.lineage.parentThreadId === null,
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const folders = new Map<string, SidebarPreviewFolder>();
  for (const { environmentId, projectId, title, updatedAt } of recent) {
    const key = `${environmentId}\u0000${projectId}`;
    const project = projectByKey.get(key);
    if (project === undefined || folders.has(key)) continue;
    folders.set(key, { key, name: project.title, project, thread: { title, updatedAt } });
    if (folders.size === MAX_FOLDERS) return [...folders.values()];
  }
  return SAMPLE_FOLDERS.map(({ name, title, age }) => ({
    key: name,
    name,
    project: null,
    thread: { title, updatedAt: new Date(now - age).toISOString() },
  }));
}
