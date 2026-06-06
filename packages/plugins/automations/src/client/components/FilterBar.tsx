import type { PluginUiContext } from "@t3tools/plugin-api/ui";

import { filterGridStyle } from "../layout.ts";
import type { PluginProject, RuleStatusFilter } from "../types.ts";

export function FilterBar({
  ctx,
  projects,
  projectFilter,
  statusFilter,
  visibleRuleCount,
  setProjectFilter,
  setStatusFilter,
}: {
  readonly ctx: PluginUiContext;
  readonly projects: ReadonlyArray<PluginProject>;
  readonly projectFilter: string;
  readonly statusFilter: RuleStatusFilter;
  readonly visibleRuleCount: number;
  readonly setProjectFilter: (value: string) => void;
  readonly setStatusFilter: (value: RuleStatusFilter) => void;
}) {
  const React = ctx.react;
  const C = ctx.components;

  return (
    <React.Fragment>
      <C.Toolbar trailing={`${visibleRuleCount} rule${visibleRuleCount === 1 ? "" : "s"}`}>
        <div style={filterGridStyle}>
          <C.Select
            options={[
              { value: "all", label: "All projects" },
              ...projects.map((project) => ({ value: project.id, label: project.name })),
            ]}
            value={projectFilter}
            onValueChange={(value) => setProjectFilter(value || "all")}
          />
          <C.Select
            options={[
              { value: "all", label: "All statuses" },
              { value: "enabled", label: "Enabled" },
              { value: "disabled", label: "Disabled" },
            ]}
            value={statusFilter}
            onValueChange={(value) => {
              setStatusFilter(value === "enabled" || value === "disabled" ? value : "all");
            }}
          />
        </div>
      </C.Toolbar>
    </React.Fragment>
  );
}
