import type { ProjectRecipeRenderContext } from "@t3tools/project-recipes";

export function buildPrelaunchView(input: {
  readonly workspaceRoot: string;
  readonly callerKind: "visibility" | "view.preRender";
  readonly renderContext: ProjectRecipeRenderContext;
}) {
  return {
    surface: input.renderContext.surface,
    state: { callerKind: input.callerKind, renderContext: input.renderContext },
    project: {
      title: input.renderContext.project.title,
      provider: input.renderContext.project.provider ?? null,
      workspaceRoot: input.workspaceRoot,
    },
    thread: null,
  };
}
