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
import { type FormEvent, useEffect, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isConfiguredAcpRegistryAgent } from "./AddProviderInstanceDialog.logic";
import { AcpRegistryAgentIcon } from "./AcpRegistryIcon";

const SUGGESTED_SEARCHES = ["Codex", "Copilot", "Kimi"] as const;
function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The ACP could not be prepared.";
}

function authorDisplayName(author: string): string {
  // Registry authors may be "Name <email>" package-style strings.
  return author.replace(/<[^>]*>/g, "").trim();
}

function authorSummary(authors: ReadonlyArray<string>): string | null {
  const names = authors.map(authorDisplayName).filter((name) => name.length > 0);
  const first = names[0];
  if (!first) return null;
  return names.length === 1 ? first : `${first} +${names.length - 1}`;
}

function metadata(entry: AcpRegistrySearchAgent): ReadonlyArray<string> {
  return [authorSummary(entry.authors), entry.distribution, entry.license].filter(
    (value): value is string => Boolean(value),
  );
}

interface AcpRegistrySearchStepProps {
  readonly environmentId: EnvironmentId;
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly onPrepared: (agent: AcpRegistrySearchAgent) => void;
  readonly onManualConfiguration: () => void;
}

export function applyAcpRegistryPrepareResult(
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
    },
    [],
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
    const result = await prepareAgent({ environmentId, input: { agentId: agent.id } });
    if (prepareGeneration.current !== generation) return;
    setPreparingId(null);
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

  return (
    <section className="grid gap-3" aria-labelledby="acp-registry-search-heading">
      <div>
        <h3 className="text-sm font-medium text-foreground" id="acp-registry-search-heading">
          Find an ACP agent
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Search compatible agents in the official ACP Registry for this environment.
        </p>
      </div>

      <form className="flex gap-2" onSubmit={handleSearch}>
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search ACP Registry"
            autoFocus
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search by agent, author, or description"
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

      {!isInitialSearch ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Try</span>
          {SUGGESTED_SEARCHES.map((suggestion) => (
            <Button
              key={suggestion}
              disabled={search.isPending || preparingId !== null}
              onClick={() => submitSearch(suggestion)}
              size="xs"
              variant="ghost"
            >
              {suggestion}
            </Button>
          ))}
        </div>
      ) : null}

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
        <div
          aria-live="polite"
          className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {prepareError ?? search.error}
        </div>
      ) : null}

      {isInitialSearch ? (
        <div className="flex min-h-20 items-center justify-center text-sm text-muted-foreground">
          Searching the registry...
        </div>
      ) : null}

      {isRefreshing ? (
        <p className="text-xs text-muted-foreground">Refreshing registry results...</p>
      ) : null}

      {results ? (
        results.length === 0 ? (
          <div className="flex min-h-28 flex-col items-center justify-center rounded-2xl border border-dashed px-4 text-center">
            <p className="text-sm font-medium">No compatible agents found</p>
            <p className="mt-1 text-xs text-muted-foreground">Try a broader search.</p>
          </div>
        ) : (
          <ScrollArea scrollFade className="max-h-72 border-t border-border/70">
            {/* The overlay scrollbar takes no layout space, so the rows
                reserve its lane explicitly. */}
            <div className="divide-y divide-border/70 pr-2.5">
              {results.map((agent) => {
                const alreadyAdded = isConfiguredAcpRegistryAgent(providerInstances, agent.id);
                const isPreparing = preparingId === agent.id;
                const progressLabel = agent.distribution === "binary" ? "Downloading" : "Preparing";
                return (
                  <article className="grid min-w-0 gap-2 py-3 first:pt-2 last:pb-2" key={agent.id}>
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        <AcpRegistryAgentIcon icon={agent.icon} />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-baseline gap-2">
                            <h4 className="min-w-0 truncate text-sm font-medium text-foreground">
                              {agent.name}
                            </h4>
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              {`v${agent.version}`}
                            </span>
                          </div>
                          <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-muted-foreground">
                            {agent.description ||
                              "An agent available through the official ACP Registry."}
                          </p>
                        </div>
                      </div>
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
                    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground [&>*+*]:before:mr-1.5 [&>*+*]:before:content-['·']">
                      {metadata(agent).map((item) => (
                        <span key={item}>{item}</span>
                      ))}
                      {agent.integrity === "sha256" ? (
                        <Tooltip>
                          <TooltipTrigger render={<span>✓ checksum</span>} />
                          <TooltipPopup>
                            Binary checksum is verified against the registry
                          </TooltipPopup>
                        </Tooltip>
                      ) : null}
                      {agent.website ? (
                        <a
                          aria-label={`Open documentation for ${agent.name} (${agent.id})`}
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          href={agent.website}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Docs <ExternalLinkIcon className="size-3" />
                        </a>
                      ) : null}
                      {agent.repository ? (
                        <a
                          aria-label={`Open source for ${agent.name} (${agent.id})`}
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          href={agent.repository}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Source <ExternalLinkIcon className="size-3" />
                        </a>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </ScrollArea>
        )
      ) : null}

      {/* DialogPanel collapses its own bottom padding when the dialog footer
          is bare, so this row carries the breathing room itself. */}
      <div className="flex items-center justify-between gap-3 border-t border-border/70 py-3">
        <p className="text-[11px] text-muted-foreground">
          Authentication is completed separately with the selected agent.
        </p>
        <Button
          disabled={preparingId !== null}
          onClick={onManualConfiguration}
          size="xs"
          variant="ghost"
        >
          Configure manually
        </Button>
      </div>
    </section>
  );
}
