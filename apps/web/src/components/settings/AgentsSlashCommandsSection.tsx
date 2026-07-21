import { useAtomValue } from "@effect/atom-react";
import type { ProviderInstanceId } from "@t3tools/contracts";
import { BotIcon, ChevronDownIcon, ChevronUpIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { memo, useCallback, useMemo } from "react";

import {
  collectComposerSlashCommandSources,
  formatComposerSlashCommandDisplayName,
  resolveComposerSlashCommandDescription,
} from "~/lib/composerSlashCommands";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { primaryServerProvidersAtom } from "~/state/server";
import { cn } from "~/lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";

export const AgentsSlashCommandsSection = memo(function AgentsSlashCommandsSection(props: {
  embedded?: boolean;
  searchQuery?: string;
}) {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);

  const agentCommands = useMemo(() => {
    const sources = collectComposerSlashCommandSources(serverProviders, {
      hiddenSlashCommandsByProvider: settings.hiddenProviderSlashCommands,
    }).filter((source) => source.command.sourceKind === "agents");

    const providersById = new Map(
      serverProviders.map((provider) => [provider.instanceId, provider] as const),
    );

    const groupsByCommandName = new Map<
      string,
      {
        command: (typeof sources)[number]["command"];
        providerIds: Set<ProviderInstanceId>;
      }
    >();

    for (const source of sources) {
      const provider = providersById.get(source.providerInstanceId);
      if (!provider) continue;
      const normalizedName = source.command.name.trim().toLowerCase();
      if (!normalizedName) continue;

      const existing = groupsByCommandName.get(normalizedName);
      if (existing) {
        existing.providerIds.add(provider.instanceId);
      } else {
        groupsByCommandName.set(normalizedName, {
          command: source.command,
          providerIds: new Set([provider.instanceId]),
        });
      }
    }

    return [...groupsByCommandName.values()].map((group) => ({
      command: group.command,
      providers: [...group.providerIds]
        .map((providerId) => providersById.get(providerId))
        .filter((provider): provider is (typeof serverProviders)[number] => provider !== undefined),
    }));
  }, [serverProviders, settings.hiddenProviderSlashCommands]);

  const normalizedQuery = props.searchQuery?.trim().toLowerCase() ?? "";
  const visibleAgentCommands = useMemo(() => {
    if (normalizedQuery.length === 0) return agentCommands;

    return agentCommands.filter(({ command, providers }) => {
      const title = formatComposerSlashCommandDisplayName(command).toLowerCase();
      const description = (resolveComposerSlashCommandDescription(command) ?? "")
        .trim()
        .toLowerCase();
      const providerLabel = providers
        .map((provider) => (provider.displayName ?? provider.driver).trim().toLowerCase())
        .join(" ");
      return (
        title.includes(normalizedQuery) ||
        description.includes(normalizedQuery) ||
        providerLabel.includes(normalizedQuery)
      );
    });
  }, [agentCommands, normalizedQuery]);

  const hiddenGlobalSlashCommands = settings.hiddenGlobalSlashCommands;

  const setGlobalCommandVisibility = useCallback(
    (commandName: string, isVisible: boolean) => {
      const normalizedName = commandName.trim().toLowerCase();
      const currentHidden = hiddenGlobalSlashCommands;
      const nextHidden = isVisible
        ? currentHidden.filter((value) => value.trim().toLowerCase() !== normalizedName)
        : currentHidden.some((value) => value.trim().toLowerCase() === normalizedName)
          ? currentHidden
          : [...currentHidden, commandName];
      updateSettings({ hiddenGlobalSlashCommands: nextHidden });
    },
    [hiddenGlobalSlashCommands, updateSettings],
  );

  const visibleAgentCommandCount = visibleAgentCommands.filter(({ command }) => {
    const normalizedName = command.name.trim().toLowerCase();
    return !hiddenGlobalSlashCommands.some(
      (value) => value.trim().toLowerCase() === normalizedName,
    );
  }).length;

  const isCollapsed = settings.collapsedAgentsSlashCommands;
  const setIsCollapsed = useCallback(
    (nextValue: boolean | ((current: boolean) => boolean)) => {
      const resolvedValue = typeof nextValue === "function" ? nextValue(isCollapsed) : nextValue;
      updateSettings({ collapsedAgentsSlashCommands: resolvedValue });
    },
    [isCollapsed, updateSettings],
  );

  const sectionContent = (
    <>
      <div className="divide-y divide-border/60">
        {visibleAgentCommands.length > 0 ? (
          visibleAgentCommands.map(({ command, providers }) => {
            const displayName = formatComposerSlashCommandDisplayName(command);
            const description =
              resolveComposerSlashCommandDescription(command) ?? "Shared agent command";
            const normalizedName = command.name.trim().toLowerCase();
            const isVisible = !hiddenGlobalSlashCommands.some(
              (value) => value.trim().toLowerCase() === normalizedName,
            );
            return (
              <div key={command.name} className={cn("bg-card/30", !isVisible && "bg-muted/20")}>
                <div className="flex items-center gap-2 border-b border-border/50 px-4 py-3.5 sm:px-5">
                  <BotIcon className="size-4 shrink-0 text-muted-foreground/80" />
                  <div className="min-w-0 flex-1">
                    <span className="truncate text-sm font-medium text-foreground">
                      {displayName}
                    </span>
                    <p className="truncate text-xs text-muted-foreground/75">{description}</p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {providers.map((provider) => (
                      <ProviderInstanceIcon
                        key={provider.instanceId}
                        driverKind={provider.driver}
                        displayName={provider.displayName ?? provider.driver}
                        className="size-5"
                        iconClassName="size-4"
                      />
                    ))}
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      className="size-6 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                      aria-label={`${isVisible ? "Disable" : "Enable"} ${displayName}`}
                      onClick={() => setGlobalCommandVisibility(command.name, !isVisible)}
                    >
                      {isVisible ? (
                        <EyeIcon className="size-4" />
                      ) : (
                        <EyeOffIcon className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            );
          })
        ) : (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground sm:px-5">
            {normalizedQuery.length > 0
              ? "No shared `.agents` commands match your search."
              : "No shared `.agents` commands were found."}
          </div>
        )}
      </div>
    </>
  );

  return props.embedded ? (
    <div className="overflow-hidden bg-card/30">
      <div className="flex items-center gap-2 border-b border-border/50 px-4 py-3.5 sm:px-5">
        <BotIcon className="size-4 text-foreground/70" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">Global</span>
            <span className="rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {visibleAgentCommandCount}
            </span>
          </div>
          <p className="text-xs text-muted-foreground/75">Shared `.agents` commands</p>
        </div>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="size-6 rounded-sm p-0 text-muted-foreground hover:text-foreground"
          aria-label={`${isCollapsed ? "Expand" : "Collapse"} global commands`}
          onClick={() => setIsCollapsed((current) => !current)}
        >
          {isCollapsed ? (
            <ChevronDownIcon className="size-4" />
          ) : (
            <ChevronUpIcon className="size-4" />
          )}
        </Button>
      </div>
      {isCollapsed ? null : sectionContent}
    </div>
  ) : (
    <SettingsSection
      title="Global"
      icon={<BotIcon className="size-4 text-foreground/70" />}
      className="overflow-hidden"
    >
      <div className="border-b border-border/60 px-4 py-3.5 sm:px-5">
        <p className="text-[13px] font-medium tracking-[-0.01em] text-foreground">
          Shared `.agents` commands
        </p>
        <p className="text-xs text-muted-foreground/80">
          Commands sourced from your shared `.agents` folder appear here once, even if multiple
          providers expose them.
        </p>
      </div>
      {sectionContent}
    </SettingsSection>
  );
});
