import {
  ORBIT_NAME_DOMAIN_INVALID_TEXT,
  type OrbitGatewayEnvironment,
  type OrbitGatewayInstanceNameCheck,
} from "@t3tools/client-runtime/orbit-gateway";

/**
 * Conn: the logic of the palette's Instance step (DESIGN.md "Instance step"): the name rule, the
 * live name check's states, the name a search fills in, and the "Existing instances" rows.
 */

export const ORBIT_INSTANCE_NAME_MAX_LENGTH = 63;
const ORBIT_DEFAULT_INSTANCE_NAME = "default";
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const ORBIT_NAME_FORMAT_ERROR = "Use letters, numbers and single dashes.";
export const ORBIT_NAME_HINT = "Becomes the branch.";
export const ORBIT_NAME_EMPTY_ERROR = "Enter an instance name.";
export const ORBIT_NAME_CHECKING = "Checking…";
export const ORBIT_NAME_CHECK_UNAVAILABLE =
  "Could not check the name. Orbit checks it when it creates the Instance.";

/** Orbit's name rule, checked without a request: true for a name Orbit may accept. */
export function isOrbitInstanceNameFormatValid(name: string): boolean {
  return (
    name.length <= ORBIT_INSTANCE_NAME_MAX_LENGTH &&
    NAME_PATTERN.test(name) &&
    name !== ORBIT_DEFAULT_INSTANCE_NAME
  );
}

/** A search text as an Instance name: lowercase, other characters as single dashes, at most 63. */
export function cleanOrbitInstanceSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, ORBIT_INSTANCE_NAME_MAX_LENGTH)
    .replace(/-+$/, "");
}

/**
 * The name field. `user` is a name the user typed (or the composer's chip passed in); `search` is
 * one a search without a match filled in. Only a `search` name follows the search.
 */
export interface OrbitNameField {
  readonly value: string;
  readonly source: "none" | "user" | "search";
}

export const EMPTY_ORBIT_NAME_FIELD: OrbitNameField = { value: "", source: "none" };

/** The field after the user typed in it; clearing it hands it back to the search. */
export function typedOrbitNameField(value: string): OrbitNameField {
  return value === "" ? EMPTY_ORBIT_NAME_FIELD : { value, source: "user" };
}

/**
 * The field after the search changed. A search that finds no Instance fills it with the search
 * text as a slug; when the search matches again or is cleared, that name goes. A typed name stays.
 */
export function orbitNameFieldForSearch(
  field: OrbitNameField,
  search: { readonly query: string; readonly matchCount: number },
): OrbitNameField {
  if (field.source === "user") return field;
  const query = search.query.trim();
  if (query !== "" && search.matchCount === 0) {
    const value = cleanOrbitInstanceSlug(query);
    return value === "" ? EMPTY_ORBIT_NAME_FIELD : { value, source: "search" };
  }
  return EMPTY_ORBIT_NAME_FIELD;
}

/** What Orbit's live check said about the current name. */
export type OrbitNameCheckState =
  | { readonly status: "idle" }
  | { readonly status: "checking"; readonly name: string }
  | {
      readonly status: "answered";
      readonly name: string;
      readonly answer: OrbitGatewayInstanceNameCheck;
    }
  /** 409 `instance.default_missing`: no Instance can be created in this Project now. */
  | { readonly status: "cannot-create"; readonly name: string; readonly message: string }
  /** The check failed or timed out; the create's own `instance.name_taken` is the guard. */
  | { readonly status: "unavailable"; readonly name: string };

export interface OrbitNameHint {
  readonly tone: "neutral" | "ok" | "bad";
  readonly text: string;
  /** False while the check runs and when nothing can be created here. */
  readonly plusEnabled: boolean;
  /** True when the plus or Enter creates the Instance with this name. */
  readonly canCreate: boolean;
}

/**
 * The line under the name field and whether the plus works. A check answer counts only for the
 * name it was asked for; an older one reads as still checking.
 */
export function orbitNameHint(input: {
  readonly name: string;
  readonly check: OrbitNameCheckState;
  readonly projectName: string;
  /** Set after the plus or Enter with no usable name, so the empty field says why. */
  readonly submitted?: boolean;
}): OrbitNameHint {
  const { name, check } = input;
  // Counts only for the name it was asked about, so a fixed default clears on the next check.
  if (check.status === "cannot-create" && check.name === name) {
    return { tone: "bad", text: check.message, plusEnabled: false, canCreate: false };
  }
  if (name === "") {
    return input.submitted
      ? { tone: "bad", text: ORBIT_NAME_EMPTY_ERROR, plusEnabled: true, canCreate: false }
      : { tone: "neutral", text: ORBIT_NAME_HINT, plusEnabled: true, canCreate: false };
  }
  if (!isOrbitInstanceNameFormatValid(name)) {
    return { tone: "bad", text: ORBIT_NAME_FORMAT_ERROR, plusEnabled: true, canCreate: false };
  }
  if (check.status === "unavailable" && check.name === name) {
    return {
      tone: "neutral",
      text: ORBIT_NAME_CHECK_UNAVAILABLE,
      plusEnabled: true,
      canCreate: true,
    };
  }
  if (check.status !== "answered" || check.name !== name) {
    return { tone: "neutral", text: ORBIT_NAME_CHECKING, plusEnabled: false, canCreate: false };
  }
  const { answer } = check;
  if (answer.available) {
    return {
      tone: "ok",
      text: `${name} is available.`,
      plusEnabled: true,
      canCreate: true,
    };
  }
  if (answer.reason === "taken") {
    return {
      tone: "bad",
      text: `${name} is taken in ${input.projectName}.`,
      plusEnabled: true,
      canCreate: false,
    };
  }
  if (answer.reason === "domain_invalid") {
    return {
      tone: "bad",
      text: ORBIT_NAME_DOMAIN_INVALID_TEXT,
      plusEnabled: true,
      canCreate: false,
    };
  }
  return { tone: "bad", text: ORBIT_NAME_FORMAT_ERROR, plusEnabled: true, canCreate: false };
}

/** The Gateway error a failed check carries, read without depending on its class. */
export function orbitNameCheckFailure(
  name: string,
  error: unknown,
): Extract<OrbitNameCheckState, { status: "cannot-create" | "unavailable" }> {
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  if (record.code === "instance.default_missing") {
    return {
      status: "cannot-create",
      name,
      message:
        typeof record.message === "string" && record.message.trim() !== ""
          ? record.message
          : "Orbit cannot create an Instance in this Project now.",
    };
  }
  return { status: "unavailable", name };
}

export type OrbitInstanceRowState = "running" | "stopped" | "expired";

export interface OrbitInstanceRow {
  readonly instanceId: number;
  readonly environmentId: string;
  readonly name: string;
  readonly nodeName: string | null;
  readonly domain: string | null;
  readonly state: OrbitInstanceRowState;
  /** Why the row cannot be picked, or null. */
  readonly disabledReason: string | null;
  /** True when this device has paired with the Instance's T3 server. */
  readonly paired: boolean;
  readonly threadCount: number;
  /** The newest local thread activity in the Instance, or null. */
  readonly lastUsedAt: string | null;
}

/** An older Gateway cannot wake an Instance, so its asleep rows cannot be picked. */
export const ORBIT_INSTANCE_STOPPED_REASON = "Stopped. Orbit cannot start it from Conn yet.";
/** Conn: the state word of an asleep Instance that Conn wakes when it is picked. */
export const ORBIT_INSTANCE_STOPPED_LABEL = "Stopped";
export const ORBIT_INSTANCE_EXPIRED_REASON = "Must register with Orbit again";

function hostOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * Every Instance of the Project in the Gateway's environment list: no owner filter, the default
 * never listed. Threads and last use come from this device's thread shells of each environment.
 * Running Instances come first, then by last use, then by name.
 */
export function buildOrbitInstanceRows(input: {
  readonly projectId: number;
  readonly environments: ReadonlyArray<OrbitGatewayEnvironment>;
  readonly threads: ReadonlyArray<{
    readonly environmentId: string;
    readonly updatedAt: string;
    readonly archivedAt: string | null;
  }>;
  readonly pairedEnvironmentIds: ReadonlySet<string>;
  /** Conn: false on an older Gateway without the wake route; an asleep row is then not pickable. */
  readonly canWake?: boolean;
}): OrbitInstanceRow[] {
  const byInstance = new Map<number, OrbitGatewayEnvironment>();
  for (const environment of input.environments) {
    if (environment.projectId !== input.projectId || environment.instanceId === null) continue;
    if (environment.instanceName === ORBIT_DEFAULT_INSTANCE_NAME) continue;
    const seen = byInstance.get(environment.instanceId);
    // Two records of one Instance: a registered one beats an expired one.
    if (
      seen === undefined ||
      (seen.status !== "registered" && environment.status === "registered")
    ) {
      byInstance.set(environment.instanceId, environment);
    }
  }
  const rows = [...byInstance.values()].map((environment): OrbitInstanceRow => {
    const threads = input.threads.filter(
      (thread) => thread.environmentId === environment.environmentId && thread.archivedAt === null,
    );
    const lastUsedAt =
      threads
        .map((thread) => thread.updatedAt)
        .toSorted()
        .at(-1) ?? null;
    const state: OrbitInstanceRowState =
      environment.status === "session_expired"
        ? "expired"
        : environment.powerState === "stopped"
          ? "stopped"
          : "running";
    return {
      instanceId: environment.instanceId!,
      environmentId: environment.environmentId,
      name: environment.instanceName ?? environment.label,
      nodeName: environment.nodeName,
      domain: hostOf(environment.instanceUrl),
      state,
      disabledReason:
        state === "expired"
          ? ORBIT_INSTANCE_EXPIRED_REASON
          : state === "stopped" && input.canWake === false
            ? ORBIT_INSTANCE_STOPPED_REASON
            : null,
      paired: input.pairedEnvironmentIds.has(environment.environmentId),
      threadCount: threads.length,
      lastUsedAt,
    };
  });
  const rank = (row: OrbitInstanceRow) => (row.state === "running" ? 0 : 1);
  return rows.toSorted(
    (left, right) =>
      rank(left) - rank(right) ||
      (right.lastUsedAt ?? "").localeCompare(left.lastUsedAt ?? "") ||
      left.name.localeCompare(right.name),
  );
}

/** `<node> · <domain> · N threads`, or the reason for a row that cannot be picked. */
export function orbitInstanceRowSubline(row: OrbitInstanceRow): string {
  const parts = [row.nodeName];
  if (row.disabledReason !== null)
    return [...parts, row.disabledReason].filter(Boolean).join(" · ");
  if (row.state === "stopped") parts.push(ORBIT_INSTANCE_STOPPED_LABEL);
  parts.push(row.domain);
  parts.push(
    `${row.threadCount === 0 ? "no" : row.threadCount} thread${row.threadCount === 1 ? "" : "s"}`,
  );
  return parts.filter(Boolean).join(" · ");
}

/** The rows a search keeps: name, Node or domain contains the text, ignoring case. */
export function filterOrbitInstanceRows(
  rows: ReadonlyArray<OrbitInstanceRow>,
  query: string,
): OrbitInstanceRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...rows];
  return rows.filter((row) =>
    [row.name, row.nodeName, row.domain].some((text) => text?.toLowerCase().includes(needle)),
  );
}

/** What picking a row does. */
export type OrbitInstancePick =
  | { readonly kind: "disabled" }
  /** Paired and running: a normal draft in the clone's own `/srv/workspace` project. */
  | { readonly kind: "paired"; readonly environmentId: string }
  /** Running but not paired on this device: an Orbit draft for the existing Instance. */
  | {
      readonly kind: "unpaired";
      readonly instanceId: number;
      readonly environmentId: string;
      readonly name: string;
    };

export function orbitInstancePick(row: OrbitInstanceRow): OrbitInstancePick {
  if (row.disabledReason !== null) return { kind: "disabled" };
  if (row.paired) return { kind: "paired", environmentId: row.environmentId };
  return {
    kind: "unpaired",
    instanceId: row.instanceId,
    environmentId: row.environmentId,
    name: row.name,
  };
}

export const ORBIT_CLONE_WORKSPACE_ROOT = "/srv/workspace";

/** The T3 project of a paired clone a new thread opens in: `/srv/workspace`, else its only one. */
export function orbitCloneProject<
  T extends { readonly environmentId: string; readonly workspaceRoot: string },
>(projects: ReadonlyArray<T>, environmentId: string): T | null {
  const inClone = projects.filter((project) => project.environmentId === environmentId);
  return (
    inClone.find((project) => project.workspaceRoot === ORBIT_CLONE_WORKSPACE_ROOT) ??
    (inClone.length === 1 ? inClone[0]! : null)
  );
}
