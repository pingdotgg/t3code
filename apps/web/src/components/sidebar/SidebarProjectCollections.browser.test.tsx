import "../../index.css";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import {
  PROJECT_COLLECTIONS_STORAGE_KEY,
  resolveProjectCollectionScope,
} from "../../projectCollections";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { PERSISTED_STATE_KEY, useUiStateStore } from "../../uiStateStore";
import { ProjectCollectionDialog, SidebarProjectCollectionTabs } from "./SidebarProjectCollections";

const settings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};
const catalog = buildSidebarProjectSnapshots({
  projects: ["Alpha", "Beta"].map((title) => ({
    id: ProjectId.make(title),
    environmentId: EnvironmentId.make("env"),
    title,
    workspaceRoot: `/${title}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  })),
  settings,
  groupScratchProjects: true,
  primaryEnvironmentId: null,
  resolveEnvironmentLabel: () => null,
});

function Collections() {
  const collections = useUiStateStore((state) => state.projectCollections);
  const activeId = useUiStateStore((state) => state.activeProjectCollectionId);
  const select = useUiStateStore((state) => state.selectProjectCollection);
  const remove = useUiStateStore((state) => state.deleteProjectCollection);
  const [editor, setEditor] = useState<{ id: string | null } | null>(null);
  const scope = resolveProjectCollectionScope({
    collections,
    activeCollectionId: activeId,
    catalog,
    settings,
    adHocProjectKeys: [],
  });
  return (
    <>
      <button type="button" onClick={() => setEditor({ id: null })}>
        New group
      </button>
      <SidebarProjectCollectionTabs
        collections={collections}
        activeId={activeId}
        onSelect={(id) => select(id, "env:open")}
        onEdit={(id) => setEditor({ id })}
      />
      <ul aria-label="Visible projects">
        {scope.catalog.map((row) => (
          <li key={row.projectKey}>{row.displayName}</li>
        ))}
      </ul>
      {editor ? (
        <ProjectCollectionDialog
          key={editor.id ?? "new"}
          collection={collections.find((group) => group.id === editor.id) ?? null}
          catalog={catalog}
          settings={settings}
          onClose={() => setEditor(null)}
          onSaved={(id) => {
            select(id, "env:open");
            setEditor(null);
          }}
          onDelete={(id) => {
            remove(id, "env:open");
            setEditor(null);
          }}
        />
      ) : null}
    </>
  );
}

function isolatedCollections(): Disposable {
  const previous = useUiStateStore.getState();
  const definitions = localStorage.getItem(PROJECT_COLLECTIONS_STORAGE_KEY);
  const navigation = localStorage.getItem(PERSISTED_STATE_KEY);
  localStorage.removeItem(PROJECT_COLLECTIONS_STORAGE_KEY);
  useUiStateStore.setState({
    projectCollections: [],
    activeProjectCollectionId: null,
    sidebarProjectScopeKeys: [],
    sidebarScopeRouteKey: null,
  });
  return {
    [Symbol.dispose]() {
      useUiStateStore.setState(previous);
      window.dispatchEvent(new Event("beforeunload"));
      const snapshots: readonly (readonly [string, string | null])[] = [
        [PROJECT_COLLECTIONS_STORAGE_KEY, definitions],
        [PERSISTED_STATE_KEY, navigation],
      ];
      for (const [key, value] of snapshots) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    },
  };
}

describe("project group workflow", () => {
  it("creates, scopes, cancels, renames, empties, and deletes a selected group", async () => {
    using _collections = isolatedCollections();
    await using screen = await render(<Collections />);
    await userEvent.click(screen.getByRole("button", { name: "New group", exact: true }));
    await userEvent.fill(page.getByRole("textbox", { name: "Name" }), " Work ");
    await userEvent.click(page.getByRole("checkbox", { name: "Alpha", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Save", exact: true }));
    const id = useUiStateStore.getState().activeProjectCollectionId;
    await expect
      .element(screen.getByRole("list", { name: "Visible projects" }))
      .toHaveTextContent("Alpha");
    await expect.element(screen.getByText("Beta", { exact: true })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(PROJECT_COLLECTIONS_STORAGE_KEY) ?? "[]")).toMatchObject(
      [{ id, name: "Work", members: [{ physicalKey: "env:/Alpha" }] }],
    );

    await userEvent.click(screen.getByRole("button", { name: "Manage project groups" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Edit group", exact: true }));
    await userEvent.fill(page.getByRole("textbox", { name: "Name" }), "Discarded");
    await userEvent.click(page.getByRole("checkbox", { name: "Beta", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
    expect(useUiStateStore.getState().projectCollections[0]?.name).toBe("Work");
    await expect.element(screen.getByText("Beta", { exact: true })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Manage project groups" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Edit group", exact: true }));
    await userEvent.fill(page.getByRole("textbox", { name: "Name" }), "All");
    await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await userEvent.fill(page.getByRole("textbox", { name: "Name" }), "Personal");
    await userEvent.click(page.getByRole("checkbox", { name: "Alpha", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Save", exact: true }));
    await expect
      .element(screen.getByRole("button", { name: "Personal", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    expect(useUiStateStore.getState().activeProjectCollectionId).toBe(id);
    await expect
      .element(screen.getByRole("list", { name: "Visible projects" }))
      .toBeEmptyDOMElement();

    await userEvent.click(screen.getByRole("button", { name: "All", exact: true }));
    await expect.element(screen.getByText("Beta", { exact: true })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Personal", exact: true }));
    await userEvent.click(screen.getByRole("button", { name: "Manage project groups" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Edit group", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Delete group", exact: true }));
    expect(useUiStateStore.getState().activeProjectCollectionId).toBeNull();
    await expect.element(screen.getByText("Beta", { exact: true })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(PROJECT_COLLECTIONS_STORAGE_KEY) ?? "null")).toEqual([]);
  });
});
