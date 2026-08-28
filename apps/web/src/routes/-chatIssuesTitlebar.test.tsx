import { renderToStaticMarkup } from "react-dom/server";
import { SettingsIcon } from "lucide-react";
import type { IssueListEntry, LinearProjectBinding, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../test/reactElementTree";
import { LinearIcon } from "../components/Icons";
import { ListRefreshControl } from "../components/sourceControl/ListTitlebarControls";
import { Button } from "../components/ui/button";
import { MenuItem, MenuRadioItem } from "../components/ui/menu";
import {
  CompactFilterMenu,
  hasLinearManagementState,
  issueSelectionSearchPatch,
  isIssueEntryOpen,
  IssuesColumn,
  mergeIssueProviderSummaries,
  stabilizeLinearProviderSummary,
} from "./_chat.issues";

describe("IssuesColumn", () => {
  it("marks only the opened issue as current", () => {
    const opened = {
      projectId: "project_1" as ProjectId,
      repository: "pingdotgg/t3code",
      provider: "github",
      number: 12,
    };
    const entry = {
      projectId: opened.projectId,
      repository: opened.repository,
      provider: opened.provider,
      number: 13,
    } as IssueListEntry;

    expect(isIssueEntryOpen(opened, entry)).toBe(false);
    expect(isIssueEntryOpen({ ...opened, number: 13 }, entry)).toBe(true);
  });

  it("clears a stale provider when the next issue has none", () => {
    expect(
      issueSelectionSearchPatch({
        projectId: "project_1" as ProjectId,
        repository: "pingdotgg/t3code",
        number: 1,
      }),
    ).toMatchObject({ selectedProvider: undefined });
  });

  it("keeps refresh beside list filters without a selection-mode control", () => {
    const column = (
      <IssuesColumn
        refreshing
        onRefresh={() => undefined}
        searchValue=""
        involvement="all"
        state="open"
        host={undefined}
        hostMenuOptions={[]}
        hostMenuAction={undefined}
        onInvolvement={() => undefined}
        onState={() => undefined}
        onHost={() => undefined}
        searchInput={<input aria-label="Search issues" />}
        filtersMenu={<button type="button">Filters</button>}
        rightPanelControl={null}
        rightPanelOpen={false}
        listBody={null}
      />
    );
    const markup = renderToStaticMarkup(column);
    const refreshButton = ListRefreshControl({
      label: "Refresh issues",
      refreshing: true,
      onRefresh: () => undefined,
    });

    expect(markup).toContain("<header");
    const header = markup.slice(markup.indexOf("<header"), markup.indexOf("</header>"));
    expect(header).not.toContain(">Select</button>");
    expect(header).not.toContain(">Filters</button>");
    expect(header).not.toContain('aria-label="Refresh issues"');
    expect(markup.match(/aria-label="Refresh issues"/g)).toHaveLength(1);
    expect(refreshButton?.type).toBe(Button);
    expect(refreshButton?.props).toMatchObject({
      size: "icon",
      variant: "outline",
      disabled: true,
    });
    expect(header).toContain("h-[var(--workspace-topbar-height)]");
    expect(header).toContain("pl-[calc(env(safe-area-inset-left)+0.75rem)]");
    expect(markup).toContain("max-w-4xl");
    expect(markup).toContain("gap-4");
  });

  it("keeps provider management in the compact menu", () => {
    const onClick = vi.fn();
    const menu = CompactFilterMenu({
      label: "Filter by provider",
      value: "",
      options: [{ value: "", label: "All providers", Icon: SettingsIcon }],
      onChange: vi.fn(),
      action: { connected: false, onClick },
    });
    const action = visitElements(
      menu,
      (element) => element.type === MenuItem && element.props.children !== undefined,
    );

    expect(action?.props.children).toContain("Connect Linear…");
    expect(visitElements(action, (element) => element.type === LinearIcon)).not.toBeNull();
    (action?.props.onClick as (() => void) | undefined)?.();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("puts a keyboard-navigable Linear settings menu action beside the compact radio item", () => {
    const onClick = vi.fn();
    const menu = CompactFilterMenu({
      label: "Filter by provider",
      value: "",
      options: [
        { value: "", label: "All providers", Icon: SettingsIcon },
        { value: "linear.app", label: "Linear", Icon: LinearIcon },
      ],
      onChange: vi.fn(),
      action: { connected: true, onClick },
    });
    const gear = visitElements(
      menu,
      (element) => element.type === MenuItem && element.props["aria-label"] === "Linear settings",
    );
    const linearRadio = visitElements(
      menu,
      (element) => element.type === MenuRadioItem && element.props.value === "linear.app",
    );

    expect(gear).not.toBeNull();
    expect(visitElements(menu, (element) => element.type === SettingsIcon)).not.toBeNull();
    expect(visitElements(linearRadio, (element) => element.type === MenuItem)).toBeNull();
    (gear?.props.onClick as (() => void) | undefined)?.();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("merges a filtered provider answer without dropping other providers", () => {
    const github = {
      kind: "github",
      host: "github.com",
      configured: true,
      searchesOnHost: true,
      projectCount: 1,
      detail: null,
    } as const;
    const staleLinear = {
      kind: "linear",
      host: "linear.app",
      configured: false,
      searchesOnHost: false,
      projectCount: 1,
      detail: null,
    } as const;
    const linear = { ...staleLinear, configured: true } as const;

    expect(mergeIssueProviderSummaries([github, staleLinear], [linear], "linear.app")).toEqual([
      github,
      linear,
    ]);
    expect(mergeIssueProviderSummaries([github], [linear], undefined)).toEqual([linear]);
  });

  it("keeps Linear visible from current non-null bindings when a stale All response arrives", () => {
    const github = {
      kind: "github",
      host: "github.com",
      configured: true,
      searchesOnHost: true,
      projectCount: 1,
      detail: null,
    } as const;

    const project_1 = "project_1" as ProjectId;
    const project_2 = "project_2" as ProjectId;
    const deleted = "deleted" as ProjectId;
    const bindings = {
      [project_1]: { credentialId: "user-1", teamKey: "ENG" },
      [project_2]: null,
      [deleted]: { credentialId: "user-2", teamKey: "OPS" },
    } satisfies Readonly<Record<ProjectId, LinearProjectBinding | null>>;

    expect(stabilizeLinearProviderSummary([github], [project_1, project_2], bindings)).toEqual([
      github,
      {
        kind: "linear",
        host: "linear.app",
        configured: true,
        searchesOnHost: false,
        projectCount: 1,
        detail: null,
      },
    ]);
  });

  it("drops a cached Linear provider after another client disconnects it", () => {
    const github = {
      kind: "github",
      host: "github.com",
      configured: true,
      searchesOnHost: true,
      projectCount: 1,
      detail: null,
    } as const;
    const staleLinear = {
      kind: "linear",
      host: "linear.app",
      configured: true,
      searchesOnHost: false,
      projectCount: 1,
      detail: null,
    } as const;
    const projectId = "project_1" as ProjectId;

    expect(stabilizeLinearProviderSummary([github, staleLinear], [projectId], {})).toEqual([
      github,
    ]);
  });

  it("keeps a cached Linear provider for a current legacy environment-token team", () => {
    const linear = {
      kind: "linear",
      host: "linear.app",
      configured: true,
      searchesOnHost: false,
      projectCount: 1,
      detail: null,
    } as const;
    const projectId = "project_1" as ProjectId;
    const legacyTeam = hasLinearManagementState(
      { status: "unauthenticated", hasStoredToken: false },
      { projectBindings: {}, projectTeams: { [projectId]: "ENG" } },
    );

    expect(stabilizeLinearProviderSummary([linear], [projectId], {}, legacyTeam)).toEqual([linear]);
  });

  it("recognizes legacy teams and authenticated environment tokens as Linear management state", () => {
    expect(
      hasLinearManagementState(
        { status: "unverified", hasStoredToken: false },
        { projectBindings: {}, projectTeams: { project_1: "ENG" } },
      ),
    ).toBe(true);
    expect(
      hasLinearManagementState(
        { status: "authenticated", hasStoredToken: false },
        { projectBindings: {}, projectTeams: {} },
      ),
    ).toBe(true);
    expect(
      hasLinearManagementState(
        { status: "unauthenticated", hasStoredToken: false },
        { projectBindings: { project_1: null }, projectTeams: { project_1: "ENG" } },
        ["project_1" as ProjectId],
      ),
    ).toBe(false);
  });
});
