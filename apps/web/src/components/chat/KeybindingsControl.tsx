import {
  KeybindingRule as KeybindingRuleSchema,
  type KeybindingCommand,
  type ResolvedKeybindingsConfig,
  type ServerConfig,
} from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { KeyboardIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import {
  defaultShortcutValuesForCommand,
  defaultWhenForCommand,
  primaryDefaultShortcutValueForCommand,
  STATIC_KEYBINDING_DEFINITIONS,
  STATIC_KEYBINDING_SECTIONS,
  keybindingValueForCommand,
  keybindingValueFromEvent,
  shortcutLabelsForCommand,
} from "~/keybindings";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";

const INVALID_KEYBINDING_MESSAGE = "Enter a valid shortcut with at least one modifier key.";

const SECTION_ACCENTS = {
  workspace: "before:bg-sky-500/65",
  chat: "before:bg-emerald-500/65",
  terminal: "before:bg-amber-500/65",
} as const;

function buildDraftValues(
  keybindings: ResolvedKeybindingsConfig,
): Record<KeybindingCommand, string> {
  return Object.fromEntries(
    STATIC_KEYBINDING_DEFINITIONS.map((definition) => [
      definition.command,
      keybindingValueForCommand(keybindings, definition.command) ??
        primaryDefaultShortcutValueForCommand(definition.command) ??
        "",
    ]),
  ) as Record<KeybindingCommand, string>;
}

interface KeybindingsControlProps {
  keybindings: ResolvedKeybindingsConfig;
  triggerLabel?: string;
  triggerClassName?: string;
}

export function KeybindingsControl({
  keybindings,
  triggerLabel = "Keys",
  triggerClassName,
}: KeybindingsControlProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draftValues, setDraftValues] = useState<Record<KeybindingCommand, string>>(
    buildDraftValues(keybindings),
  );
  const [savingCommand, setSavingCommand] = useState<KeybindingCommand | null>(null);
  const [errorByCommand, setErrorByCommand] = useState<Partial<Record<KeybindingCommand, string>>>(
    {},
  );

  useEffect(() => {
    if (!open) return;
    setDraftValues(buildDraftValues(keybindings));
    setErrorByCommand({});
  }, [keybindings, open]);

  const sections = useMemo(
    () =>
      STATIC_KEYBINDING_SECTIONS.map((section) => ({
        id: section.id,
        title: section.title,
        description: section.description,
        definitions: STATIC_KEYBINDING_DEFINITIONS.filter(
          (definition) => definition.section === section.id,
        ),
      })),
    [],
  );

  const updateDraftValue = (command: KeybindingCommand, value: string) => {
    setDraftValues((current) => ({
      ...current,
      [command]: value,
    }));
    setErrorByCommand((current) => ({
      ...current,
      [command]: undefined,
    }));
  };

  const saveShortcut = async (command: KeybindingCommand) => {
    const nextValue =
      draftValues[command]?.trim() || primaryDefaultShortcutValueForCommand(command) || "";
    const when = defaultWhenForCommand(command);
    const decoded = Schema.decodeUnknownOption(KeybindingRuleSchema)({
      key: nextValue,
      command,
      ...(when ? { when } : {}),
    });

    if (decoded._tag === "None") {
      setErrorByCommand((current) => ({
        ...current,
        [command]: INVALID_KEYBINDING_MESSAGE,
      }));
      return;
    }

    setSavingCommand(command);
    try {
      const api = ensureNativeApi();
      const result = await api.server.upsertKeybinding(decoded.value);
      queryClient.setQueryData<ServerConfig>(serverQueryKeys.config(), (current) =>
        current
          ? {
              ...current,
              keybindings: result.keybindings,
              issues: result.issues,
            }
          : current,
      );
      await queryClient.invalidateQueries({ queryKey: serverQueryKeys.all });
    } catch (error) {
      setErrorByCommand((current) => ({
        ...current,
        [command]: error instanceof Error ? error.message : "Unable to save shortcut.",
      }));
    } finally {
      setSavingCommand(null);
    }
  };

  return (
    <>
      <Button
        size="xs"
        variant="outline"
        className={cn("shrink-0", triggerClassName)}
        aria-label="Open keybindings"
        onClick={() => setOpen(true)}
      >
        <KeyboardIcon className="size-3.5" />
        <span>{triggerLabel}</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-6xl">
          <DialogHeader>
            <DialogTitle>Keybindings</DialogTitle>
            <DialogDescription>
              Review active shortcuts, update them inline, or restore a command to its default
              shortcut. Press a shortcut into any field and use Backspace to reset.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-6" scrollFade={false}>
            {sections.map((section) => (
              <section key={section.id} className="space-y-3">
                <div>
                  <h3 className="text-sm font-medium text-foreground">{section.title}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">{section.description}</p>
                </div>

                <div className="overflow-x-auto rounded-2xl border border-border/70 bg-background/60">
                  <div className="hidden min-w-[920px] grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.35fr)_auto] gap-4 border-b border-border/70 px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground md:grid">
                    <div>Action</div>
                    <div>Current</div>
                    <div>Default</div>
                    <div>Edit</div>
                    <div>Apply</div>
                  </div>

                  <div className="min-w-[920px] divide-y divide-border/70 md:min-w-[920px]">
                    {section.definitions.map((definition) => {
                      const currentLabels = shortcutLabelsForCommand(
                        keybindings,
                        definition.command,
                      );
                      const defaultValues = defaultShortcutValuesForCommand(definition.command);
                      const draftValue = draftValues[definition.command] ?? "";
                      const normalizedDraftValue = draftValue.trim();
                      const currentValue = keybindingValueForCommand(
                        keybindings,
                        definition.command,
                      );
                      const willReplaceMany = currentLabels.length > 1 || defaultValues.length > 1;
                      const canSave =
                        normalizedDraftValue.length > 0 && normalizedDraftValue !== currentValue;
                      const isSaving = savingCommand === definition.command;
                      const error = errorByCommand[definition.command];

                      return (
                        <div
                          key={definition.command}
                          className={cn(
                            "relative grid grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.35fr)_auto] gap-4 px-5 py-4 before:absolute before:bottom-3 before:left-0 before:top-3 before:w-px",
                            SECTION_ACCENTS[section.id],
                          )}
                        >
                          <div className="min-w-0 space-y-2">
                            <div className="text-sm font-medium text-foreground">
                              {definition.title}
                            </div>
                            <p className="text-sm text-muted-foreground">
                              {definition.description}
                            </p>
                            <code className="inline-flex rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                              {definition.command}
                            </code>
                          </div>

                          <div className="min-w-0 space-y-2">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground md:hidden">
                              Current
                            </div>
                            <div className="flex min-h-10 flex-wrap gap-2">
                              {currentLabels.length > 0 ? (
                                currentLabels.map((label) => <Kbd key={label}>{label}</Kbd>)
                              ) : (
                                <span className="text-sm text-muted-foreground">None</span>
                              )}
                            </div>
                            {willReplaceMany ? (
                              <p className="text-xs text-muted-foreground">
                                Saving here replaces all active shortcuts for this command with one
                                binding.
                              </p>
                            ) : null}
                          </div>

                          <div className="min-w-0 space-y-2">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground md:hidden">
                              Default
                            </div>
                            <div className="flex min-h-10 flex-wrap gap-2">
                              {defaultValues.map((value) => (
                                <Kbd key={value}>{value}</Kbd>
                              ))}
                            </div>
                          </div>

                          <div className="min-w-0 space-y-2">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground md:hidden">
                              Edit
                            </div>
                            <Input
                              value={draftValue}
                              readOnly
                              className="font-mono text-sm"
                              onKeyDown={(event) => {
                                if (event.key === "Tab") return;
                                event.preventDefault();
                                if (event.key === "Backspace" || event.key === "Delete") {
                                  updateDraftValue(
                                    definition.command,
                                    primaryDefaultShortcutValueForCommand(definition.command) ?? "",
                                  );
                                  return;
                                }

                                const nextValue = keybindingValueFromEvent(
                                  event,
                                  navigator.platform,
                                );
                                if (!nextValue) return;
                                updateDraftValue(definition.command, nextValue);
                              }}
                            />
                            <p className="text-xs text-muted-foreground">
                              Press a shortcut. Use Backspace to restore default.
                            </p>
                            {error ? <p className="text-xs text-destructive">{error}</p> : null}
                          </div>

                          <div className="flex min-w-36 flex-col gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                updateDraftValue(
                                  definition.command,
                                  primaryDefaultShortcutValueForCommand(definition.command) ?? "",
                                )
                              }
                            >
                              Restore default
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              disabled={!canSave || isSaving}
                              onClick={() => {
                                void saveShortcut(definition.command);
                              }}
                            >
                              {isSaving ? "Saving..." : "Save shortcut"}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </section>
            ))}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
