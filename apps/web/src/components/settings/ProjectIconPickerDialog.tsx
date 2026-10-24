import * as Schema from "effect/Schema";
import { deriveProjectIdentity } from "../../projectIdentity";
import { ProjectMonogram } from "../ProjectMonogram";
import {
  ProjectMonogramText,
  type ProjectIconColor,
  type ProjectIconOverride,
} from "@t3tools/contracts";
import { createElement, useEffect, useRef, useState } from "react";
import {
  filterProjectIconNames,
  firstEmoji,
  normalizeProjectMonogramInput,
  projectIconSaveErrorMessage,
  PROJECT_EMOJIS,
  PROJECT_ICON_COLORS,
  projectIconColorClassName,
} from "../../projectIconOptions";
import { cn } from "~/lib/utils";
import { lucideIconByName } from "../../lib/lucideIconByName";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const DEFAULT_ICON = "folder-code";
const isMonogramText = Schema.is(ProjectMonogramText);

function PickerIcon({ name }: { name: string }) {
  const icon = lucideIconByName(name);
  return icon ? createElement(icon, { className: "size-5" }) : null;
}

function iconLabel(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function ProjectIconPickerDialog({
  current,
  projectName,
  open,
  onOpenChange,
  onSelect,
}: {
  readonly current: ProjectIconOverride | null;
  readonly projectName: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (icon: ProjectIconOverride) => Promise<void>;
}) {
  const automatic = deriveProjectIdentity(projectName);
  const [mode, setMode] = useState<ProjectIconOverride["kind"]>(current?.kind ?? "lucide");
  const [iconName, setIconName] = useState<string>(
    current?.kind === "lucide" ? current.name : DEFAULT_ICON,
  );
  const [color, setColor] = useState<ProjectIconColor>(
    current && current.kind !== "emoji" ? current.color : automatic.color,
  );
  const [letters, setLetters] = useState(
    current?.kind === "monogram" ? current.text : automatic.monogram,
  );
  const [emoji, setEmoji] = useState(current?.kind === "emoji" ? current.emoji : "💻");
  const [query, setQuery] = useState("");
  const [customEmoji, setCustomEmoji] = useState("");
  const previousOpenRef = useRef(false);
  const composingRef = useRef(false);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (open && !previousOpenRef.current) {
      setMode(current?.kind ?? "lucide");
      setIconName(current?.kind === "lucide" ? current.name : DEFAULT_ICON);
      setColor(current && current.kind !== "emoji" ? current.color : automatic.color);
      setLetters(current?.kind === "monogram" ? current.text : automatic.monogram);
      setEmoji(current?.kind === "emoji" ? current.emoji : "💻");
      setQuery("");
      setCustomEmoji("");
      setSaveError(null);
    }
    previousOpenRef.current = open;
  }, [current, open, automatic.color, automatic.monogram]);

  const icons = filterProjectIconNames(query);
  const selectedColorClassName = projectIconColorClassName(color);
  const monogram = letters.normalize("NFKC").trim().toUpperCase();
  const validMonogram =
    isMonogramText(monogram) && normalizeProjectMonogramInput(monogram) === monogram;
  const save = async () => {
    if (savingRef.current || composingRef.current || (mode === "monogram" && !validMonogram))
      return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await onSelect(
        mode === "monogram"
          ? { kind: "monogram", text: monogram, color }
          : mode === "lucide"
            ? { kind: "lucide", name: iconName, color }
            : { kind: "emoji", emoji },
      );
      onOpenChange(false);
    } catch (error) {
      setSaveError(projectIconSaveErrorMessage(error));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!savingRef.current) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="w-full sm:w-[32rem]">
        <DialogHeader>
          <DialogTitle>Choose project icon</DialogTitle>
          <DialogDescription>Choose an icon, emoji, or monogram.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex min-h-0 flex-col">
          <ToggleGroup
            disabled={saving}
            aria-label="Icon type"
            variant="segmented"
            value={[mode]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "lucide" || value === "emoji" || value === "monogram") setMode(value);
            }}
          >
            <Toggle value="lucide">Icons</Toggle>
            <Toggle value="emoji">Emoji</Toggle>
            <Toggle value="monogram">Monogram</Toggle>
          </ToggleGroup>

          {mode !== "emoji" ? (
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">Color</div>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Icon color">
                {PROJECT_ICON_COLORS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    disabled={saving}
                    aria-label={option.label}
                    aria-pressed={color === option.value}
                    className={cn(
                      "flex size-6 items-center justify-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      color === option.value && "border-foreground/64",
                    )}
                    onClick={() => setColor(option.value)}
                  >
                    <span className={cn("size-4 rounded-full", option.swatchClassName)} />
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {mode === "lucide" ? (
            <>
              <Input
                disabled={saving}
                type="search"
                value={query}
                aria-label="Search Lucide icons"
                placeholder="Search all Lucide icons"
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
              <ScrollArea scrollFade className="max-h-64">
                <div className="grid grid-cols-8 gap-1 p-0.5 sm:grid-cols-10">
                  {icons.map((name) => (
                    <button
                      key={name}
                      type="button"
                      disabled={saving}
                      aria-label={iconLabel(name)}
                      aria-pressed={iconName === name}
                      className={cn(
                        "flex aspect-square items-center justify-center rounded-md border border-transparent outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        iconName === name && "border-border bg-accent",
                        selectedColorClassName,
                      )}
                      onClick={() => setIconName(name)}
                    >
                      <PickerIcon name={name} />
                    </button>
                  ))}
                </div>
              </ScrollArea>
              {icons.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No icons found.</p>
              ) : null}
            </>
          ) : mode === "monogram" ? (
            <div className="flex items-center gap-4 py-2">
              <ProjectMonogram
                text={validMonogram ? monogram : automatic.monogram}
                color={color}
                className="size-12"
              />
              <div className="flex-1 space-y-2">
                <label htmlFor="project-monogram" className="text-sm font-medium">
                  Letters
                </label>
                <Input
                  disabled={saving}
                  id="project-monogram"
                  value={letters}
                  onChange={(event) => {
                    setLetters(
                      composingRef.current
                        ? event.currentTarget.value
                        : normalizeProjectMonogramInput(event.currentTarget.value),
                    );
                    setSaveError(null);
                  }}
                  onCompositionStart={() => {
                    composingRef.current = true;
                  }}
                  onCompositionEnd={(event) => {
                    composingRef.current = false;
                    setLetters(normalizeProjectMonogramInput(event.currentTarget.value));
                  }}
                  aria-describedby="project-monogram-hint"
                  aria-invalid={!validMonogram}
                  autoComplete="off"
                />
                <p id="project-monogram-hint" className="text-xs text-muted-foreground">
                  {validMonogram
                    ? "One or two letters or numbers."
                    : "Enter one or two letters or numbers."}
                </p>
              </div>
            </div>
          ) : (
            <>
              <ScrollArea scrollFade className="max-h-64">
                <div className="grid grid-cols-8 gap-1 p-0.5 sm:grid-cols-10">
                  {PROJECT_EMOJIS.map((option) => (
                    <button
                      key={option.emoji}
                      type="button"
                      disabled={saving}
                      aria-label={option.label}
                      aria-pressed={emoji === option.emoji}
                      className={cn(
                        "flex aspect-square items-center justify-center rounded-md border border-transparent text-xl outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        emoji === option.emoji && "border-border bg-accent",
                      )}
                      onClick={() => setEmoji(option.emoji)}
                    >
                      {option.emoji}
                    </button>
                  ))}
                </div>
              </ScrollArea>
              <div>
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  Or paste any emoji
                </div>
                <Input
                  disabled={saving}
                  value={customEmoji}
                  aria-label="Custom emoji"
                  placeholder="Paste an emoji"
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setCustomEmoji(value);
                    const nextEmoji = firstEmoji(value);
                    if (nextEmoji) setEmoji(nextEmoji);
                  }}
                />
              </div>
            </>
          )}
        </DialogPanel>
        {saveError ? (
          <p role="alert" className="px-6 text-sm text-destructive">
            {saveError}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || (mode === "monogram" && !validMonogram)}>
            Save icon
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
