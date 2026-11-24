import { pipe } from "effect/Function";
import {
  ACP_REGISTRY_MAX_AGENTS,
  ACP_REGISTRY_SEARCH_QUERY_MAX_LENGTH,
  AuthProvidersManageScope,
} from "@t3tools/contracts";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AcpRegistryPrepareResult,
  AcpRegistrySearchAgent,
  EnvironmentId,
  ProviderInstanceConfig,
} from "@t3tools/contracts";
import { ExternalLinkIcon, SearchIcon } from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { type FormEvent, useState } from "react";

import { useDeadlinePassed } from "../../hooks/useDeadline";
import { m } from "../../i18n/messages";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isConfiguredAcpRegistryAgent } from "./AddProviderInstanceDialog.logic";
import { ProviderDriverKind } from "@t3tools/contracts";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "./providerDriverMeta";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : m(msg("The ACP could not be prepared."));
}

const ACP_REGISTRY_SEARCH_DEBOUNCE_MS = 300;
const FIRST_CLASS_REGISTRY_AGENT_IDS = new Set(
  providerClients.definitions.flatMap((definition) => definition.acpRegistryAgentIds ?? []),
);

function applyAcpRegistryPrepareResult(
  agent: AcpRegistrySearchAgent,
  prepared: AcpRegistryPrepareResult,
): AcpRegistrySearchAgent {
  return {
    ...agent,
    id: prepared.agentId,
    version: prepared.version,
    distribution: prepared.distribution,
  };
}

/**
 * Registry search and agent preparation. Owned by the dialog, which needs the
 * loading and preparing state for its layout and navigation, and rendered by
 * AcpRegistrySearchStep. Pass `enabled: false` while the step is hidden so the
 * search is not kept subscribed.
 */
export function useAcpRegistrySearch(environmentId: EnvironmentId, enabled: boolean) {
  const [input, setInput] = useState<{
    readonly text: string;
    readonly submitted: string;
    readonly typedAt: number | null;
  }>({ text: "", submitted: "", typedAt: null });
  const typingSettled = useDeadlinePassed(
    input.typedAt === null ? null : input.typedAt + ACP_REGISTRY_SEARCH_DEBOUNCE_MS,
  );
  const submittedQuery = typingSettled ? input.text.trim() : input.submitted;
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const search = useEnvironmentQuery(
    enabled
      ? serverEnvironment.searchAcpRegistry({
          environmentId,
          input: submittedQuery
            ? { query: submittedQuery }
            : { query: "", limit: ACP_REGISTRY_MAX_AGENTS },
        })
      : null,
    useMessages(),
  );
  const prepareAgent = useAtomCommand(serverEnvironment.prepareAcpRegistryAgent, {
    reportFailure: false,
  });

  return {
    query: input.text,
    search,
    preparingId,
    prepareError,
    type: (text: string) => {
      setPrepareError(null);
      setInput({
        text: text.slice(0, ACP_REGISTRY_SEARCH_QUERY_MAX_LENGTH),
        submitted: submittedQuery,
        typedAt: Date.now(),
      });
    },
    submit: () => {
      const trimmed = input.text.trim();
      setPrepareError(null);
      setInput({ text: trimmed, submitted: trimmed, typedAt: null });
      if (trimmed === submittedQuery) search.refresh();
    },
    prepare: async (
      agent: AcpRegistrySearchAgent,
      onPrepared: (agent: AcpRegistrySearchAgent) => void,
    ) => {
      if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
      setPrepareError(null);
      setPreparingId(agent.id);
      const result = await prepareAgent({ environmentId, input: { agentId: agent.id } });
      setPreparingId(null);
      if (result._tag === "Success") {
        onPrepared(applyAcpRegistryPrepareResult(agent, result.value));
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        pipe(squashAtomCommandFailure(result), errorMessage, setPrepareError);
      }
    },
  };
}

export type AcpRegistrySearch = ReturnType<typeof useAcpRegistrySearch>;

interface AcpRegistrySearchStepProps {
  readonly environmentId: EnvironmentId;
  readonly registry: AcpRegistrySearch;
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly onPrepared: (agent: AcpRegistrySearchAgent) => void;
  readonly onManualConfiguration: () => void;
  readonly onLocalConfiguration?: () => void;
}

export function AcpRegistrySearchStep({
  environmentId,
  registry,
  providerInstances,
  onPrepared,
  onManualConfiguration,
  onLocalConfiguration,
}: AcpRegistrySearchStepProps) {
  const gt = useGT();
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const { query, search, preparingId, prepareError } = registry;

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    registry.submit();
  };

  const handlePrepare = (agent: AcpRegistrySearchAgent) => {
    void registry.prepare(agent, onPrepared);
  };

  const results =
    search.data?.agents.filter((agent) => !FIRST_CLASS_REGISTRY_AGENT_IDS.has(agent.id)) ?? null;
  const isInitialSearch = search.isPending && results === null;
  const isRefreshing = search.isPending && results !== null;
  const resultCount = results?.length ?? 0;

  return (
    <section className="grid gap-3" aria-labelledby="acp-registry-search-heading">
      <h3 className="sr-only" id="acp-registry-search-heading">
        <T>Choose an agent</T>
      </h3>

      <form className="flex flex-wrap items-center gap-2" onSubmit={handleSearch}>
        <InputGroup className="min-w-40 flex-1">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          {/* Native search inputs clear on Escape even during IME composition. */}
          <InputGroupInput
            aria-label={gt("Search ACP Registry")}
            maxLength={ACP_REGISTRY_SEARCH_QUERY_MAX_LENGTH}
            disabled={preparingId !== null}
            enterKeyHint="search"
            onChange={(event) => registry.type(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || event.defaultPrevented) return;
              if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
              const composing = event.nativeEvent.isComposing || event.keyCode === 229;
              if (!composing && !query && !event.repeat) return;
              event.stopPropagation();
              if (composing) return;
              event.preventDefault();
              if (query) registry.type("");
            }}
            placeholder={gt("Search agents…")}
            role="searchbox"
            size="sm"
            type="text"
            value={query}
          />
        </InputGroup>
        <Button
          disabled={preparingId !== null}
          onClick={onManualConfiguration}
          size="sm"
          type="button"
          variant="secondary"
        >
          <T>Enter manually</T>
        </Button>
        {onLocalConfiguration ? (
          <Button
            disabled={preparingId !== null}
            onClick={onLocalConfiguration}
            size="sm"
            type="button"
            variant="secondary"
          >
            <T>Local ACP command</T>
          </Button>
        ) : null}
      </form>

      <div className="sr-only" role="status">
        {isInitialSearch
          ? gt("Searching the ACP Registry.")
          : isRefreshing
            ? gt("Refreshing ACP Registry results.")
            : results
              ? gt(
                  "{count, plural, one {{count} compatible agent found.} other {{count} compatible agents found.}}",
                  { count: resultCount },
                )
              : ""}
      </div>

      {search.error || prepareError ? (
        <Alert variant="error" role="status" aria-live="polite">
          <AlertDescription>{prepareError ?? search.error}</AlertDescription>
        </Alert>
      ) : null}

      {isInitialSearch ? (
        <div className="flex min-h-20 items-center justify-center text-sm text-muted-foreground">
          <T>Searching the registry...</T>
        </div>
      ) : null}

      {results ? (
        results.length === 0 ? (
          <div className="flex min-h-28 flex-col items-center justify-center rounded-card border border-dashed border-border surface-card-settings px-4 text-center">
            <p className="text-sm font-medium">
              <T>No compatible agents found</T>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              <T>Try a broader search.</T>
            </p>
          </div>
        ) : (
          <ScrollArea scrollFade className="max-h-64">
            <div className="pr-2.5">
              {results.map((agent) => (
                <AcpRegistryAgentRow
                  agent={agent}
                  alreadyAdded={isConfiguredAcpRegistryAgent(providerInstances, agent.id)}
                  canAdd={canManageProviders && preparingId === null}
                  isPreparing={preparingId === agent.id}
                  key={agent.id}
                  onAdd={handlePrepare}
                />
              ))}
            </div>
          </ScrollArea>
        )
      ) : null}
    </section>
  );
}

function AcpRegistryAgentRow({
  agent,
  alreadyAdded,
  canAdd,
  isPreparing,
  onAdd,
}: {
  readonly agent: AcpRegistrySearchAgent;
  readonly alreadyAdded: boolean;
  readonly canAdd: boolean;
  readonly isPreparing: boolean;
  readonly onAdd: (agent: AcpRegistrySearchAgent) => void;
}) {
  const gt = useGT();
  const progressLabel = agent.distribution === "binary" ? gt("Downloading") : gt("Preparing");
  const aboutUrl = agent.website || agent.repository;
  return (
    <article className="min-w-0 py-2.5">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <ProviderInstanceIcon
            driverKind={ProviderDriverKind.make("acpRegistry")}
            displayName={agent.name}
            acpRegistryAgentId={agent.id}
            acpRegistryIconUrl={agent.icon ?? undefined}
            iconClassName="size-6 rounded-md text-muted-foreground"
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-2">
              <h4 className="min-w-0 truncate text-sm font-medium text-strong-foreground">
                {agent.name}
              </h4>
            </div>
            {agent.description ? (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{agent.description}</p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {aboutUrl ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="secondary"
                    aria-label={gt("About {name}", { name: agent.name })}
                    render={<a href={aboutUrl} target="_blank" rel="noreferrer" />}
                  >
                    <ExternalLinkIcon />
                  </Button>
                }
              />
              <TooltipPopup>
                <T>
                  About <Var>{agent.name}</Var>
                </T>
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <Button
            aria-label={
              alreadyAdded
                ? gt("Already added {name}", { name: agent.name })
                : isPreparing
                  ? agent.distribution === "binary"
                    ? gt("Downloading {name}", { name: agent.name })
                    : gt("Preparing {name}", { name: agent.name })
                  : gt("Add {name}", { name: agent.name })
            }
            disabled={!canAdd || alreadyAdded}
            onClick={() => onAdd(agent)}
            size="xs"
            variant={isPreparing ? "secondary" : "secondary"}
          >
            {alreadyAdded
              ? gt("Added")
              : isPreparing
                ? progressLabel
                : gt("Add", { $context: "verb, adds an agent" })}
          </Button>
        </div>
      </div>
    </article>
  );
}
