import type { UsageProject } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

export class UsageProjectAttributionReadError extends Schema.TaggedError<UsageProjectAttributionReadError>()(
  "UsageProjectAttributionReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read provider session projects for usage.";
  }
}

export const sessionKey = (driver: string, nativeId: string) => `${driver}\u0000${nativeId}`;

/** Keyed by `sessionKey`. A session claimed by threads in different projects belongs to neither. */
export function projectsBySession(
  rows: ReadonlyArray<ProjectStore.ProviderSessionProjectRow>,
): ReadonlyMap<string, UsageProject> {
  const claimed = new Map<string, UsageProject | null>();
  for (const row of rows) {
    const key = sessionKey(row.driver, row.nativeId);
    const existing = claimed.get(key);
    if (existing !== undefined) {
      if (existing?.projectId !== row.projectId) claimed.set(key, null);
      continue;
    }
    const title =
      row.title.trim() ||
      row.workspaceRoot.split(/[\\/]/).findLast((part) => part.length > 0) ||
      "Untitled project";
    claimed.set(key, { projectId: row.projectId, title });
  }
  const projects = new Map<string, UsageProject>();
  for (const [key, project] of claimed) if (project !== null) projects.set(key, project);
  return projects;
}

export class UsageProjectAttribution extends Context.Service<
  UsageProjectAttribution,
  {
    /** Keyed by `sessionKey`; deleted projects keep their past usage. */
    readonly read: Effect.Effect<
      ReadonlyMap<string, UsageProject>,
      UsageProjectAttributionReadError
    >;
  }
>()("t3/usage/UsageProjectAttribution") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const read = projects.listProviderSessionProjects().pipe(
    Effect.map(projectsBySession),
    Effect.mapError((cause) => new UsageProjectAttributionReadError({ cause })),
    Effect.withSpan("UsageProjectAttribution.read"),
  );
  return UsageProjectAttribution.of({ read });
});

export const layer = Layer.effect(UsageProjectAttribution, make);
