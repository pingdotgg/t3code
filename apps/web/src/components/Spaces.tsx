import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { SPACE_JUMP_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import { primaryServerKeybindingsAtom } from "../state/server";
import { shortcutLabelForCommand } from "../keybindings";
import { getThemeDefinition, getThemeColorsForMode, getStandardThemeColors } from "../themePalette";
import { useTheme } from "../hooks/useTheme";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useSidebar } from "./ui/sidebar";
import { Columns3Icon, LayoutGridIcon } from "lucide-react";
import type { ScopedProjectRef } from "@t3tools/contracts";
import {
  assignProjectSpace,
  createSpace,
  resolveProjectSpace,
  updateSpace,
} from "@t3tools/client-runtime/state/spaces";
import { useClientSettings } from "../hooks/useSettings";
import { reportSpaceError, updateSpaces, useSelectSpace } from "../hooks/useSpaces";
import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";
import { randomUUID } from "../lib/utils";
import { useEnvironmentThemeDefinitions } from "../hooks/useEnvironmentTheme";
import { useCustomThemes } from "../hooks/useCustomThemes";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { ThemePreviewCircle } from "./settings/ThemePreviewCircles";
import type { Space } from "@t3tools/contracts/settings";

export function spacePreviewColors(theme: string | null, appearance: "light" | "dark") {
  if (!theme) return null;
  if (theme === "light" || theme === "dark") return getStandardThemeColors(theme);
  if (theme === "system") return getStandardThemeColors(appearance);
  const definition = getThemeDefinition(theme);
  return definition ? (getThemeColorsForMode(definition, appearance) ?? definition.colors) : null;
}

/** The appearance a Space's preview colors belong to, for themes that only ship one mode. */
function spacePreviewMode(theme: string | null, appearance: "light" | "dark") {
  if (theme === "light" || theme === "dark") return theme;
  const definition = theme ? getThemeDefinition(theme) : null;
  return definition && !getThemeColorsForMode(definition, appearance)
    ? definition.appearance
    : appearance;
}

/** Arc-style switcher: the active Space reads as a labeled pill, the rest stay compact dots. */
export function SpaceDots() {
  const spaces = useClientSettings((settings) => settings.spaces);
  const selectedDot = useRef<HTMLButtonElement | null>(null);
  const selectSpace = useSelectSpace();
  const navigate = useNavigate();
  const overviewOpen = useLocation({ select: (location) => location.pathname === "/spaces" });
  useEffect(() => {
    selectedDot.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [spaces.activeSpaceId, overviewOpen]);
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { resolvedTheme } = useTheme();
  useCustomThemes();
  useEnvironmentThemeDefinitions();
  const switchSpace = (id: string | null) => {
    if (isMobile) setOpenMobile(false);
    void selectSpace(id).catch(reportSpaceError);
  };
  const items = [
    { id: null, name: "All Spaces", accent: null, shortcut: undefined },
    ...spaces.spaces.map((space, index) => {
      const command = SPACE_JUMP_KEYBINDING_COMMANDS[index];
      return {
        id: space.id,
        name: space.name,
        accent: spacePreviewColors(space.theme, resolvedTheme)?.accent ?? null,
        shortcut: command ? shortcutLabelForCommand(keybindings, command) : undefined,
      };
    }),
  ];
  return (
    <nav
      aria-label="Spaces"
      className="flex shrink-0 items-center gap-1 border-t border-sidebar-border/50 px-2 py-1.5"
    >
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
        {items.map((item) => {
          const active = spaces.activeSpaceId === item.id;
          return (
            <Tooltip key={item.id ?? "all"}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={item.id === null ? "All Spaces" : `Switch to ${item.name}`}
                    ref={active ? selectedDot : undefined}
                    aria-pressed={active}
                    onClick={() => switchSpace(item.id)}
                    className="flex h-7 min-w-7 shrink-0 items-center justify-center gap-1.5 rounded-full text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring aria-pressed:max-w-32 aria-pressed:bg-sidebar-row-active aria-pressed:px-2.5 aria-pressed:text-sidebar-foreground"
                  />
                }
              >
                {item.id === null ? (
                  <LayoutGridIcon aria-hidden className="size-3.5 shrink-0" />
                ) : (
                  <span
                    aria-hidden
                    className={`size-2 shrink-0 rounded-full ${active ? "bg-sidebar-foreground/70" : "bg-sidebar-muted-foreground/45"}`}
                    style={item.accent ? { backgroundColor: item.accent } : undefined}
                  />
                )}
                {active ? (
                  <span className="min-w-0 truncate text-xs font-medium">
                    {item.id === null ? "All" : item.name}
                  </span>
                ) : null}
              </TooltipTrigger>
              <TooltipPopup side="top">
                {item.name}
                {item.shortcut ? ` · ${item.shortcut}` : ""}
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Spaces overview"
              aria-pressed={overviewOpen}
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                void navigate({ to: "/spaces" });
              }}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-sidebar-row-active aria-pressed:text-sidebar-foreground"
            />
          }
        >
          <Columns3Icon aria-hidden className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="top">Spaces overview</TooltipPopup>
      </Tooltip>
    </nav>
  );
}

export function SpaceAssignment({ projectRef }: { projectRef: ScopedProjectRef }) {
  const spaces = useClientSettings((settings) => settings.spaces);
  const spaceId = resolveProjectSpace(spaces, projectRef);
  return (
    <Select
      value={spaceId ?? "none"}
      onValueChange={(next) => {
        if (next !== null)
          void updateSpaces((state) =>
            assignProjectSpace(state, projectRef, next === "none" ? null : next),
          ).catch(reportSpaceError);
      }}
    >
      <SelectTrigger size="sm" aria-label="Project Space">
        <SelectValue>
          {spaces.spaces.find((space) => space.id === spaceId)?.name ?? "No Space"}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="none">No Space</SelectItem>
        {spaces.spaces.map((space) => (
          <SelectItem key={space.id} value={space.id}>
            {space.name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

const STANDARD_SPACE_THEMES = [
  { id: "system", label: "T3 Code" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;

/** Theme balls for a Space, drawn like the Appearance settings so each choice previews itself. */
function SpaceThemePicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (theme: string | null) => void;
}) {
  const customThemes = useCustomThemes();
  const environmentThemes = useEnvironmentThemeDefinitions();
  const { resolvedTheme } = useTheme();
  const themes = [
    ...STANDARD_SPACE_THEMES,
    ...new Map(
      [...BUILT_IN_THEMES, ...customThemes, ...environmentThemes].map((theme) => [theme.id, theme]),
    ).values(),
  ];
  const options = [{ id: null, label: "App theme" }, ...themes];
  return (
    <div role="radiogroup" aria-label="Space theme" className="grid grid-cols-4 gap-x-2 gap-y-3">
      {options.map((option) => {
        const colors = spacePreviewColors(option.id, resolvedTheme);
        const selected = value === option.id;
        return (
          <button
            key={option.id ?? "app"}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.id)}
            className="group flex min-w-0 cursor-pointer flex-col items-center gap-1.5 rounded-lg py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="relative flex size-12 items-center justify-center rounded-full">
              {colors ? (
                <ThemePreviewCircle
                  colors={colors}
                  mode={spacePreviewMode(option.id, resolvedTheme)}
                  className="size-10"
                />
              ) : (
                <span
                  aria-hidden
                  className="size-10 rounded-full border-2 border-dashed border-muted-foreground/40"
                />
              )}
              {selected ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-full"
                  style={{ boxShadow: "inset 0 0 0 2px var(--ring)" }}
                />
              ) : null}
            </span>
            <span
              className={`max-w-full truncate text-xs ${selected ? "font-medium text-foreground" : "text-muted-foreground group-hover:text-foreground"}`}
            >
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SpaceEditorForm({ space, onDone }: { space: Space | null; onDone: () => void }) {
  const [name, setName] = useState(space?.name ?? "");
  const [theme, setTheme] = useState<string | null>(space?.theme ?? null);
  const [saving, setSaving] = useState(false);
  const trimmed = name.trim();
  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!trimmed || saving) return;
        setSaving(true);
        void updateSpaces((state) =>
          space
            ? updateSpace(state, space.id, { name: trimmed, theme })
            : createSpace(state, { id: randomUUID(), name: trimmed, theme }),
        )
          .then(onDone)
          .catch(reportSpaceError)
          .finally(() => setSaving(false));
      }}
    >
      <DialogHeader>
        <DialogTitle>{space ? "Edit Space" : "Create a Space"}</DialogTitle>
        <DialogDescription>
          Spaces group projects and their threads. They are saved on this device.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <label className="block space-y-2">
          <span className="text-sm font-medium">Name</span>
          <Input
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder="Work, writing, personal…"
            autoFocus
          />
        </label>
        <div className="space-y-2">
          <p className="text-sm font-medium">Theme</p>
          <SpaceThemePicker value={theme} onChange={setTheme} />
        </div>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        <Button type="submit" disabled={!trimmed || saving}>
          {space ? "Save" : "Create Space"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Create a Space when `space` is null, otherwise rename it and change its theme. */
export function SpaceEditorDialog({
  open,
  space,
  onOpenChange,
}: {
  open: boolean;
  space: Space | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        <SpaceEditorForm space={space} onDone={() => onOpenChange(false)} />
      </DialogPopup>
    </Dialog>
  );
}
