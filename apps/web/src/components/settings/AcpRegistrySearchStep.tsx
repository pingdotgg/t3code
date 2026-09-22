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
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

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

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The ACP could not be prepared.";
}

interface AcpRegistrySearchStepProps {
  readonly environmentId: EnvironmentId;
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly onPrepared: (agent: AcpRegistrySearchAgent) => void;
  readonly onManualConfiguration: () => void;
  readonly onLoadingChange?: (loading: boolean) => void;
  readonly onPreparingChange?: (preparing: boolean) => void;
}

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

export function AcpRegistrySearchStep({
  environmentId,
  providerInstances,
  onPrepared,
  onManualConfiguration,
  onLoadingChange,
  onPreparingChange,
}: AcpRegistrySearchStepProps) {
  const [query, setQuery] = useState("");
  // An empty registry query is the compact compatible catalog. Start there so
  // entering this step is useful before the user knows what to search for.
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const prepareGeneration = useRef(0);
  const search = useEnvironmentQuery(
    serverEnvironment.searchAcpRegistry({
      environmentId,
      input: { query: submittedQuery },
    }),
  );
  const prepareAgent = useAtomCommand(serverEnvironment.prepareAcpRegistryAgent, {
    reportFailure: false,
  });

  useEffect(
    () => () => {
      prepareGeneration.current += 1;
      onPreparingChange?.(false);
    },
    [onPreparingChange],
  );

  const submitSearch = (nextQuery: string) => {
    const trimmed = nextQuery.trim();
    setQuery(trimmed);
    setPrepareError(null);
    if (trimmed === submittedQuery) {
      search.refresh();
    } else {
      setSubmittedQuery(trimmed);
    }
  };

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitSearch(query);
  };

  const handlePrepare = async (agent: AcpRegistrySearchAgent) => {
    const generation = ++prepareGeneration.current;
    setPrepareError(null);
    setPreparingId(agent.id);
    onPreparingChange?.(true);
    const result = await prepareAgent({ environmentId, input: { agentId: agent.id } });
    if (prepareGeneration.current !== generation) return;
    setPreparingId(null);
    onPreparingChange?.(false);
    if (result._tag === "Success") {
      onPrepared(applyAcpRegistryPrepareResult(agent, result.value));
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setPrepareError(errorMessage(squashAtomCommandFailure(result)));
    }
  };

  const results = search.data?.agents ?? null;
  const isInitialSearch = search.isPending && results === null;
  const isRefreshing = search.isPending && results !== null;
  const resultCount = results?.length ?? 0;

  useLayoutEffect(() => {
    onLoadingChange?.(search.isPending);
    return () => onLoadingChange?.(false);
  }, [onLoadingChange, search.isPending]);

  return (
    <section className="grid gap-3" aria-labelledby="acp-registry-search-heading">
      <h3 className="sr-only" id="acp-registry-search-heading">
        Choose an agent
      </h3>

      <form className="flex gap-2" onSubmit={handleSearch}>
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search ACP Registry"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search agents…"
            size="sm"
            type="search"
            value={query}
          />
        </InputGroup>
        <Button
          disabled={search.isPending || preparingId !== null}
          size="sm"
          type="submit"
          variant="outline"
        >
          {isRefreshing ? "Refreshing" : "Search"}
        </Button>
      </form>

      <div className="sr-only" role="status">
        {isInitialSearch
          ? "Searching the ACP Registry."
          : isRefreshing
            ? "Refreshing ACP Registry results."
            : results
              ? `${resultCount} compatible ${resultCount === 1 ? "agent" : "agents"} found.`
              : ""}
      </div>

      {search.error || prepareError ? (
        <Alert variant="error" role="status" aria-live="polite">
          <AlertDescription>{prepareError ?? search.error}</AlertDescription>
        </Alert>
      ) : null}

      {isInitialSearch ? (
        <div className="flex min-h-20 items-center justify-center text-sm text-muted-foreground">
          Searching the registry...
        </div>
      ) : null}

      {results ? (
        results.length === 0 ? (
          <div className="flex min-h-28 flex-col items-center justify-center rounded-2xl border border-dashed px-4 text-center">
            <p className="text-sm font-medium">No compatible agents found</p>
            <p className="mt-1 text-xs text-muted-foreground">Try a broader search.</p>
          </div>
        ) : (
          <ScrollArea scrollFade className="max-h-48">
            {/* The overlay scrollbar takes no layout space, so the rows
                reserve its lane explicitly. */}
            <div className="pr-2.5">
              {results.map((agent) => {
                const alreadyAdded = isConfiguredAcpRegistryAgent(providerInstances, agent.id);
                const isPreparing = preparingId === agent.id;
                const progressLabel = agent.distribution === "binary" ? "Downloading" : "Preparing";
                return (
                  <article className="min-w-0 py-2.5" key={agent.id}>
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
                            <h4 className="min-w-0 truncate text-sm font-medium text-foreground">
                              {agent.name}
                            </h4>
                          </div>
                          {agent.description ? (
                            <p className="mt-0.5 truncate text-xs text-muted-foreground">
                              {agent.description}
                            </p>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {agent.website || agent.repository ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  size="icon-xs"
                                  variant="ghost-muted"
                                  aria-label={`About ${agent.name}`}
                                  render={
                                    <a
                                      href={agent.website || agent.repository || undefined}
                                      target="_blank"
                                      rel="noreferrer"
                                    />
                                  }
                                >
                                  <ExternalLinkIcon />
                                </Button>
                              }
                            />
                            <TooltipPopup>About {agent.name}</TooltipPopup>
                          </Tooltip>
                        ) : null}
                        <Button
                          aria-label={`${alreadyAdded ? "Already added" : isPreparing ? progressLabel : "Add"} ${agent.name}`}
                          disabled={alreadyAdded || preparingId !== null}
                          onClick={() => void handlePrepare(agent)}
                          size="xs"
                          variant={isPreparing ? "secondary" : "outline"}
                        >
                          {alreadyAdded ? "Added" : isPreparing ? progressLabel : "Add"}
                        </Button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </ScrollArea>
        )
      ) : null}

      <div className="flex justify-end">
        <Button
          disabled={preparingId !== null}
          onClick={onManualConfiguration}
          size="xs"
          variant="ghost"
        >
          Enter manually
        </Button>
      </div>
    </section>
  );
}
