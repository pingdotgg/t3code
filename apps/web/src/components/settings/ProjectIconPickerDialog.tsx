import * as Schema from "effect/Schema";
import { deriveProjectIdentity } from "../../projectIdentity";
import { ProjectMonogram } from "../ProjectMonogram";
import {
  ProjectMonogramText,
  type ProjectIconColor,
  type ProjectIconOverride,
} from "@t3tools/contracts";
import { SearchIcon } from "lucide-react";
import { createElement, useState } from "react";
import {
  filterProjectIconNames,
  firstEmoji,
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const DEFAULT_ICON = "folder-code";
const isMonogramText = Schema.is(ProjectMonogramText);

function PickerIcon({ name, className = "size-4.5" }: { name: string; className?: string }) {
  const icon = lucideIconByName(name);
  return icon ? createElement(icon, { className }) : null;
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
      <DialogPopup className="w-full sm:w-[32rem]" showCloseButton={false}>
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
  const validMonogram = isMonogramText(monogram);
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
        <DialogTitle>Choose project icon</DialogTitle>
        <DialogDescription>Choose an icon, emoji, or monogram.</DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex min-h-0 flex-col">
        <ToggleGroup
          aria-label="Icon type"
          variant="segmented"
          className="w-full *:flex-1"
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

        {mode === "lucide" ? (
          <>
            <InputGroup>
              <InputGroupAddon>
                <SearchIcon aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                value={query}
                aria-label="Search Lucide icons"
                placeholder="Search all Lucide icons"
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </InputGroup>
            <ScrollArea scrollFade className="max-h-64">
              <div className="grid grid-cols-8 gap-1.5 p-0.5">
                {icons.map((name) => (
                  <button
                    key={name}
                    type="button"
                    aria-label={iconLabel(name)}
                    aria-pressed={iconName === name}
                    className={cn(
                      "flex aspect-square items-center justify-center rounded-project-icon border border-transparent outline-none hover:surface-ghost-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      iconName === name
                        ? "surface-raised [--surface-rim:linear-gradient(180deg,color-mix(in_srgb,currentColor_60%,transparent),color-mix(in_srgb,currentColor_20%,transparent))]"
                        : "bg-settings-icon-fill text-muted-foreground",
                      iconName === name && selectedColorClassName,
                    )}
                    onClick={() => setIconName(name)}
                  >
                    <PickerIcon name={name} />
                  </button>
                ))}
              </div>
            </ScrollArea>
            {icons.length === 0 ? (
              <p className="py-8 text-center text-body text-muted-foreground">No icons found.</p>
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
              <label htmlFor="project-monogram" className="text-label">
                Letters
              </label>
              <Input
                id="project-monogram"
                value={letters}
                onChange={(event) => setLetters(event.currentTarget.value)}
                aria-describedby="project-monogram-hint"
                aria-invalid={!validMonogram}
                autoComplete="off"
              />
              <p id="project-monogram-hint" className="text-meta text-muted-foreground">
                One or two letters or numbers.
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
                    aria-label={option.label}
                    aria-pressed={emoji === option.emoji}
                    className={cn(
                      "flex aspect-square items-center justify-center rounded-item border border-transparent text-xl outline-none hover:surface-ghost-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      emoji === option.emoji && "border-border surface-selected-soft",
                    )}
                    onClick={() => setEmoji(option.emoji)}
                  >
                    {option.emoji}
                  </button>
                ))}
              </div>
            </ScrollArea>
            <div>
              <div className="mb-2 text-meta text-dim-foreground">Or paste any emoji</div>
              <Input
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
        {mode !== "emoji" ? (
          <div>
            <div className="mb-2 text-meta text-muted-foreground">Color</div>
            <div
              className="grid auto-cols-fr grid-flow-col justify-items-center"
              role="group"
              aria-label="Icon color"
            >
              {PROJECT_ICON_COLORS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-label={option.label}
                  aria-pressed={color === option.value}
                  className={cn(
                    "flex size-5.5 items-center justify-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    color === option.value && "shadow-project-icon-selected",
                  )}
                  onClick={() => setColor(option.value)}
                >
                  <span className={cn("size-3.5 rounded-full", option.swatchClassName)} />
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </DialogPanel>
      <DialogFooter className="sm:justify-between">
        <span className="flex min-w-0 items-center gap-2 text-body text-muted-foreground">
          <span
            aria-hidden
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-project-icon bg-settings-icon-fill",
              mode === "lucide" && selectedColorClassName,
            )}
          >
            {mode === "lucide" ? (
              <PickerIcon name={iconName} className="size-4" />
            ) : mode === "emoji" ? (
              <span className="text-prompt leading-none">{emoji}</span>
            ) : (
              <ProjectMonogram
                text={validMonogram ? monogram : automatic.monogram}
                color={color}
                className="size-7"
              />
            )}
          </span>
          <span className="truncate">{projectName}</span>
        </span>
        <span className="flex gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={mode === "monogram" && !validMonogram}>
            Save
          </Button>
        </span>
      </DialogFooter>
    </>
  );
}
