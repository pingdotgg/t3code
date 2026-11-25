import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { ProjectFavicon, type ProjectFaviconProject } from "./ProjectFavicon";

const state = vi.hoisted(() => ({
  favicon: undefined as Atom.Atom<string | null> | undefined,
  refresh: (() => {}) as () => void,
}));
vi.mock(import("../state/assets"), () => ({
  projectFaviconUrlAtom: () => {
    if (!state.favicon) throw new Error("Favicon resource not configured");
    return state.favicon;
  },
  refreshProjectFaviconUrl: () => state.refresh(),
}));

function setup() {
  state.refresh = () => {};
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
    await screen.rerender(view({ kind: "dashboard-icon", name: "plex", file: "plex.svg" }));
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

it("asks for a new URL when a remote icon's URL stops loading", async () => {
  const registry = AtomRegistry.make();
  const favicon = Atom.make<string | null>("http://127.0.0.1:9/api/assets/expired/favicon.svg");
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';
  const freshUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  state.favicon = favicon;
  state.refresh = () => registry.set(favicon, freshUrl);
  const project: ProjectFaviconProject = {
    environmentId: EnvironmentId.make("test"),
    workspaceRoot: "/project",
    title: "Project",
    faviconPath: null,
    projectIcon: null,
  };
  try {
    await using screen = await render(
      <RegistryContext value={registry}>
        <ProjectFavicon project={project} />
      </RegistryContext>,
    );
    await expect
      .poll(() => screen.container.querySelector("img:not(.hidden)")?.getAttribute("src"))
      .toBe(freshUrl);
  } finally {
    URL.revokeObjectURL(freshUrl);
    registry.dispose();
  }
});

it("asks for a new URL only once when the new URL fails too", async () => {
  const registry = AtomRegistry.make();
  const favicon = Atom.make<string | null>("http://127.0.0.1:9/api/assets/expired/favicon.svg");
  const brokenUrl = "http://127.0.0.1:9/api/assets/broken/favicon.svg";
  let refreshes = 0;
  state.favicon = favicon;
  state.refresh = () => {
    refreshes += 1;
    registry.set(favicon, brokenUrl);
  };
  const project: ProjectFaviconProject = {
    environmentId: EnvironmentId.make("test"),
    workspaceRoot: "/project",
    title: "Project",
    faviconPath: null,
    projectIcon: null,
  };
  try {
    await using screen = await render(
      <RegistryContext value={registry}>
        <ProjectFavicon project={project} />
      </RegistryContext>,
    );
    await vi.waitFor(() => {
      const image = screen.container.querySelector<HTMLImageElement>(`img[src="${brokenUrl}"]`);
      expect(image?.complete).toBe(true);
    });
    expect(refreshes).toBe(1);
  } finally {
    registry.dispose();
  }
});
