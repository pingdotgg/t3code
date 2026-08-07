import type {
  AgentProfileRef,
  AgentProfileSummary,
  EnvironmentId,
  ModelSelection,
  ProjectId,
} from "@t3tools/contracts";
import { BotIcon, CheckIcon, SearchIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { agentEnvironment } from "../../state/agents";
import { useEnvironmentQuery } from "../../state/query";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "../ui/combobox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  agentProfilePickerLabel,
  filterAgentProfiles,
  selectChatAgentProfiles,
} from "./AgentProfilePicker.logic";
import { ComposerControl, ComposerControlChevron } from "./ComposerControl";

const NONE = "none";
const profileKey = (profile: Pick<AgentProfileSummary, "scope" | "id">) =>
  `${profile.scope}:${profile.id}`;

function toRef(profile: AgentProfileSummary): AgentProfileRef {
  return {
    id: profile.id,
    scope: profile.scope,
    revision: profile.revision,
  };
}

/** The catalog stays server-owned so the picker behaves the same over relay and tunnel connections. */
export const AgentProfilePicker = memo(function AgentProfilePicker(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  value: AgentProfileRef | null;
  compact?: boolean;
  disabled?: boolean;
  onChange: (profile: AgentProfileRef | null, defaultModel: ModelSelection | null) => void;
}) {
  const selectedValue = props.value;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const catalog = useEnvironmentQuery(
    agentEnvironment.catalog({
      environmentId: props.environmentId,
      input:
        props.projectId === null
          ? { includeArchived: true }
          : { includeArchived: true, projectId: props.projectId },
    }),
  );
  const profiles = useMemo(() => {
    const catalogProfiles = catalog.data?.profiles ?? [];
    const selectedProfile =
      selectedValue === null
        ? null
        : (catalogProfiles.find(
            (profile) => profile.id === selectedValue.id && profile.scope === selectedValue.scope,
          ) ?? null);
    return Array.from(selectChatAgentProfiles(catalogProfiles, selectedProfile)).sort(
      (left, right) =>
        Number(right.scope === "project") - Number(left.scope === "project") ||
        left.name.localeCompare(right.name),
    );
  }, [catalog.data?.profiles, selectedValue]);
  const filteredProfiles = useMemo(() => filterAgentProfiles(profiles, query), [profiles, query]);
  const projectProfiles = filteredProfiles.filter((profile) => profile.scope === "project");
  const environmentProfiles = filteredProfiles.filter((profile) => profile.scope === "environment");
  const selected =
    selectedValue === null
      ? null
      : (profiles.find(
          (profile) => profile.id === selectedValue.id && profile.scope === selectedValue.scope,
        ) ?? null);

  const selectedKey = selectedValue === null ? NONE : `${selectedValue.scope}:${selectedValue.id}`;
  const label = agentProfilePickerLabel(
    selected,
    selectedValue,
    catalog.isPending,
    catalog.data !== null,
  );
  const noneMatches =
    query.trim().length === 0 || /standard|no agent|model|default|build/i.test(query.trim());
  const allKeys = [NONE, ...profiles.map(profileKey)];
  const filteredKeys = [...(noneMatches ? [NONE] : []), ...filteredProfiles.map(profileKey)];

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  // Do not add permanent composer chrome until the user has configured an agent.
  if (profiles.length === 0 && selectedValue === null) return null;

  const choose = (value: string) => {
    if (value === NONE) {
      props.onChange(null, null);
      setOpen(false);
      return;
    }
    const profile = profiles.find((candidate) => profileKey(candidate) === value);
    if (!profile) return;
    props.onChange(toRef(profile), profile.defaultModelSelection);
    setOpen(false);
  };

  const renderProfile = (profile: AgentProfileSummary) => {
    const key = profileKey(profile);
    return (
      <ComboboxItem key={key} value={key} className="gap-2 py-2">
        <BotIcon aria-hidden="true" className="size-4" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{profile.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {profile.description || profile.id}
          </span>
        </span>
        {selectedKey === key ? (
          <CheckIcon aria-hidden="true" className="size-4 text-foreground" />
        ) : null}
      </ComboboxItem>
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (props.disabled) {
          setOpen(false);
          return;
        }
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger
        render={
          <ComposerControl
            type="button"
            aria-label={`Chat with agent: ${label}`}
            data-chat-agent-picker="true"
            className={
              props.compact ? "max-w-40 shrink-0" : "max-w-48 shrink min-w-0 whitespace-nowrap"
            }
            disabled={props.disabled || catalog.isPending}
          />
        }
      >
        <BotIcon aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ComposerControlChevron />
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        side="top"
        className="border-0 bg-transparent p-0 shadow-none before:hidden [-webkit-backdrop-filter:none]! [--viewport-inline-padding:0] [backdrop-filter:none]!"
        viewportClassName="rounded-lg !overflow-hidden p-0"
      >
        <div className="dropdown-glass relative flex max-h-96 w-screen max-w-84 flex-col overflow-hidden rounded-lg text-popover-foreground">
          <Combobox
            inline
            items={allKeys}
            filteredItems={filteredKeys}
            filter={null}
            autoHighlight
            open
            value={selectedKey}
            onValueChange={(value) => {
              if (typeof value === "string") choose(value);
            }}
          >
            <div className="border-b border-border/70 p-2">
              <ComboboxInput
                ref={searchInputRef}
                aria-label="Search agents"
                className="[&_input]:h-7 [&_input]:font-sans"
                inputClassName="bg-transparent text-sm"
                placeholder="Search agents..."
                showTrigger={false}
                startAddon={
                  <SearchIcon className="size-4 shrink-0 text-muted-foreground opacity-70" />
                }
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpen(false);
                  }
                }}
              />
            </div>
            <ComboboxList className="max-h-80">
              <ComboboxEmpty>No matching agents.</ComboboxEmpty>
              {noneMatches ? (
                <ComboboxGroup>
                  <ComboboxGroupLabel>Standard</ComboboxGroupLabel>
                  <ComboboxItem value={NONE} className="gap-2 py-2">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium">No agent</span>
                      <span className="truncate text-xs text-muted-foreground">
                        Chat directly with the selected model
                      </span>
                    </span>
                    {selectedKey === NONE ? (
                      <CheckIcon aria-hidden="true" className="size-4 text-foreground" />
                    ) : null}
                  </ComboboxItem>
                </ComboboxGroup>
              ) : null}
              {projectProfiles.length > 0 ? (
                <ComboboxGroup>
                  <ComboboxGroupLabel>Project agents</ComboboxGroupLabel>
                  {projectProfiles.map(renderProfile)}
                </ComboboxGroup>
              ) : null}
              {environmentProfiles.length > 0 ? (
                <ComboboxGroup>
                  <ComboboxGroupLabel>Environment agents</ComboboxGroupLabel>
                  {environmentProfiles.map(renderProfile)}
                </ComboboxGroup>
              ) : null}
            </ComboboxList>
          </Combobox>
        </div>
      </PopoverPopup>
    </Popover>
  );
});
