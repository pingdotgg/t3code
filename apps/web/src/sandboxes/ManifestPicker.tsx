import type { AgentctlSandboxManifest } from "@t3tools/contracts";
import { ChevronsUpDownIcon, FolderGit2Icon } from "lucide-react";
import { Fragment, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Combobox,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../components/ui/combobox";
import { Label } from "../components/ui/label";
import { MiddleTruncate } from "../components/ui/middle-truncate";
import { Separator } from "../components/ui/separator";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import {
  filterManifestRepositories,
  groupManifests,
  manifestRelativePath,
  pickAgentManifest,
} from "./manifestAgents";
import { tildePath } from "./manifestFolders";

/**
 * Picks a manifest in two steps: the agent, a folder found in one of the user's repositories,
 * and then which of its `agent.<variant>.yaml` files to apply.
 */
export function ManifestPicker({
  manifests,
  homeDirectory,
  value,
  onValueChange,
}: {
  manifests: ReadonlyArray<AgentctlSandboxManifest>;
  /** The host's home, so paths read as `~/…`. */
  homeDirectory: string;
  value: AgentctlSandboxManifest | null;
  onValueChange: (manifest: AgentctlSandboxManifest) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const highlighted = useRef<string | null>(null);
  const repositories = groupManifests(manifests);
  const filtered = filterManifestRepositories(repositories, query);
  const keys = filtered.flatMap((repository) => repository.agents.map((agent) => agent.directory));

  const repository = repositories.find((candidate) =>
    candidate.agents.some((agent) => agent.directory === value?.directory),
  );
  const agent = repository?.agents.find((candidate) => candidate.directory === value?.directory);

  const pick = (directory: string | null) => {
    const picked = repositories
      .flatMap((candidate) => candidate.agents)
      .find((candidate) => candidate.directory === directory);
    const manifest = picked && pickAgentManifest(picked, query, value?.variant ?? null);
    if (manifest) onValueChange(manifest);
  };

  return (
    <>
      <div className="grid gap-1.5">
        <Label>Agent</Label>
        <Combobox
          items={keys}
          // The search also matches repositories and variants, so it filters here.
          filteredItems={keys}
          filter={null}
          autoHighlight
          value={value?.directory ?? null}
          onValueChange={pick}
          onItemHighlighted={(directory) => {
            highlighted.current = typeof directory === "string" ? directory : null;
          }}
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setQuery("");
          }}
        >
          <ComboboxTrigger
            aria-label="Agent"
            render={<Button variant="outline" />}
            className="w-full justify-between"
          >
            {repository && agent ? (
              <span className="truncate">
                <PathSegments segments={[repository.name, ...agent.label.split("/")]} />
              </span>
            ) : (
              <span className="text-muted-foreground">Choose an agent</span>
            )}
            <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" />
          </ComboboxTrigger>
          <ComboboxPopup align="start" side="bottom">
            <ComboboxSearchInput
              aria-label="Search agents"
              placeholder="Search agents and variants"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // Enter in the search box does not pick the highlighted row by itself, as in BranchPicker.
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                const directory = highlighted.current;
                if (directory === null || !keys.includes(directory)) return;
                event.preventDefault();
                pick(directory);
                setOpen(false);
                setQuery("");
              }}
            />
            <ComboboxList className="max-h-80">
              {filtered.length === 0 ? (
                <p className="p-2 text-muted-foreground text-xs">No agent matches.</p>
              ) : (
                filtered.map((group, groupIndex) => (
                  <ComboboxGroup key={group.path}>
                    {groupIndex > 0 ? <Separator className="my-1" /> : null}
                    <ComboboxGroupLabel>
                      <span className="flex min-w-0 items-center gap-2">
                        <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="shrink-0 font-semibold text-foreground text-sm">
                          {group.name}
                        </span>
                        <span className="ms-auto min-w-0 font-mono font-normal text-3xs">
                          <MiddleTruncate value={tildePath(group.path, homeDirectory)} />
                        </span>
                      </span>
                    </ComboboxGroupLabel>
                    {group.agents.map((candidate) => (
                      <ComboboxItem
                        key={candidate.directory}
                        index={keys.indexOf(candidate.directory)}
                        value={candidate.directory}
                        className="ms-6"
                      >
                        <span className="truncate">
                          <PathSegments segments={candidate.label.split("/")} />
                        </span>
                        {candidate.agentName !== null && candidate.agentName !== candidate.label ? (
                          <span className="truncate text-muted-foreground text-xs">
                            {candidate.agentName}
                          </span>
                        ) : null}
                        {candidate.manifests.length > 1 ? (
                          <span className="ms-auto shrink-0 text-muted-foreground text-xs">
                            {candidate.manifests.length} variants
                          </span>
                        ) : null}
                      </ComboboxItem>
                    ))}
                  </ComboboxGroup>
                ))
              )}
            </ComboboxList>
          </ComboboxPopup>
        </Combobox>
        {value !== null && (agent?.manifests.length ?? 0) <= 1 ? (
          <ManifestPath manifest={value} />
        ) : null}
      </div>
      {value !== null && agent !== undefined && agent.manifests.length > 1 ? (
        <div className="grid gap-1.5">
          <Label>Variant</Label>
          <ToggleGroup
            aria-label="Variant"
            className="flex-wrap"
            value={[value.path]}
            onValueChange={(next) => {
              const manifest = agent.manifests.find((candidate) => candidate.path === next[0]);
              if (manifest) onValueChange(manifest);
            }}
          >
            {agent.manifests.map((candidate) => (
              <Toggle key={candidate.path} value={candidate.path}>
                {candidate.variant ?? "default"}
              </Toggle>
            ))}
          </ToggleGroup>
          <ManifestPath manifest={value} />
        </div>
      ) : null}
    </>
  );
}

/** Separates a repository and its folders alike, so the levels read as one path. */
function PathSegments({ segments }: { segments: ReadonlyArray<string> }) {
  return segments.map((segment, index) => (
    <Fragment key={segments.slice(0, index + 1).join("/")}>
      {index > 0 ? <span className="text-muted-foreground"> / </span> : null}
      {segment}
    </Fragment>
  ));
}

function ManifestPath({ manifest }: { manifest: AgentctlSandboxManifest }) {
  return (
    <span className="min-w-0 font-mono text-muted-foreground text-xs">
      <MiddleTruncate value={manifestRelativePath(manifest)} />
    </span>
  );
}
