import { useAtomValue } from "@effect/atom-react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  EyeIcon,
  EyeOffIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import type { ComposerCustomSlashCommand } from "~/lib/composerSlashCommands";
import {
  collectComposerSlashCommands,
  formatComposerCustomSlashCommandName,
} from "~/lib/composerSlashCommands";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { randomUUID } from "~/lib/utils";
import { primaryServerProvidersAtom } from "~/state/server";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SettingsSection } from "./settingsLayout";
import { AppLogoIcon } from "../AppLogoIcon";

function normalizeCommandName(value: string): string {
  return formatComposerCustomSlashCommandName(value);
}

function createCustomSlashCommandId(): string {
  return randomUUID();
}

export const CustomSlashCommandsSection = memo(function CustomSlashCommandsSection(props: {
  embedded?: boolean;
  searchQuery?: string;
}) {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const customSlashCommands = settings.customSlashCommands;
  const hiddenCustomSlashCommands = settings.hiddenCustomSlashCommands;
  const existingCommandNames = useMemo(
    () =>
      new Set(
        collectComposerSlashCommands(serverProviders, {
          hiddenSlashCommandsByProvider: settings.hiddenProviderSlashCommands,
          customSlashCommands,
        }).map((command) => command.name.trim().toLowerCase()),
      ),
    [customSlashCommands, serverProviders, settings.hiddenProviderSlashCommands],
  );

  const resetDialog = useCallback(() => {
    setTitle("");
    setPrompt("");
    setSubmitted(false);
  }, []);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsAddDialogOpen(open);
      if (!open) {
        resetDialog();
      }
    },
    [resetDialog],
  );

  const normalizedTitle = title.trim();
  const normalizedPrompt = prompt.trim();
  const commandName = normalizeCommandName(normalizedTitle);
  const titleError = submitted && normalizedTitle.length === 0 ? "A title is required." : null;
  const promptError = submitted && normalizedPrompt.length === 0 ? "A prompt is required." : null;
  const duplicateError =
    submitted && commandName.length > 0 && existingCommandNames.has(commandName)
      ? "That command name is already in use."
      : null;

  const handleSave = useCallback(() => {
    setSubmitted(true);
    if (normalizedTitle.length === 0 || normalizedPrompt.length === 0 || commandName.length === 0) {
      return;
    }
    if (existingCommandNames.has(commandName)) {
      return;
    }

    const nextCommand: ComposerCustomSlashCommand = {
      id: createCustomSlashCommandId(),
      title: normalizedTitle,
      prompt: normalizedPrompt,
    };
    updateSettings({ customSlashCommands: [...customSlashCommands, nextCommand] });
    handleOpenChange(false);
  }, [
    commandName,
    customSlashCommands,
    existingCommandNames,
    handleOpenChange,
    normalizedPrompt,
    normalizedTitle,
    updateSettings,
  ]);

  const handleDelete = useCallback(
    (commandId: string) => {
      updateSettings({
        customSlashCommands: customSlashCommands.filter((command) => command.id !== commandId),
      });
    },
    [customSlashCommands, updateSettings],
  );

  const setCustomCommandVisibility = useCallback(
    (commandName: string, isVisible: boolean) => {
      const normalizedName = commandName.trim().toLowerCase();
      const currentHidden = hiddenCustomSlashCommands;
      const nextHidden = isVisible
        ? currentHidden.filter((value) => value.trim().toLowerCase() !== normalizedName)
        : currentHidden.some((value) => value.trim().toLowerCase() === normalizedName)
          ? currentHidden
          : [...currentHidden, commandName];
      updateSettings({ hiddenCustomSlashCommands: nextHidden });
    },
    [hiddenCustomSlashCommands, updateSettings],
  );

  const normalizedQuery = props.searchQuery?.trim().toLowerCase() ?? "";
  const visibleCustomSlashCommands = useMemo(
    () =>
      normalizedQuery.length > 0
        ? customSlashCommands.filter((command) => {
            const title = command.title.trim().toLowerCase();
            const prompt = command.prompt.trim().toLowerCase();
            return title.includes(normalizedQuery) || prompt.includes(normalizedQuery);
          })
        : customSlashCommands,
    [customSlashCommands, normalizedQuery],
  );

  const visibleCustomCommandCount = visibleCustomSlashCommands.filter((command) => {
    const normalizedName = normalizeCommandName(command.title);
    return !hiddenCustomSlashCommands.some(
      (value) => value.trim().toLowerCase() === normalizedName,
    );
  }).length;

  const isCollapsed = settings.collapsedCustomSlashCommands;
  const setIsCollapsed = useCallback(
    (nextValue: boolean | ((current: boolean) => boolean)) => {
      const resolvedValue = typeof nextValue === "function" ? nextValue(isCollapsed) : nextValue;
      updateSettings({ collapsedCustomSlashCommands: resolvedValue });
    },
    [isCollapsed, updateSettings],
  );

  const sectionContent = (
    <>
      <div className="divide-y divide-border/60">
        {visibleCustomSlashCommands.length > 0 ? (
          visibleCustomSlashCommands.map((command) => {
            const displayName = command.title.trim();
            const commandName = normalizeCommandName(displayName);
            const isVisible = !hiddenCustomSlashCommands.some(
              (value) => value.trim().toLowerCase() === commandName,
            );
            return (
              <div
                key={command.id}
                className={cn(
                  "flex items-start gap-3 px-4 py-3.5 sm:px-5",
                  !isVisible && "bg-muted/20",
                )}
              >
                <AppLogoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground/80" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {displayName}
                    </span>
                    <span className="rounded-full border border-border/60 bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Custom
                    </span>
                    {!isVisible ? (
                      <span className="rounded-full border border-border/60 bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                        Hidden
                      </span>
                    ) : null}
                  </div>
                  <p className="line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground/80">
                    {command.prompt}
                  </p>
                </div>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="size-6 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                  aria-label={`${isVisible ? "Disable" : "Enable"} ${displayName}`}
                  onClick={() => setCustomCommandVisibility(commandName, !isVisible)}
                >
                  {isVisible ? <EyeIcon className="size-4" /> : <EyeOffIcon className="size-4" />}
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="size-6 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                  aria-label={`Delete ${displayName}`}
                  onClick={() => handleDelete(command.id)}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
            );
          })
        ) : (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground sm:px-5">
            {normalizedQuery.length > 0
              ? "No custom slash commands match your search."
              : "Add a custom slash command for T3 Code prompts."}
          </div>
        )}
      </div>
    </>
  );

  return (
    <>
      {props.embedded ? (
        <div className="bg-card/30 overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border/50 px-4 py-3.5 sm:px-5">
            <AppLogoIcon className="size-4 text-foreground/70" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">Custom</span>
                <span className="rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  {visibleCustomCommandCount}
                </span>
              </div>
              <p className="text-xs text-muted-foreground/75">Reusable T3 Code prompts</p>
            </div>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="size-6 rounded-sm p-0 text-muted-foreground hover:text-foreground"
              aria-label="Add custom slash command"
              onClick={() => setIsAddDialogOpen(true)}
            >
              <PlusIcon className="size-4" />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="size-6 rounded-sm p-0 text-muted-foreground hover:text-foreground"
              aria-label={`${isCollapsed ? "Expand" : "Collapse"} custom commands`}
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
          title="Custom"
          icon={<AppLogoIcon className="size-4 text-foreground/70" />}
          headerAction={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="size-6 rounded-sm p-0 text-muted-foreground hover:text-foreground"
              aria-label="Add custom slash command"
              onClick={() => setIsAddDialogOpen(true)}
            >
              <PlusIcon className="size-4" />
            </Button>
          }
        >
          {sectionContent}
        </SettingsSection>
      )}

      <Dialog open={isAddDialogOpen} onOpenChange={handleOpenChange}>
        <DialogPopup className="max-w-lg overflow-hidden">
          <div className="flex min-h-0 flex-col overflow-hidden border-foreground/10 bg-background shadow-2xl">
            <DialogHeader className="border-b bg-background/90 px-5 py-4">
              <div className="flex items-center gap-2.5">
                <span className="inline-flex size-8 items-center justify-center rounded-xl border border-border/70 bg-muted/60 text-muted-foreground">
                  <AppLogoIcon className="size-4" />
                </span>
                <div className="min-w-0 space-y-0.5">
                  <DialogTitle>Add custom T3 command</DialogTitle>
                  <DialogDescription>
                    Save a reusable prompt that appears in slash command autocomplete.
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="grid gap-4 px-5 py-4">
              <label className="grid gap-2">
                <span className="text-sm font-medium text-foreground">Title</span>
                <Input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Improve Codebase Architecture"
                  aria-invalid={Boolean(titleError || duplicateError)}
                />
                {titleError ? <span className="text-xs text-destructive">{titleError}</span> : null}
                {duplicateError ? (
                  <span className="text-xs text-destructive">{duplicateError}</span>
                ) : null}
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-medium text-foreground">Prompt</span>
                <Textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Describe the behavior you want this command to run..."
                  rows={7}
                  aria-invalid={Boolean(promptError)}
                />
                {promptError ? (
                  <span className="text-xs text-destructive">{promptError}</span>
                ) : null}
              </label>
              <div className="text-xs text-muted-foreground/75">
                The command name is derived from the title, and custom entries are local to T3 Code.
              </div>
            </div>

            <DialogFooter className="border-t bg-background px-5 py-4">
              <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave}>
                Add command
              </Button>
            </DialogFooter>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
});
