import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { ProjectFavicon, type ProjectFaviconProject } from "./ProjectFavicon";

const state = vi.hoisted(() => ({ favicon: undefined as Atom.Atom<string | null> | undefined }));
vi.mock(import("../state/assets"), () => ({
  projectFaviconUrlAtom: () => {
    if (!state.favicon) throw new Error("Favicon resource not configured");
    return state.favicon;
  },
}));

function setup() {
  const activeResources = new Set<string>();
  state.favicon = Atom.make((get) => {
    activeResources.add("favicon");
    get.addFinalizer(() => activeResources.delete("favicon"));
    return null;
  });
  return { activeResources };
}

it("only activates the favicon resource after removing a custom icon", async () => {
  const { activeResources } = setup();
  const registry = AtomRegistry.make();
  const project: ProjectFaviconProject = {
    environmentId: EnvironmentId.make("test"),
    workspaceRoot: "/project",
    title: "Project",
    faviconPath: "icon.png",
    projectIcon: { kind: "monogram", text: "PR", color: "blue" },
  };
  const view = (projectIcon: ProjectFaviconProject["projectIcon"]) => (
    <RegistryContext value={registry}>
      <ProjectFavicon project={{ ...project, projectIcon }} />
    </RegistryContext>
  );
  try {
    await using screen = await render(view(project.projectIcon));
    expect(activeResources.size).toBe(0);
    await screen.rerender(view({ kind: "emoji", emoji: "🌱" }));
    expect(activeResources.size).toBe(0);
    await screen.rerender(view({ kind: "lucide", name: "leaf", color: "green" }));
    expect(activeResources.size).toBe(0);
    await screen.rerender(view(null));
    expect(activeResources.size).toBe(1);
    await screen.rerender(view(project.projectIcon));
    await screen.rerender(view(null));
    expect(activeResources.size).toBe(1);
  } finally {
    registry.dispose();
  }
});
