import * as Schema from "effect/Schema";

/** Linear screens pushed on the root stack, in the order they are drilled into. */
const LINEAR_ROUTE_NAMES = [
  "LinearTeam",
  "LinearProject",
  "LinearMilestone",
  "LinearIssue",
] as const;
export type LinearRouteName = (typeof LINEAR_ROUTE_NAMES)[number];

const MAX_STORED_ROUTES = 8;

export const StoredLinearRoute = Schema.Struct({
  name: Schema.Literals(LINEAR_ROUTE_NAMES),
  params: Schema.Record(Schema.String, Schema.String),
});
export type StoredLinearRoute = typeof StoredLinearRoute.Type;

/** Where the user last was in Linear: the stack above the tab, for one environment. */
export const StoredLinearLocation = Schema.Struct({
  environmentId: Schema.String,
  /** Learned once the environment's Linear status loads; null until then. */
  organizationId: Schema.NullOr(Schema.String),
  routes: Schema.Array(StoredLinearRoute).check(Schema.isMaxLength(MAX_STORED_ROUTES)),
});
export type StoredLinearLocation = typeof StoredLinearLocation.Type;

const isLinearRouteName = (name: string): name is LinearRouteName =>
  (LINEAR_ROUTE_NAMES as ReadonlyArray<string>).includes(name);

interface RouteLike {
  readonly name: string;
  readonly params?: object | undefined;
}

function stringParams(params: object | undefined): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value !== "string") return null;
    result[key] = value;
  }
  return result;
}

/**
 * The Linear screens at the top of the root stack, or null when the focused screen is not one
 * (the workspace itself, a chat), so leaving Linear keeps the last location instead of clearing it.
 */
export function linearLocationFromStack(
  routes: ReadonlyArray<RouteLike>,
): StoredLinearLocation | null {
  if (!isLinearRouteName(routes.at(-1)?.name ?? "")) return null;
  const trailing: Array<StoredLinearRoute> = [];
  for (let index = routes.length - 1; index >= 0; index -= 1) {
    const route = routes[index]!;
    if (!isLinearRouteName(route.name)) break;
    const params = stringParams(route.params);
    if (params === null) return null;
    trailing.unshift({ name: route.name, params });
  }
  // Each Linear screen stands on its own, so a long issue-to-issue chain keeps its newest screens.
  const kept = trailing.slice(-MAX_STORED_ROUTES);
  const environmentId = kept[0]?.params.environmentId;
  if (
    environmentId === undefined ||
    kept.some((route) => route.params.environmentId !== environmentId)
  ) {
    return null;
  }
  return { environmentId, organizationId: null, routes: kept };
}

/**
 * The routes to push when the Linear tab opens. Nothing for another environment or Linear
 * organization, whose scopes and issues would not exist here.
 */
export function linearRoutesToResume(input: {
  readonly stored: StoredLinearLocation | null;
  readonly environmentId: string | null;
  readonly organizationId: string | null;
}): ReadonlyArray<StoredLinearRoute> {
  const { stored } = input;
  if (stored === null || input.environmentId === null) return [];
  if (stored.environmentId !== input.environmentId) return [];
  if (
    stored.organizationId !== null &&
    input.organizationId !== null &&
    stored.organizationId !== input.organizationId
  ) {
    return [];
  }
  return stored.routes;
}
