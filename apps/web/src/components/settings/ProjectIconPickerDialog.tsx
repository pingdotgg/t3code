import type { ProjectIconOverride } from "@t3tools/contracts";
import { SearchIcon } from "lucide-react";
import { createElement, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  filterProjectIconNames,
  firstEmoji,
  initialProjectIconDraft,
  PROJECT_EMOJI_CATEGORIES,
  PROJECT_ICON_CATEGORIES,
  PROJECT_ICON_COLORS,
  projectIconColorClassName,
  projectIconFromDraft,
  type ProjectIconDraft,
} from "../../projectIconOptions";
import { deriveProjectIdentity } from "../../projectIdentity";
import { cn } from "~/lib/utils";
import { lucideIconByName } from "../../lib/lucideIconByName";
import { ProjectIconOverrideGlyph } from "../ProjectFavicon";
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

const OPTION_CLASS_NAME =
  "flex size-9 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
const SELECTED_OPTION_CLASS_NAME = "bg-accent ring-1 ring-inset ring-border";
const GRID_CLASS_NAME = "grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-0.5";

function PickerIcon({ name }: { name: string }) {
  const icon = lucideIconByName(name);
  return icon ? createElement(icon, { className: "size-4.5" }) : null;
}

function iconLabel(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function PickerSectionLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1.5 text-xs font-medium text-muted-foreground">{children}</div>;
}

/** Arrow keys move between `[data-grid-option]` buttons by their on-screen position. */
function moveGridFocus(event: KeyboardEvent<HTMLElement>) {
  const horizontal = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
  const down = event.key === "ArrowDown";
  if (horizontal === 0 && !down && event.key !== "ArrowUp") return;
  const options = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-grid-option]")];
  const current = event.target instanceof HTMLElement ? options.indexOf(event.target) : -1;
  const from = options[current]?.getBoundingClientRect();
  if (!from) return;
  event.preventDefault();
  if (horizontal !== 0) {
    options[current + horizontal]?.focus();
    return;
  }
  const rects = options.map((option) => option.getBoundingClientRect());
  const rowTops = rects
    .map((rect) => rect.top)
    .filter((top) => (down ? top > from.top + 1 : top < from.top - 1));
  if (rowTops.length === 0) return;
  const rowTop = down ? Math.min(...rowTops) : Math.max(...rowTops);
  let best = -1;
  for (const [index, rect] of rects.entries()) {
    if (Math.abs(rect.top - rowTop) > 1) continue;
    const bestRect = rects[best];
    if (!bestRect || Math.abs(rect.left - from.left) < Math.abs(bestRect.left - from.left)) {
      best = index;
    }
  }
  options[best]?.focus();
}

function IconGrid({
  names,
  selected,
  colorClassName,
  focusName,
  onSelect,
}: {
  readonly names: ReadonlyArray<string>;
  readonly selected: string;
  readonly colorClassName: string;
  readonly focusName: string | undefined;
  readonly onSelect: (name: string) => void;
}) {
  return (
    <div className={GRID_CLASS_NAME}>
      {names.map((name) => (
        <button
          key={name}
          type="button"
          data-grid-option
          tabIndex={name === focusName ? 0 : -1}
          aria-label={iconLabel(name)}
          aria-pressed={selected === name}
          className={cn(
            OPTION_CLASS_NAME,
            selected === name && [SELECTED_OPTION_CLASS_NAME, colorClassName],
          )}
          onClick={() => onSelect(name)}
        >
          <PickerIcon name={name} />
        </button>
      ))}
    </div>
  );
}

function LucideIconPane({
  draft,
  onDraftChange,
}: {
  readonly draft: ProjectIconDraft;
  readonly onDraftChange: (draft: ProjectIconDraft) => void;
}) {
  const [query, setQuery] = useState("");
  const gridRef = useRef<HTMLDivElement>(null);
  const searching = query.trim() !== "";
  const icons = filterProjectIconNames(query);
  const focusName = icons.includes(draft.iconName) ? draft.iconName : icons[0];
  const colorClassName = projectIconColorClassName(draft.color);
  const select = (iconName: string) => onDraftChange({ ...draft, iconName });

  return (
    <div className="space-y-3">
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          value={query}
          aria-label="Search icons"
          placeholder="Search all icons"
          autoComplete="off"
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && icons[0]) {
              event.preventDefault();
              select(icons[0]);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              gridRef.current
                ?.querySelector<HTMLElement>('[data-grid-option][tabindex="0"]')
                ?.focus();
            }
          }}
        />
      </InputGroup>
      <ScrollArea scrollFade className="h-64">
        <div ref={gridRef} className="space-y-3 p-0.5" onKeyDown={moveGridFocus}>
          {searching ? (
            icons.length > 0 ? (
              <IconGrid
                names={icons}
                selected={draft.iconName}
                colorClassName={colorClassName}
                focusName={focusName}
                onSelect={select}
              />
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No icons match “{query.trim()}”.
              </p>
            )
          ) : (
            PROJECT_ICON_CATEGORIES.map((category) => (
              <section key={category.label} aria-label={category.label}>
                <PickerSectionLabel>{category.label}</PickerSectionLabel>
                <IconGrid
                  names={category.icons}
                  selected={draft.iconName}
                  colorClassName={colorClassName}
                  focusName={focusName}
                  onSelect={select}
                />
              </section>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function EmojiPane({
  draft,
  onDraftChange,
}: {
  readonly draft: ProjectIconDraft;
  readonly onDraftChange: (draft: ProjectIconDraft) => void;
}) {
  const [customEmoji, setCustomEmoji] = useState("");
  const customInvalid = customEmoji.trim() !== "" && firstEmoji(customEmoji) === null;
  const focusEmoji = PROJECT_EMOJI_CATEGORIES.some((category) =>
    category.emojis.some((option) => option.emoji === draft.emoji),
  )
    ? draft.emoji
    : PROJECT_EMOJI_CATEGORIES[0]?.emojis[0]?.emoji;

  return (
    <div className="space-y-3">
      <ScrollArea scrollFade className="h-56">
        <div className="space-y-3 p-0.5" onKeyDown={moveGridFocus}>
          {PROJECT_EMOJI_CATEGORIES.map((category) => (
            <section key={category.label} aria-label={category.label}>
              <PickerSectionLabel>{category.label}</PickerSectionLabel>
              <div className={GRID_CLASS_NAME}>
                {category.emojis.map((option) => (
                  <button
                    key={option.emoji}
                    type="button"
                    data-grid-option
                    tabIndex={option.emoji === focusEmoji ? 0 : -1}
                    aria-label={option.label}
                    aria-pressed={draft.emoji === option.emoji}
                    className={cn(
                      OPTION_CLASS_NAME,
                      "text-xl",
                      draft.emoji === option.emoji && SELECTED_OPTION_CLASS_NAME,
                    )}
                    onClick={() => onDraftChange({ ...draft, emoji: option.emoji })}
                  >
                    {option.emoji}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </ScrollArea>
      <div>
        <PickerSectionLabel>Any other emoji</PickerSectionLabel>
        <Input
          value={customEmoji}
          aria-label="Custom emoji"
          aria-invalid={customInvalid}
          aria-describedby={customInvalid ? "project-custom-emoji-error" : undefined}
          placeholder="Paste or type an emoji"
          autoComplete="off"
          onChange={(event) => {
            const value = event.currentTarget.value;
            setCustomEmoji(value);
            const nextEmoji = firstEmoji(value);
            if (nextEmoji) onDraftChange({ ...draft, emoji: nextEmoji });
          }}
        />
        {customInvalid ? (
          <p id="project-custom-emoji-error" className="mt-1.5 text-xs text-destructive-foreground">
            That is not an emoji.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function MonogramPane({
  draft,
  onDraftChange,
}: {
  readonly draft: ProjectIconDraft;
  readonly onDraftChange: (draft: ProjectIconDraft) => void;
}) {
  const valid = projectIconFromDraft({ ...draft, mode: "monogram" }) !== null;
  return (
    <div className="space-y-1.5">
      <label htmlFor="project-monogram" className="text-xs font-medium text-muted-foreground">
        Letters
      </label>
      <Input
        id="project-monogram"
        value={draft.letters}
        className="w-28"
        onChange={(event) => onDraftChange({ ...draft, letters: event.currentTarget.value })}
        aria-describedby="project-monogram-hint"
        aria-invalid={!valid}
        autoComplete="off"
      />
      <p
        id="project-monogram-hint"
        className={cn("text-xs", valid ? "text-muted-foreground" : "text-destructive-foreground")}
      >
        One or two letters or numbers.
      </p>
    </div>
  );
}

/**
 * The icon, emoji, and monogram picker. It is controlled, so a dialog can embed it and
 * save the draft with its other fields; `preview` shows the result where it will render.
 */
export function ProjectIconPicker({
  draft,
  onDraftChange,
  preview,
}: {
  readonly draft: ProjectIconDraft;
  readonly onDraftChange: (draft: ProjectIconDraft) => void;
  readonly preview: ReactNode;
}) {
  return (
    <div className="space-y-4">
      {preview}
      <ToggleGroup
        aria-label="Icon type"
        variant="segmented"
        className="w-full *:flex-1"
        value={[draft.mode]}
        onValueChange={(next) => {
          const mode = next[0];
          if (mode === "lucide" || mode === "emoji" || mode === "monogram") {
            onDraftChange({ ...draft, mode });
          }
        }}
      >
        <Toggle value="lucide">Icon</Toggle>
        <Toggle value="emoji">Emoji</Toggle>
        <Toggle value="monogram">Monogram</Toggle>
      </ToggleGroup>

      {draft.mode !== "emoji" ? (
        <div>
          <PickerSectionLabel>Color</PickerSectionLabel>
          <div className="flex flex-wrap" role="radiogroup" aria-label="Icon color">
            {PROJECT_ICON_COLORS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-label={option.label}
                aria-checked={draft.color === option.value}
                className="flex size-6 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => onDraftChange({ ...draft, color: option.value })}
              >
                <span
                  className={cn(
                    "size-3.5 rounded-full",
                    option.swatchClassName,
                    draft.color === option.value &&
                      "ring-2 ring-foreground/80 ring-offset-2 ring-offset-popover",
                  )}
                />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {draft.mode === "lucide" ? (
        <LucideIconPane draft={draft} onDraftChange={onDraftChange} />
      ) : draft.mode === "emoji" ? (
        <EmojiPane draft={draft} onDraftChange={onDraftChange} />
      ) : (
        <MonogramPane draft={draft} onDraftChange={onDraftChange} />
      )}
    </div>
  );
}

function ProjectIconPreview({ draft, name }: { draft: ProjectIconDraft; name: string }) {
  const automatic = deriveProjectIdentity(name);
  const icon: ProjectIconOverride = projectIconFromDraft(draft) ?? {
    kind: "monogram",
    text: automatic.monogram,
    color: draft.color,
  };
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-muted/40 p-3">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border bg-background">
        <ProjectIconOverrideGlyph
          icon={icon}
          className={icon.kind === "monogram" ? "size-8" : "size-6"}
        />
      </span>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {icon.kind === "lucide"
            ? iconLabel(icon.name)
            : icon.kind === "emoji"
              ? "Emoji"
              : "Monogram"}
        </div>
      </div>
    </div>
  );
}

export function ProjectIconPickerDialog({
  current,
  projectName,
  open,
  onOpenChange,
  onSelect,
  title = "Choose project icon",
}: {
  readonly current: ProjectIconOverride | null;
  readonly projectName: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (icon: ProjectIconOverride) => void;
  readonly title?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full sm:w-[32rem]">
        {/* The popup mounts per open, so the draft below starts from `current` each time. */}
        <ProjectIconPickerBody
          current={current}
          projectName={projectName}
          title={title}
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
  title,
  onClose,
  onSelect,
}: {
  readonly current: ProjectIconOverride | null;
  readonly projectName: string;
  readonly title: string;
  readonly onClose: () => void;
  readonly onSelect: (icon: ProjectIconOverride) => void;
}) {
  const [draft, setDraft] = useState(() => initialProjectIconDraft(current, projectName));
  const icon = projectIconFromDraft(draft);
  const save = () => {
    if (!icon) return;
    onSelect(icon);
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>Pick an icon, an emoji, or a monogram.</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <ProjectIconPicker
          draft={draft}
          onDraftChange={setDraft}
          preview={<ProjectIconPreview draft={draft} name={projectName} />}
        />
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={save} disabled={!icon}>
          Save icon
        </Button>
      </DialogFooter>
    </>
  );
}
