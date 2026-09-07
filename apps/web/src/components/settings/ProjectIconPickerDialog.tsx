import type { ProjectIconColor, ProjectIconOverride } from "@t3tools/contracts";
import { DynamicIcon, type IconName } from "lucide-react/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  filterProjectIconNames,
  firstEmoji,
  PROJECT_EMOJIS,
  PROJECT_ICON_COLORS,
  projectIconColorClassName,
} from "../../projectIconOptions";
import { cn } from "~/lib/utils";
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

const DEFAULT_ICON: IconName = "folder-code";
const DEFAULT_COLOR: ProjectIconColor = "blue";

function iconLabel(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function ProjectIconPickerDialog({
  current,
  open,
  onOpenChange,
  onSelect,
}: {
  readonly current: ProjectIconOverride | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (icon: ProjectIconOverride) => void;
}) {
  const [mode, setMode] = useState<"lucide" | "emoji">(
    current?.kind === "emoji" ? "emoji" : "lucide",
  );
  const [iconName, setIconName] = useState<IconName>(
    current?.kind === "lucide" ? (current.name as IconName) : DEFAULT_ICON,
  );
  const [color, setColor] = useState<ProjectIconColor>(
    current?.kind === "lucide" ? current.color : DEFAULT_COLOR,
  );
  const [emoji, setEmoji] = useState(current?.kind === "emoji" ? current.emoji : "💻");
  const [query, setQuery] = useState("");
  const [customEmoji, setCustomEmoji] = useState("");
  const previousOpenRef = useRef(false);

  useEffect(() => {
    if (open && !previousOpenRef.current) {
      setMode(current?.kind === "emoji" ? "emoji" : "lucide");
      setIconName(current?.kind === "lucide" ? (current.name as IconName) : DEFAULT_ICON);
      setColor(current?.kind === "lucide" ? current.color : DEFAULT_COLOR);
      setEmoji(current?.kind === "emoji" ? current.emoji : "💻");
      setQuery("");
      setCustomEmoji("");
    }
    previousOpenRef.current = open;
  }, [current, open]);

  const icons = useMemo(() => filterProjectIconNames(query), [query]);
  const selectedColorClassName = projectIconColorClassName(color);
  const save = () => {
    onSelect(
      mode === "lucide" ? { kind: "lucide", name: iconName, color } : { kind: "emoji", emoji },
    );
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full sm:w-[32rem]">
        <DialogHeader>
          <DialogTitle>Choose project icon</DialogTitle>
          <DialogDescription>Pick any Lucide icon and color, or use an emoji.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex min-h-0 flex-col gap-4">
          <ToggleGroup
            aria-label="Icon type"
            variant="segmented"
            value={[mode]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "lucide" || value === "emoji") setMode(value);
            }}
          >
            <Toggle value="lucide">Icons</Toggle>
            <Toggle value="emoji">Emoji</Toggle>
          </ToggleGroup>

          {mode === "lucide" ? (
            <>
              <div>
                <div className="mb-2 text-xs font-medium text-muted-foreground">Color</div>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Icon color">
                  {PROJECT_ICON_COLORS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-label={option.label}
                      aria-pressed={color === option.value}
                      className={cn(
                        "flex size-6 items-center justify-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        color === option.value && "border-foreground/64",
                      )}
                      onClick={() => setColor(option.value)}
                    >
                      <span className={cn("size-4 rounded-full", option.swatchClassName)} />
                    </button>
                  ))}
                </div>
              </div>
              <Input
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
                      aria-label={iconLabel(name)}
                      aria-pressed={iconName === name}
                      className={cn(
                        "flex aspect-square items-center justify-center rounded-md border border-transparent outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                        iconName === name && "border-border bg-accent",
                        selectedColorClassName,
                      )}
                      onClick={() => setIconName(name)}
                    >
                      <DynamicIcon name={name} className="size-5" />
                    </button>
                  ))}
                </div>
              </ScrollArea>
              {icons.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No icons found.</p>
              ) : null}
            </>
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
                        "flex aspect-square items-center justify-center rounded-md border border-transparent text-xl outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
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
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save}>Save icon</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
