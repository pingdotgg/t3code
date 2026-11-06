import type { OrchestrationProjectShell } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const ComputerTaskDispatchErrorCode = Schema.Literals([
  "dispatch_failed",
  "project_not_found",
  "project_ambiguous",
  "computer_offline",
]);
export type ComputerTaskDispatchErrorCode = typeof ComputerTaskDispatchErrorCode.Type;

export class ComputerTaskDispatchError extends Schema.TaggedError<ComputerTaskDispatchError>()(
  "ComputerTaskDispatchError",
  { code: ComputerTaskDispatchErrorCode, message: Schema.String },
) {}

function basename(path: string): string {
  const trimmed = path.replaceAll("\\", "/").replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] ?? trimmed;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function matchProject(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly hint: string | null;
  readonly sourceTitle: string;
  readonly sourceWorkspaceRoot: string;
}):
  | OrchestrationProjectShell
  | { readonly error: "not_found" | "ambiguous"; readonly detail: string } {
  const projects = input.projects;
  const describe = (project: OrchestrationProjectShell) =>
    `${project.title} (${project.workspaceRoot})`;

  const pick = (
    candidates: ReadonlyArray<OrchestrationProjectShell>,
    emptyDetail: string,
    manyDetail: string,
  ) => {
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length === 0) return { error: "not_found" as const, detail: emptyDetail };
    return {
      error: "ambiguous" as const,
      detail: `${manyDetail}: ${candidates.map(describe).join("; ")}`,
    };
  };

  if (input.hint && input.hint.trim().length > 0) {
    const needle = normalize(input.hint);
    const exactTitle = projects.filter((project) => normalize(project.title) === needle);
    if (exactTitle.length === 1) return exactTitle[0]!;
    const exactPath = projects.filter(
      (project) =>
        normalize(project.workspaceRoot) === needle ||
        normalize(basename(project.workspaceRoot)) === needle,
    );
    if (exactPath.length === 1) return exactPath[0]!;
    const includes = projects.filter(
      (project) =>
        normalize(project.title).includes(needle) ||
        normalize(project.workspaceRoot).includes(needle),
    );
    return pick(
      includes,
      `No project on that computer matches '${input.hint}'.`,
      `Multiple projects match '${input.hint}'`,
    );
  }

  const byTitle = projects.filter(
    (project) => normalize(project.title) === normalize(input.sourceTitle),
  );
  if (byTitle.length === 1) return byTitle[0]!;
  const byBasename = projects.filter(
    (project) =>
      normalize(basename(project.workspaceRoot)) === normalize(basename(input.sourceWorkspaceRoot)),
  );
  if (byBasename.length === 1) return byBasename[0]!;
  if (projects.length === 1) return projects[0]!;
  if (projects.length === 0) {
    return {
      error: "not_found",
      detail: "That computer has no T3 projects yet. Add a project there first.",
    };
  }
  return {
    error: "ambiguous",
    detail: `Could not match a project on that computer. Pass project: ${projects.map(describe).join("; ")}`,
  };
}

export function requireMatchedProject(
  matched: ReturnType<typeof matchProject>,
): OrchestrationProjectShell {
  if ("error" in matched) {
    throw new ComputerTaskDispatchError({
      code: matched.error === "not_found" ? "project_not_found" : "project_ambiguous",
      message: matched.detail,
    });
  }
  return matched;
}
