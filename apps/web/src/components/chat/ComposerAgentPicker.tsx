import type { EnvironmentId, ProjectAgent, ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { BotIcon, ChevronUpIcon } from "lucide-react";

import { setComposerAgent, useComposerAgent } from "../../composerAgentStore";
import { useServerConfigs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { composerFloatingLayerProps } from "./composerEventScope";

const DEFAULT_VALUE = "";

/**
 * Picks who the composer's messages go to: Default, or a named agent the user defined. A named
 * agent answers in this thread on its own model, with no delegation step.
 */
export function ComposerAgentPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: ScopedThreadRef;
  readonly cwd: string | null;
  readonly onPickAgent: (agent: ProjectAgent) => void;
}) {
  const gt = useGT();
  const supported =
    useServerConfigs().get(props.environmentId)?.environment.capabilities.namedAgentChat === true;
  const agents =
    useEnvironmentQuery(
      supported
        ? projectEnvironment.listAgents({
            environmentId: props.environmentId,
            input: props.cwd === null ? {} : { cwd: props.cwd },
          })
        : null,
    ).data?.agents ?? [];
  const selected = useComposerAgent(props.thread);
  if (!supported || (agents.length === 0 && selected === null)) return null;
  const label = selected ?? gt("Default", { $context: "the usual chat, with no named agent" });
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            data-composer-agent-trigger
            aria-label={gt("Agent: {agent}", { agent: label })}
            className="flex h-7 max-w-36 cursor-pointer items-center gap-1.5 rounded-md px-2 text-muted-foreground text-xs outline-none hover:bg-foreground/[0.09] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:bg-foreground/[0.09] data-popup-open:text-foreground"
          />
        }
      >
        <BotIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
        <ChevronUpIcon aria-hidden="true" className="size-3 shrink-0" />
      </MenuTrigger>
      <MenuPopup side="top" align="start" className="max-w-72" {...composerFloatingLayerProps}>
        <MenuRadioGroup
          aria-label={gt("Agent")}
          value={selected ?? DEFAULT_VALUE}
          onValueChange={(next: string) => {
            if (next === (selected ?? DEFAULT_VALUE)) return;
            if (next === DEFAULT_VALUE) {
              setComposerAgent(props.thread, null);
              return;
            }
            const agent = agents.find((candidate) => candidate.name === next);
            if (agent === undefined) return;
            setComposerAgent(props.thread, agent.name);
            props.onPickAgent(agent);
          }}
        >
          <AgentChoice
            value={DEFAULT_VALUE}
            name={gt("Default", { $context: "the usual chat, with no named agent" })}
            description={gt("The usual chat. Ask it to delegate when you want an agent.")}
          />
          {agents.map((agent) => (
            <AgentChoice
              key={agent.name}
              value={agent.name}
              name={agent.name}
              description={agent.description}
            />
          ))}
          {selected !== null && !agents.some((agent) => agent.name === selected) ? (
            <AgentChoice
              value={selected}
              name={selected}
              description={gt("No longer defined. Messages go without its instructions.")}
            />
          ) : null}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function AgentChoice(props: {
  readonly value: string;
  readonly name: string;
  readonly description: string;
}) {
  return (
    <MenuRadioItem value={props.value} closeOnClick>
      <span className="flex items-center gap-3">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{props.name}</span>
          {props.description === "" ? null : (
            <span className="line-clamp-2 text-muted-foreground text-xs">{props.description}</span>
          )}
        </span>
        <MenuRadioItemIndicator />
      </span>
    </MenuRadioItem>
  );
}
