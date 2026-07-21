import { useAtomValue } from "@effect/atom-react";
import type { ProviderInstanceId } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronUpIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import {
  collectComposerSlashCommandSources,
  formatComposerSlashCommandDisplayName,
  resolveComposerSlashCommandDescription,
} from "~/lib/composerSlashCommands";
import { formatProviderDisplayName } from "~/lib/contextWindow";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { primaryServerProvidersAtom } from "~/state/server";
import { cn } from "~/lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsSection } from "./settingsLayout";
import { AgentsSlashCommandsSection } from "./AgentsSlashCommandsSection";
import { CustomSlashCommandsSection } from "./CustomSlashCommandsSection";

function matchesSlashCommandSearch(value: string, query: string): boolean {
  if (!query) return true;
  return value.toLowerCase().includes(query);
}

export const ProviderSlashCommandsSection = memo(function ProviderSlashCommandsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const [query, setQuery] = useState("");
  const collapsedProviders = useMemo(
    () => new Set(settings.collapsedProviderSlashCommandProviders),
    [settings.collapsedProviderSlashCommandProviders],
  );

  const visibleGroups = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const sources = collectComposerSlashCommandSources(serverProviders);
    const sourcesByProvider = new Map<ProviderInstanceId, typeof sources>();

    for (const source of sources) {
      const providerSources = sourcesByProvider.get(source.providerInstanceId);
      if (providerSources) {
        providerSources.push(source);
      } else {
        sourcesByProvider.set(source.providerInstanceId, [source]);
      }
    }

    return serverProviders
      .filter((provider) => provider.enabled && provider.installed)
      .flatMap((provider) => {
        const providerSources = sourcesByProvider.get(provider.instanceId) ?? [];
        const matchingSources = providerSources.filter((source) => {
          if (!normalizedQuery) return true;
          const commandName = formatComposerSlashCommandDisplayName(source.command);
          const description = resolveComposerSlashCommandDescription(source.command) ?? "";
          return (
            matchesSlashCommandSearch(provider.displayName ?? provider.driver, normalizedQuery) ||
            matchesSlashCommandSearch(commandName, normalizedQuery) ||
            matchesSlashCommandSearch(description, normalizedQuery)
          );
        });

        if (matchingSources.length === 0) {
          return [];
        }

        return [{ provider, sources: matchingSources }];
      });
  }, [query, serverProviders]);

  const hiddenSlashCommandsByProvider = settings.hiddenProviderSlashCommands;
  const visibleCount = visibleGroups.reduce((count, group) => count + group.sources.length, 0);

  const setCommandVisibility = useCallback(
    (providerId: ProviderInstanceId, commandName: string, isVisible: boolean) => {
      const normalizedName = commandName.trim().toLowerCase();
      const currentHidden: ReadonlyArray<string> = hiddenSlashCommandsByProvider[providerId] ?? [];
      const nextHidden = isVisible
        ? currentHidden.filter((value: string) => value.trim().toLowerCase() !== normalizedName)
        : currentHidden.some((value) => value.trim().toLowerCase() === normalizedName)
          ? currentHidden
          : [...currentHidden, commandName];
      const nextMap = { ...hiddenSlashCommandsByProvider };
      if (nextHidden.length > 0) {
        nextMap[providerId] = nextHidden;
      } else {
        delete nextMap[providerId];
      }
      updateSettings({ hiddenProviderSlashCommands: nextMap });
    },
    [hiddenSlashCommandsByProvider, updateSettings],
  );

  const setAllCommandsVisibility = useCallback(
    (
      providerId: ProviderInstanceId,
      sources: ReadonlyArray<{ command: { name: string } }>,
      isVisible: boolean,
    ) => {
      const nextHidden = isVisible ? [] : sources.map((source) => source.command.name);
      const nextMap = { ...hiddenSlashCommandsByProvider };
      if (nextHidden.length > 0) {
        nextMap[providerId] = nextHidden;
      } else {
        delete nextMap[providerId];
      }
      updateSettings({ hiddenProviderSlashCommands: nextMap });
    },
    [hiddenSlashCommandsByProvider, updateSettings],
  );

  const toggleProviderCollapse = useCallback(
    (providerId: ProviderInstanceId) => {
      const current = settings.collapsedProviderSlashCommandProviders;
      const nextCollapsed = current.includes(providerId)
        ? current.filter((currentProviderId) => currentProviderId !== providerId)
        : [...current, providerId];
      updateSettings({ collapsedProviderSlashCommandProviders: nextCollapsed });
    },
    [settings.collapsedProviderSlashCommandProviders, updateSettings],
  );

  return (
    <SettingsSection title="Slash commands">
      <div className="border-b border-border/60 px-4 py-3.5 sm:px-5">
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-[13px] font-medium tracking-[-0.01em] text-foreground">
              Filter provider commands
            </p>
            <p className="text-xs text-muted-foreground/80">
              Toggle commands on or off per provider. Hidden commands will not appear in chat slash
              autocomplete.
            </p>
          </div>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search commands"
            className="w-full sm:w-80"
            aria-label="Search slash commands"
          />
        </div>
      </div>

      <CustomSlashCommandsSection embedded searchQuery={query} />
      <AgentsSlashCommandsSection embedded searchQuery={query} />

      <div className="divide-y divide-border/60">
        {visibleGroups.length > 0 ? (
          visibleGroups.map(({ provider, sources }) => {
            const providerLabel = formatProviderDisplayName(provider.driver);
            const providerHiddenCommands = hiddenSlashCommandsByProvider[provider.instanceId] ?? [];
            const isCollapsed = collapsedProviders.has(provider.instanceId);
            const allCommandsHidden = providerHiddenCommands.length === sources.length;
            const bulkButtonLabel = allCommandsHidden ? "Include all" : "Exclude all";
            const bulkButtonIcon = allCommandsHidden ? EyeIcon : EyeOffIcon;
            const HiddenBulkIcon = bulkButtonIcon;

            return (
              <div key={provider.instanceId} className="bg-card/30">
                <div className="flex items-center gap-2 border-b border-border/50 px-4 py-3.5 sm:px-5">
                  <ProviderInstanceIcon
                    driverKind={provider.driver}
                    displayName={provider.displayName ?? provider.driver}
                    className="size-5"
                    iconClassName="size-4"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {providerLabel}
                      </span>
                      <span className="rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                        {sources.length}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground/75">
                      {providerHiddenCommands.length > 0
                        ? `${providerHiddenCommands.length} hidden in chat`
                        : "All commands visible in chat"}
                    </p>
                  </div>

                  <div className="ml-auto flex items-center gap-1.5">
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      className="size-6 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                      aria-label={`${bulkButtonLabel} for ${providerLabel}`}
                      onClick={() =>
                        setAllCommandsVisibility(provider.instanceId, sources, allCommandsHidden)
                      }
                    >
                      <HiddenBulkIcon className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      className="size-6 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                      aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${providerLabel}`}
                      onClick={() => toggleProviderCollapse(provider.instanceId)}
                    >
                      {isCollapsed ? (
                        <ChevronDownIcon className="size-4" />
                      ) : (
                        <ChevronUpIcon className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>

                {isCollapsed ? null : (
                  <div className="divide-y divide-border/50">
                    {sources.map((source) => {
                      const commandName = source.command.name;
                      const isVisible = !providerHiddenCommands.some(
                        (hiddenCommand) =>
                          hiddenCommand.trim().toLowerCase() === commandName.trim().toLowerCase(),
                      );
                      const description =
                        resolveComposerSlashCommandDescription(source.command) ??
                        "Run provider command";

                      return (
                        <div
                          key={`${provider.instanceId}:${commandName}`}
                          className={cn(
                            "flex items-center gap-3 px-4 py-3.5 sm:px-5",
                            !isVisible && "bg-muted/20",
                          )}
                        >
                          <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-sm font-medium text-foreground">
                                {formatComposerSlashCommandDisplayName(source.command)}
                              </span>
                              {!isVisible ? (
                                <span className="rounded-full border border-border/60 bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                                  Hidden
                                </span>
                              ) : null}
                            </div>
                            <p className="truncate text-xs text-muted-foreground/80">
                              {description}
                            </p>
                          </div>

                          <Switch
                            checked={isVisible}
                            onCheckedChange={(checked) =>
                              setCommandVisibility(
                                provider.instanceId,
                                commandName,
                                Boolean(checked),
                              )
                            }
                            aria-label={`${isVisible ? "Disable" : "Enable"} ${commandName} for ${providerLabel}`}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">
            No slash commands match your search.
          </div>
        )}
      </div>
      {visibleCount > 0 ? (
        <div className="border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground/70 sm:px-5">
          Showing {visibleCount} command{visibleCount === 1 ? "" : "s"}
        </div>
      ) : null}
    </SettingsSection>
  );
});
