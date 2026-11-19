import { memo } from "react";
import { BotIcon, ChevronDownIcon } from "lucide-react";
import type { AgentId, AgentSummary } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

const EMPTY_AGENTS: ReadonlyArray<AgentSummary> = [];

const CONTROL_DEFAULT = "control:default";
const CONTROL_NONE = "control:none";
const AGENT_PREFIX = "agent:";

export interface AgentPickerMenuContentProps {
  agents?: ReadonlyArray<AgentSummary> | undefined;
  selectedAgentId?: AgentId | null | undefined;
  defaultAgentId?: AgentId | null | undefined;
  /** `undefined` inherits the project default; `null` explicitly selects none. */
  onSelectAgent: (agentId: AgentId | null | undefined) => void;
  allowNone?: boolean | undefined;
  allowDefault?: boolean | undefined;
  noneLabel?: string | undefined;
  noneDescription?: string | undefined;
  defaultLabel?: string | undefined;
  defaultDescription?: string | undefined;
  getAgentDisabledReason?: ((agentId: AgentId) => string | null | undefined) | undefined;
}

export function AgentPickerMenuContent({
  agents = EMPTY_AGENTS,
  selectedAgentId,
  defaultAgentId = null,
  onSelectAgent,
  allowNone = false,
  allowDefault = true,
  noneLabel = "No custom agent",
  noneDescription = "Ignore the project default for this thread.",
  defaultLabel = "Project default",
  defaultDescription,
  getAgentDisabledReason,
}: AgentPickerMenuContentProps) {
  const defaultAgent = defaultAgentId
    ? (agents.find((agent) => agent.id === defaultAgentId) ?? null)
    : null;

  const handleValueChange = (value: string) => {
    if (!value || value === CONTROL_DEFAULT) {
      onSelectAgent(undefined);
    } else if (value === CONTROL_NONE) {
      onSelectAgent(null);
    } else if (value.startsWith(AGENT_PREFIX)) {
      onSelectAgent(value.slice(AGENT_PREFIX.length) as AgentId);
    }
  };

  const selectedValue =
    selectedAgentId === undefined
      ? CONTROL_DEFAULT
      : selectedAgentId === null
        ? allowNone
          ? CONTROL_NONE
          : CONTROL_DEFAULT
        : `${AGENT_PREFIX}${selectedAgentId}`;

  return (
    <MenuGroup>
      <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
        Custom Agents
      </div>
      <MenuRadioGroup value={selectedValue} onValueChange={handleValueChange}>
        {allowDefault ? (
          <MenuRadioItem value={CONTROL_DEFAULT} hideIndicator closeOnClick>
            <div className="flex w-full min-w-0 flex-col py-0.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium truncate">{defaultLabel}</span>
                {defaultAgent ? (
                  <Badge variant="outline" size="sm">
                    Inherits
                  </Badge>
                ) : null}
              </div>
              <span className="text-muted-foreground text-xs">
                {defaultDescription ??
                  (defaultAgent
                    ? `Uses ${defaultAgent.name} for new threads.`
                    : "Uses the project setting; no custom agent is configured.")}
              </span>
            </div>
          </MenuRadioItem>
        ) : null}

        {allowNone ? (
          <MenuRadioItem value={CONTROL_NONE} hideIndicator closeOnClick>
            <div className="flex w-full min-w-0 flex-col py-0.5">
              <span className="font-medium truncate">{noneLabel}</span>
              {noneDescription ? (
                <span className="text-muted-foreground text-xs">{noneDescription}</span>
              ) : null}
            </div>
          </MenuRadioItem>
        ) : null}

        {agents.length > 0 && (allowDefault || allowNone) ? <MenuDivider /> : null}

        {agents.map((agent) => {
          const isDefault = agent.id === defaultAgentId;
          const disabledReason = getAgentDisabledReason?.(agent.id) ?? null;
          return (
            <MenuRadioItem
              key={agent.id}
              value={`${AGENT_PREFIX}${agent.id}`}
              disabled={disabledReason !== null}
              title={disabledReason ?? undefined}
              hideIndicator
              closeOnClick
            >
              <div className="flex w-full min-w-0 flex-col py-0.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium truncate">{agent.name}</span>
                  <div className="flex items-center gap-1">
                    {isDefault ? (
                      <Badge variant="secondary" size="sm">
                        Default
                      </Badge>
                    ) : null}
                    {agent.tier ? (
                      <Badge variant="outline" size="sm">
                        {agent.tier === "economy" ? "Economy" : "Reasoning"}
                      </Badge>
                    ) : null}
                    {agent.model ? (
                      <Badge
                        variant="outline"
                        size="sm"
                        title={`Fixed model: ${agent.model.model}`}
                      >
                        {agent.model.model}
                      </Badge>
                    ) : null}
                  </div>
                </div>
                {agent.description ? (
                  <span className="text-muted-foreground text-xs line-clamp-2">
                    {agent.description}
                  </span>
                ) : null}
              </div>
            </MenuRadioItem>
          );
        })}

        {agents.length === 0 ? (
          <div className="px-2 py-2 text-muted-foreground text-xs">
            No custom agents found in .agents/, .github/agents/, or AGENTS.md
          </div>
        ) : null}
        <div className="px-2 py-2 text-muted-foreground text-xs">
          An explicit composer model choice wins. Without a configured model or tier, the agent
          inherits the selected model. Instructions are sent on its first provider turn.
        </div>
      </MenuRadioGroup>
    </MenuGroup>
  );
}

export interface AgentPickerProps extends AgentPickerMenuContentProps {
  size?: ComposerControlSize | undefined;
  disabled?: boolean | undefined;
  hidden?: boolean | undefined;
  className?: string | undefined;
  triggerClassName?: string | undefined;
  triggerLabel?: string | undefined;
}

export const AgentPicker = memo(function AgentPicker({
  agents = EMPTY_AGENTS,
  selectedAgentId,
  defaultAgentId = null,
  onSelectAgent,
  allowNone = false,
  allowDefault = true,
  noneLabel = "No custom agent",
  noneDescription,
  defaultLabel,
  defaultDescription,
  getAgentDisabledReason,
  size = "sm",
  disabled = false,
  hidden = false,
  className,
  triggerClassName,
  triggerLabel: propsTriggerLabel,
}: AgentPickerProps) {
  const [open, setOpen] = useComposerMenuState(hidden);
  const menuProps = useComposerMenuProps();

  const activeAgent = selectedAgentId
    ? (agents.find((agent) => agent.id === selectedAgentId) ?? null)
    : null;

  const defaultAgent = defaultAgentId
    ? (agents.find((agent) => agent.id === defaultAgentId) ?? null)
    : null;

  const triggerLabel =
    propsTriggerLabel ??
    (activeAgent
      ? activeAgent.name
      : allowNone && selectedAgentId === null
        ? noneLabel
        : defaultAgent
          ? `${defaultAgent.name} (Default)`
          : "Agent");

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            size={size}
            disabled={disabled}
            className={cn("gap-1.5", triggerClassName, className)}
            aria-label="Select custom agent"
          />
        }
      >
        <ComposerControlIcon icon={BotIcon} size={size} />
        <span data-composer-control-label className="max-w-28 truncate text-left sm:max-w-36">
          {triggerLabel}
        </span>
        {propsTriggerLabel === undefined && activeAgent?.tier ? (
          <Badge variant="outline" size="sm" className="hidden sm:inline-flex">
            {activeAgent.tier === "economy" ? "Economy" : "Reasoning"}
          </Badge>
        ) : null}
        <ComposerControlIcon icon={ChevronDownIcon} size={size} />
      </MenuTrigger>

      <MenuPopup align="start" {...menuProps} className="w-64 max-w-[calc(100vw-2rem)]">
        <AgentPickerMenuContent
          agents={agents}
          selectedAgentId={selectedAgentId}
          defaultAgentId={defaultAgentId}
          onSelectAgent={onSelectAgent}
          allowNone={allowNone}
          allowDefault={allowDefault}
          noneLabel={noneLabel}
          noneDescription={noneDescription}
          defaultLabel={defaultLabel}
          defaultDescription={defaultDescription}
          getAgentDisabledReason={getAgentDisabledReason}
        />
      </MenuPopup>
    </Menu>
  );
});
