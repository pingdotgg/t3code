import { GraduationCapIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type {
  HermesSkillEntry,
  HermesSkillsProviderProjection,
  HermesSkillsReloadResponse,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import type { EnvironmentPresentation } from "../../state/environments";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { randomUUID } from "../../lib/utils";
import {
  formatSkillNames,
  formatSkillsReloadSummary,
  skillsBlockedDiagnostic,
  skillsNegotiationFooter,
} from "./HermesSkillsSettings.logic";

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

interface InspectState {
  readonly name: string;
  readonly info: Record<string, unknown>;
}

function HermesSkillsProviderSection({
  environment,
  provider,
  reloading,
  onReload,
}: {
  readonly environment: EnvironmentPresentation;
  readonly provider: HermesSkillsProviderProjection;
  readonly reloading: boolean;
  readonly onReload: (provider: HermesSkillsProviderProjection) => void;
}) {
  const search = useAtomCommand(serverEnvironment.searchHermesSkills, {
    label: "Hermes skills search",
  });
  const inspect = useAtomCommand(serverEnvironment.inspectHermesSkill, {
    label: "Hermes skills inspect",
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<ReadonlyArray<HermesSkillEntry> | null>(null);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [inspectState, setInspectState] = useState<InspectState | null>(null);

  const runSearch = useCallback(async () => {
    if (searching || !searchQuery.trim()) return;
    setSearching(true);
    const result = await search({
      environmentId: environment.environmentId,
      input: { providerInstanceId: provider.providerInstanceId, query: searchQuery.trim() },
    });
    setSearching(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Hermes skills search failed", squashAtomCommandFailure(result));
      }
      return;
    }
    setSearchResults(result.value.results);
  }, [environment, provider.providerInstanceId, search, searchQuery, searching]);

  const runInspect = useCallback(
    async (name: string) => {
      if (inspecting !== null) return;
      setInspecting(name);
      const result = await inspect({
        environmentId: environment.environmentId,
        input: { providerInstanceId: provider.providerInstanceId, name },
      });
      setInspecting(null);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportFailure("Hermes skill inspect failed", squashAtomCommandFailure(result));
        }
        return;
      }
      setInspectState({ name, info: result.value.info });
    },
    [environment, inspect, inspecting, provider.providerInstanceId],
  );

  const blocked = skillsBlockedDiagnostic(provider);
  return (
    <section className="space-y-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{provider.displayName}</h3>
        <Badge variant={provider.status === "ready" ? "success" : "outline"}>
          {provider.status}
        </Badge>
        <span className="text-[11px] text-muted-foreground">Profile {provider.profileKey}</span>
        {provider.capabilities.reload ? (
          <Button
            size="xs"
            variant="outline"
            className="ml-auto"
            disabled={reloading}
            onClick={() => onReload(provider)}
          >
            <RefreshCwIcon className="size-3.5" />
            {reloading ? "Reloading…" : "Reload skills"}
          </Button>
        ) : null}
      </div>
      {provider.diagnostics.map((diagnostic) => (
        <p key={diagnostic} className="text-[11px] text-muted-foreground">
          {diagnostic}
        </p>
      ))}
      {blocked !== null ? null : (
        <>
          {provider.skills.length === 0 ? (
            <p className="py-3 text-xs text-muted-foreground">No skills are installed.</p>
          ) : (
            <div className="space-y-2">
              {provider.skills.map((skill) => (
                <div
                  key={skill.name}
                  className="grid gap-3 rounded-md border border-border/70 p-3 sm:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0 space-y-1">
                    <span className="truncate text-sm font-medium">{skill.name}</span>
                    {skill.description ? (
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {skill.description}
                      </p>
                    ) : null}
                  </div>
                  {provider.capabilities.inspect ? (
                    <div className="flex items-start">
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={inspecting !== null}
                        onClick={() => void runInspect(skill.name)}
                      >
                        {inspecting === skill.name ? "Inspecting…" : "Inspect"}
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
          {provider.capabilities.search ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Input
                  placeholder="Search the skills hub"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void runSearch();
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={searching || !searchQuery.trim()}
                  onClick={() => void runSearch()}
                >
                  <SearchIcon className="size-3.5" />
                  {searching ? "Searching…" : "Search"}
                </Button>
              </div>
              {searchResults === null ? null : searchResults.length === 0 ? (
                <p className="text-xs text-muted-foreground">No skills hub results.</p>
              ) : (
                <div className="space-y-2">
                  {searchResults.map((entry) => (
                    <div
                      key={entry.name}
                      className="grid gap-3 rounded-md border border-border/70 p-3 sm:grid-cols-[minmax(0,1fr)_auto]"
                    >
                      <div className="min-w-0 space-y-1">
                        <span className="truncate text-sm font-medium">{entry.name}</span>
                        {entry.description ? (
                          <p className="line-clamp-2 text-xs text-muted-foreground">
                            {entry.description}
                          </p>
                        ) : null}
                      </div>
                      {provider.capabilities.inspect ? (
                        <div className="flex items-start">
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={inspecting !== null}
                            onClick={() => void runInspect(entry.name)}
                          >
                            {inspecting === entry.name ? "Inspecting…" : "Inspect"}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </>
      )}

      <Dialog open={inspectState !== null} onOpenChange={(open) => !open && setInspectState(null)}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{inspectState?.name}</DialogTitle>
            <DialogDescription>Skill details reported by the Hermes skills hub.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <pre className="max-h-80 overflow-auto rounded-md border border-border/70 p-3 font-mono text-[11px]">
              {inspectState === null ? "" : JSON.stringify(inspectState.info, null, 2)}
            </pre>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>Close</DialogClose>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </section>
  );
}

export function HermesSkillsSettings() {
  const environment = usePrimaryEnvironment();
  const query = useEnvironmentQuery(
    environment
      ? serverEnvironment.hermesSkills({
          environmentId: environment.environmentId,
          input: {},
        })
      : null,
  );
  const reload = useAtomCommand(serverEnvironment.reloadHermesSkills, {
    label: "Hermes skills reload",
  });
  const [reloading, setReloading] = useState(false);
  const providers = query.data?.providers ?? [];
  const negotiationFooter = useMemo(() => skillsNegotiationFooter(providers), [providers]);

  const reportReload = useCallback((value: HermesSkillsReloadResponse) => {
    const added = formatSkillNames(value.added);
    const removed = formatSkillNames(value.removed);
    toastManager.add({
      type: "success",
      title: "Hermes skills reloaded",
      description: [
        formatSkillsReloadSummary(value),
        added === null ? null : `Added: ${added}`,
        removed === null ? null : `Removed: ${removed}`,
      ]
        .filter((part) => part !== null)
        .join(". "),
    });
  }, []);

  const runReload = useCallback(
    async (provider: HermesSkillsProviderProjection) => {
      if (!environment || reloading) return;
      setReloading(true);
      const result = await reload({
        environmentId: environment.environmentId,
        input: { providerInstanceId: provider.providerInstanceId, operationId: randomUUID() },
      });
      setReloading(false);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportFailure("Hermes skills reload failed", squashAtomCommandFailure(result));
        }
        return;
      }
      reportReload(result.value);
      query.refresh();
    },
    [environment, query, reload, reloading, reportReload],
  );

  return (
    <SettingsPageContainer className="max-w-4xl">
      <SettingsSection title="Hermes skills" icon={<GraduationCapIcon className="size-3.5" />}>
        <div className="border-b border-border/60 px-5 py-3 text-xs text-muted-foreground">
          Skills are read and reloaded directly in Hermes. Installing skills from the hub is not
          available from T3.
        </div>
        {query.error ? (
          <div className="px-5 py-4 text-xs text-destructive">{query.error}</div>
        ) : query.isPending && providers.length === 0 ? (
          <div className="px-5 py-8 text-center text-xs text-muted-foreground">
            Loading Hermes skills inventory…
          </div>
        ) : providers.length === 0 || !environment ? (
          <div className="px-5 py-8 text-center text-xs text-muted-foreground">
            No Hermes provider instances are configured.
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {providers.map((provider) => (
              <HermesSkillsProviderSection
                key={`${environment.environmentId}:${provider.providerInstanceId}`}
                environment={environment}
                provider={provider}
                reloading={reloading}
                onReload={(target) => void runReload(target)}
              />
            ))}
          </div>
        )}
        {negotiationFooter !== null ? (
          <div className="px-5 py-3 text-xs text-muted-foreground">{negotiationFooter}</div>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
