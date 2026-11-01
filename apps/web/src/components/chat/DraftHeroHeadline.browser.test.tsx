import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { DraftHeroHeadline } from "./DraftHeroHeadline";

const state = vi.hoisted(() => ({ projects: [] as ReadonlyArray<EnvironmentProject> }));

vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => state.projects,
}));
vi.mock(import("~/hooks/useScratchProject"), () => ({
  useScratchProject: () => ({
    scratchEnvironmentId: () => null,
    scratchWorkspaceRootFor: () => "/scratch",
    startScratchThread: async () => {},
    openScratchProject: async () => null,
  }),
}));

it("displays the saved scratch identity in the draft project trigger", async () => {
  const project: EnvironmentProject = {
    id: ProjectId.make("scratch-project"),
    environmentId: EnvironmentId.make("scratch-environment"),
    title: "Acme notes with a long saved scratch title that does not fit in the project trigger",
    projectIcon: { kind: "emoji", emoji: "📝" },
    workspaceRoot: "/scratch",
    isScratch: true,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-29T00:00:00Z",
    updatedAt: "2026-10-29T00:00:00Z",
  };
  state.projects = [
    {
      ...project,
      environmentId: EnvironmentId.make("other-environment"),
      title: "Remote notes",
      projectIcon: { kind: "emoji", emoji: "🏠" },
    },
    project,
  ];
  await using screen = await render(
    <DraftHeroHeadline
      draftId={null}
      activeProjectRef={scopeProjectRef(project.environmentId, project.id)}
      activeProjectTitle={project.title}
    />,
  );

  const trigger = screen.getByRole("combobox");
  await expect.element(trigger.getByText(project.title, { exact: true })).toBeVisible();
  await expect.element(trigger.getByText("📝", { exact: true })).toBeVisible();
  await userEvent.tab();
  await expect.element(trigger).toHaveFocus();
  await expect.element(page.getByRole("tooltip")).toHaveTextContent(project.title);
});
