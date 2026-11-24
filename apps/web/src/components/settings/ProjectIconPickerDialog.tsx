import { deriveProjectIdentity } from "../../projectIdentity";
import { ProjectMonogram } from "../ProjectMonogram";
import type { ProjectIconColor, ProjectIconOverride } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { createElement, useState } from "react";
import {
  filterProjectIconNames,
  firstEmoji,
  isValidProjectMonogram,
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
  readonly onSelect: (icon: ProjectIconOverride) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full sm:w-[32rem]">
        {/* The popup mounts per open, so the draft below starts from `current` each time. */}
        <ProjectIconPickerBody
          current={current}
          projectName={projectName}
          onClose={() => onOpenChange(false)}
          onSelect={onSelect}
        />
      </DialogPopup>
    </Dialog>
  );
}

function ProjectIconPickerBody({
  current,
  projectName,
  onClose,
  onSelect,
}: {
  readonly current: ProjectIconOverride | null;
  readonly projectName: string;
  readonly onClose: () => void;
  readonly onSelect: (icon: ProjectIconOverride) => void;
}) {
  const gt = useGT();
  const m = useMessages();
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

  const icons = filterProjectIconNames(query);
  const selectedColorClassName = projectIconColorClassName(color);
  const monogram = letters.normalize("NFKC").trim().toUpperCase();
  const validMonogram = isValidProjectMonogram(monogram);
  const save = () => {
    if (mode === "monogram" && !validMonogram) return;
    onSelect(
      mode === "monogram"
        ? { kind: "monogram", text: monogram, color }
        : mode === "lucide"
          ? { kind: "lucide", name: iconName, color }
          : { kind: "emoji", emoji },
    );
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <T>Choose project icon</T>
        </DialogTitle>
        <DialogDescription>
          <T>Choose an icon, emoji, or monogram.</T>
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex min-h-0 flex-col">
        <ToggleGroup
          aria-label={gt("Icon type")}
          variant="segmented"
          value={[mode]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "lucide" || value === "emoji" || value === "monogram") setMode(value);
          }}
        >
          <Toggle value="lucide">
            <T>Icons</T>
          </Toggle>
          <Toggle value="emoji">
            <T>Emoji</T>
          </Toggle>
          <Toggle value="monogram">
            <T>Monogram</T>
          </Toggle>
        </ToggleGroup>

        {mode !== "emoji" ? (
          <div>
            <div className="mb-2 text-xs font-medium text-muted-foreground">
              <T>Color</T>
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={gt("Icon color")}>
              {PROJECT_ICON_COLORS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-label={m(option.label)}
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
            {/* Native search inputs clear on Escape even during IME composition. */}
            <Input
              type="text"
              role="searchbox"
              value={query}
              aria-label={gt("Search Lucide icons")}
              placeholder={gt("Search all Lucide icons")}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (
                  event.key !== "Escape" ||
                  event.nativeEvent.isComposing ||
                  event.keyCode === 229
                )
                  return;
                if (!query && !event.repeat) return;
                event.stopPropagation();
                setQuery("");
              }}
            />
            <ScrollArea scrollFade className="max-h-64">
              <div className="grid grid-cols-8 gap-1 p-0.5 sm:grid-cols-10">
                {icons.map((name) => (
                  <button
                    key={name}
                    type="button"
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
              <p className="py-8 text-center text-sm text-muted-foreground">
                <T>No icons found.</T>
              </p>
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
                <T>Letters</T>
              </label>
              <Input
                id="project-monogram"
                value={letters}
                onChange={(event) => setLetters(event.currentTarget.value)}
                aria-describedby="project-monogram-hint"
                aria-invalid={!validMonogram}
                autoComplete="off"
              />
              <p id="project-monogram-hint" className="text-xs text-muted-foreground">
                <T>One or two letters or numbers.</T>
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
                    aria-label={m(option.label)}
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
                <T>Or paste any emoji</T>
              </div>
              <Input
                value={customEmoji}
                aria-label={gt("Custom emoji")}
                placeholder={gt("Paste an emoji")}
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
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          <T>Cancel</T>
        </Button>
        <Button onClick={save} disabled={mode === "monogram" && !validMonogram}>
          <T>Save icon</T>
        </Button>
      </DialogFooter>
    </>
  );
}
