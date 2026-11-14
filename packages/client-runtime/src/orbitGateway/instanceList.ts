import type {
  OrbitGatewayClient,
  OrbitGatewayEnvironment,
  OrbitGatewayProjectListing,
} from "./client.ts";
import type { OrbitInstanceGitState } from "./instanceGit.ts";

/**
 * Conn: the Orbit panel's Instances list, shared by desktop and mobile. Pages read only
 * `listOrbitInstances` rows. Today they come from the Gateway's environments joined with its
 * Projects; Orbit's coming `GET /api/v1/conn/instances` sends the same fields flat, so only
 * `listOrbitInstances` changes when it lands.
 */

export interface OrbitInstanceListRow {
  readonly id: number;
  readonly name: string;
  readonly projectId: number;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly nodeName: string | null;
  /** The host of `instanceUrl`, such as `pricing-page.nckrtl.test`. */
  readonly domain: string | null;
  readonly instanceUrl: string | null;
  readonly powerState: "running" | "stopped" | null;
  readonly status: "registered" | "session_expired";
  /** The Instance's T3 server; null when it has none yet. */
  readonly environmentId: string | null;
  readonly branch: string | null;
  /** Absent until the list reads Orbit's `?include=git` (`parseOrbitInstanceGit`). */
  readonly git?: OrbitInstanceGitState;
}

const DEFAULT_INSTANCE_NAME = "default";

function hostOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * The Instances in the Gateway's environment list, named from its Projects: one row per
 * Instance (a registered record beats an expired one), default Instances and host servers never.
 */
function orbitInstanceRowsFromEnvironments(
  environments: ReadonlyArray<OrbitGatewayEnvironment>,
  projects: ReadonlyArray<Pick<OrbitGatewayProjectListing, "id" | "slug" | "name" | "nodeName">>,
): OrbitInstanceListRow[] {
  const byInstance = new Map<number, OrbitGatewayEnvironment & { readonly projectId: number }>();
  for (const environment of environments) {
    const { instanceId, projectId } = environment;
    if (instanceId === null || projectId === null) continue;
    if (environment.instanceName === DEFAULT_INSTANCE_NAME) continue;
    const seen = byInstance.get(instanceId);
    if (
      seen === undefined ||
      (seen.status !== "registered" && environment.status === "registered")
    ) {
      byInstance.set(instanceId, { ...environment, projectId });
    }
  }
  const projectById = new Map(projects.map((project) => [project.id, project]));
  return [...byInstance.entries()].map(([id, environment]) => {
    const project = projectById.get(environment.projectId);
    const slug = project?.slug ?? environment.projectSlug ?? String(environment.projectId);
    return {
      id,
      name: environment.instanceName ?? environment.label,
      projectId: environment.projectId,
      projectSlug: slug,
      projectName: project?.name ?? environment.projectName ?? slug,
      nodeName: environment.nodeName ?? project?.nodeName ?? null,
      domain: hostOf(environment.instanceUrl),
      instanceUrl: environment.instanceUrl,
      powerState: environment.powerState,
      status: environment.status,
      environmentId: environment.environmentId,
      branch: null,
    };
  });
}

/** Every Instance this device can reach. Fails like any Gateway call. */
export async function listOrbitInstances(
  client: Pick<OrbitGatewayClient, "environments" | "projects">,
): Promise<OrbitInstanceListRow[]> {
  const [environments, projects] = await Promise.all([
    client.environments(),
    client.projects({ includeUnavailable: true }),
  ]);
  return orbitInstanceRowsFromEnvironments(environments, projects);
}

export type OrbitInstanceState = "running" | "stopped" | "expired" | "no-server";

const ORBIT_INSTANCE_STOPPED_TEXT = "Orbit cannot start a stopped Instance yet";
const ORBIT_INSTANCE_EXPIRED_TEXT = "Must register with Orbit again";
const ORBIT_INSTANCE_NO_SERVER_TEXT = "No agent server";

/** The row's state dot and, when a thread cannot start in it, why. */
export function orbitInstanceAvailability(
  row: OrbitInstanceListRow,
  /** Conn: false on an older Gateway without the wake route; an asleep row then blocks a start. */
  canWake = true,
): {
  readonly state: OrbitInstanceState;
  readonly label: string | null;
  readonly blockedReason: string | null;
} {
  if (row.status === "session_expired") {
    return {
      state: "expired",
      label: ORBIT_INSTANCE_EXPIRED_TEXT,
      blockedReason: ORBIT_INSTANCE_EXPIRED_TEXT,
    };
  }
  if (row.environmentId === null) {
    return {
      state: "no-server",
      label: ORBIT_INSTANCE_NO_SERVER_TEXT,
      blockedReason: ORBIT_INSTANCE_NO_SERVER_TEXT,
    };
  }
  if (row.powerState === "stopped") {
    return {
      state: "stopped",
      label: "Stopped",
      blockedReason: canWake ? null : ORBIT_INSTANCE_STOPPED_TEXT,
    };
  }
  return { state: "running", label: null, blockedReason: null };
}

/** A local thread, as the client's thread list knows it. */
export interface OrbitInstanceThreadInput {
  readonly environmentId: string;
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly working: boolean;
}

export interface OrbitInstanceThread {
  readonly id: string;
  readonly environmentId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly working: boolean;
}

export interface OrbitInstanceWithThreads extends OrbitInstanceListRow {
  /** Newest first; archived threads are left out. */
  readonly threads: ReadonlyArray<OrbitInstanceThread>;
  readonly workingCount: number;
  readonly lastUsedAt: string | null;
}

/**
 * Joins each row with this device's threads in its environment. Running Instances come first,
 * then by last use, then by name.
 */
export function joinOrbitInstanceThreads(
  rows: ReadonlyArray<OrbitInstanceListRow>,
  threads: ReadonlyArray<OrbitInstanceThreadInput>,
): OrbitInstanceWithThreads[] {
  const byEnvironment = new Map<string, OrbitInstanceThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const list = byEnvironment.get(thread.environmentId) ?? [];
    list.push({
      id: thread.id,
      environmentId: thread.environmentId,
      title: thread.title,
      updatedAt: thread.updatedAt,
      working: thread.working,
    });
    byEnvironment.set(thread.environmentId, list);
  }
  const joined = rows.map((row): OrbitInstanceWithThreads => {
    const own = row.environmentId === null ? [] : (byEnvironment.get(row.environmentId) ?? []);
    const sorted = [...own].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return {
      ...row,
      threads: sorted,
      workingCount: sorted.filter((thread) => thread.working).length,
      // An index row without a time (C3) is no last use.
      lastUsedAt: sorted.find((thread) => thread.updatedAt !== "")?.updatedAt ?? null,
    };
  });
  const rank = (row: OrbitInstanceListRow) =>
    orbitInstanceAvailability(row).state === "running" ? 0 : 1;
  return [...joined].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      (right.lastUsedAt ?? "").localeCompare(left.lastUsedAt ?? "") ||
      left.name.localeCompare(right.name),
  );
}

export interface OrbitInstanceProjectOption {
  readonly projectId: number;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly count: number;
}

/** The Project filter's entries after "All projects": only Projects with a listed Instance. */
export function orbitInstanceProjectOptions(
  rows: ReadonlyArray<OrbitInstanceListRow>,
): OrbitInstanceProjectOption[] {
  const byProject = new Map<number, OrbitInstanceProjectOption>();
  for (const row of rows) {
    const seen = byProject.get(row.projectId);
    byProject.set(row.projectId, {
      projectId: row.projectId,
      projectSlug: row.projectSlug,
      projectName: row.projectName,
      count: (seen?.count ?? 0) + 1,
    });
  }
  return [...byProject.values()].sort(
    (left, right) =>
      left.projectName.localeCompare(right.projectName) || left.projectId - right.projectId,
  );
}

/**
 * The rows a search and the Project filter keep. The search matches the Instance name, Project
 * name, Node or domain, ignoring case; a null `projectId` keeps every Project.
 */
export function filterOrbitInstances<T extends OrbitInstanceListRow>(
  rows: ReadonlyArray<T>,
  filter: { readonly query: string; readonly projectId: number | null },
): T[] {
  const needle = filter.query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (filter.projectId === null || row.projectId === filter.projectId) &&
      (needle === "" ||
        [row.name, row.projectName, row.projectSlug, row.nodeName, row.domain].some((text) =>
          text?.toLowerCase().includes(needle),
        )),
  );
}

export interface OrbitInstanceGroup<T extends OrbitInstanceListRow> {
  readonly projectId: number;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly rows: ReadonlyArray<T>;
}

/** Rows by Project, Projects by name; each group keeps the rows' order. */
export function groupOrbitInstances<T extends OrbitInstanceListRow>(
  rows: ReadonlyArray<T>,
): OrbitInstanceGroup<T>[] {
  const groups = new Map<
    number,
    { projectId: number; projectSlug: string; projectName: string; rows: T[] }
  >();
  for (const row of rows) {
    const group = groups.get(row.projectId);
    if (group) group.rows.push(row);
    else {
      groups.set(row.projectId, {
        projectId: row.projectId,
        projectSlug: row.projectSlug,
        projectName: row.projectName,
        rows: [row],
      });
    }
  }
  return [...groups.values()].sort(
    (left, right) =>
      left.projectName.localeCompare(right.projectName) || left.projectId - right.projectId,
  );
}
