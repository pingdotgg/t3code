import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { ProjectFavicon, type ProjectFaviconProject } from "./ProjectFavicon";

const state = vi.hoisted(() => ({
  favicon: undefined as Atom.Atom<string | null> | undefined,
  faviconByCwd: new Map<string, Atom.Atom<string | null>>(),
}));
vi.mock(import("../state/assets"), () => ({
  projectFaviconUrlAtom: ({ cwd }) => {
    const favicon = state.faviconByCwd.get(cwd) ?? state.favicon;
    if (!favicon) throw new Error("Favicon resource not configured");
    return favicon;
  },
}));

function setup() {
  state.faviconByCwd.clear();
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

it("shows a group's icon from its first checkout that has one", async () => {
  setup();
  const faviconUrl = "data:image/png;base64,iVBORw0KGgo=";
  state.faviconByCwd.set("/server", Atom.make(null));
  state.faviconByCwd.set("/t3code", Atom.make(faviconUrl));
  const primary: ProjectFaviconProject = {
    environmentId: EnvironmentId.make("primary"),
    workspaceRoot: "/server",
    title: "server",
    faviconPath: null,
    projectIcon: null,
  };
  const secondary: ProjectFaviconProject = {
    environmentId: EnvironmentId.make("secondary"),
    workspaceRoot: "/t3code",
    title: "t3code",
    faviconPath: null,
    projectIcon: null,
  };
  const registry = AtomRegistry.make();
  try {
    await using screen = await render(
      <RegistryContext value={registry}>
        <ProjectFavicon project={{ ...primary, memberProjects: [primary, secondary] }} />
      </RegistryContext>,
    );
    await vi.waitFor(() =>
      expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(faviconUrl),
    );
  } finally {
    registry.dispose();
  }
});
