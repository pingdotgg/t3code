/* oxlint-disable t3code/no-untranslated-copy -- Dev-only design catalog (loaded behind import.meta.env.DEV); its sample copy stays English. */
import { SURFACE_STYLES, type SurfaceStyle } from "@t3tools/contracts";
import {
  ArchiveIcon,
  ArrowRightLeftIcon,
  ArrowUpIcon,
  BellIcon,
  BotIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleStopIcon,
  CopyIcon,
  EraserIcon,
  FileIcon,
  FilePenIcon,
  FolderIcon,
  GitBranchIcon,
  GitForkIcon,
  GlobeIcon,
  HammerIcon,
  ListTodoIcon,
  MaximizeIcon,
  MicIcon,
  MinusIcon,
  PaletteIcon,
  PaperclipIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquareTerminalIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { getSourceControlPresentationForKind } from "../../sourceControlPresentation";
import { CommandPaletteContent } from "../CommandPaletteContent";
import {
  ACPRegistryIcon,
  AndroidIcon,
  AntigravityIcon,
  AppleIcon,
  ClaudeAI,
  CursorIcon,
  GitIcon,
  JujutsuIcon,
  KiroIcon,
  LinuxIcon,
  OpenAI,
  TraeIcon,
} from "../Icons";
import { CommandPaletteResults } from "../CommandPaletteResults";
import type { CommandPaletteActionItem, CommandPaletteGroup } from "../CommandPalette.logic";
import { ContextChip, ContextChipLabel } from "../ContextChip";
import { ComposerTaskStatus } from "../chat/ComposerTaskStatus";
import {
  ComposerBanner,
  composerBannerDetailClassName,
  composerBannerTitleClassName,
} from "../chat/ComposerBanner";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { TimelineSystemDivider } from "../chat/TimelineSystemDivider";
import {
  WorkLogBlock,
  WorkLogButton,
  WorkLogDetails,
  WorkLogList,
  WorkLogRow,
} from "../chat/WorkLog";
import {
  SettingResetButton,
  SettingsEmptyState,
  SettingsLoadingRows,
  SettingsNoMatches,
  SettingsNote,
  SettingsRow,
  SettingsSearchField,
  SettingsSection,
  SettingsToolbar,
} from "../settings/settingsLayout";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button, type ButtonSize, type ButtonVariant, InlineButton } from "../ui/button";
import { CardSection } from "../ui/card-section";
import { Checkbox } from "../ui/checkbox";
import { CollapsibleSectionHeader, SectionHeaderStatus } from "../ui/collapsible-section-header";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogTrigger,
  CommandFooter,
  CommandInput,
  CommandPanel,
} from "../ui/command";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { FloatingToolbar } from "../ui/floating-toolbar";
import { Group, GroupSeparator } from "../ui/group";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupUnit } from "../ui/input-group";
import { Kbd, KbdGroup } from "../ui/kbd";
import { Label } from "../ui/label";
import { LabeledSection } from "../ui/labeled-section";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { Meter } from "../ui/meter";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { PanelFrame } from "../ui/panel-frame";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Radio, RadioGroup } from "../ui/radio-group";
import { ScrollArea } from "../ui/scroll-area";
import {
  Select,
  SelectButton,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Separator } from "../ui/separator";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { StatusDot } from "../ui/status-dot";
import { Switch } from "../ui/switch";
import { Text } from "../ui/text";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Every exported variant, by layer. The page renders these lists, so a variant
 * that exists in code but not here shows up as a gap the next reader can see.
 */
const BUTTON_VARIANTS: ReadonlyArray<ButtonVariant> = [
  "default",
  "secondary",
  "destructive",
  "destructive-outline",
  "warning-outline",
  "destructive-tint",
  "merged-tint",
  "info-tint",
  "ghost",
  "ghost-muted",
  "ghost-destructive",
  "floating",
  "link",
];
const BUTTON_OVERLAY_VARIANTS: ReadonlyArray<ButtonVariant> = [
  "overlay",
  "media-close",
  "media-navigation",
];
const BUTTON_TEXT_SIZES: ReadonlyArray<ButtonSize> = [
  "micro",
  "xs",
  "compact",
  "standard",
  "sm",
  "sm-multiline",
  "default",
];
const BUTTON_ICON_SIZES: ReadonlyArray<ButtonSize> = ["icon-micro", "icon-xs", "icon-sm", "icon"];
const BADGE_VARIANTS = [
  "secondary",
  "outline",
  "success",
  "merged",
  "warning",
  "error",
  "info",
  "unavailable",
] as const;
const BADGE_SIZES = ["sm", "default", "lg"] as const;
const ALERT_VARIANTS = ["default", "info", "warning", "error"] as const;

/**
 * A dev-only catalog of the design system, one section per layer of
 * primitives. The sidebar (DesignSystemSidebarNav) links to each section.
 */
export function DesignSystemPage() {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-16 px-6 pt-6 pb-24">
        <Text variant="body" tone="muted" render={<p />}>
          Every primitive, composed primitive and shared component, live. Screens are built from
          these; a new need becomes a variant here, not a one-off style. Only dev builds serve this
          page.
        </Text>
        <FoundationsSection />
        <SurfacesGridSection />
        <ButtonsSection />
        <ControlsSection />
        <InputsSection />
        <BadgesSection />
        <StatusSection />
        <GroupsSection />
        <PanelsSection />
        <SettingsCatalogSection />
        <OverlaysSection />
        <PaletteSection />
        <FeedbackSection />
        <WorkLogSection />
        <ComposerSection />
      </div>
    </ScrollArea>
  );
}

function Section({
  id,
  title,
  layer,
  description,
  children,
}: {
  id: string;
  title: string;
  layer: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="flex scroll-mt-6 flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-strong-foreground">{title}</h2>
          <Badge variant="secondary">{layer}</Badge>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex flex-col gap-8">{children}</div>
    </section>
  );
}

/** One labelled specimen. `source` names the import an agent should reach for. */
function Specimen({
  label,
  source,
  children,
  stack = false,
}: {
  label: string;
  source?: string;
  children: ReactNode;
  stack?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {source ? <code className="font-mono text-2xs text-dim-foreground">{source}</code> : null}
      </div>
      <div
        className={stack ? "flex flex-col items-start gap-3" : "flex flex-wrap items-center gap-3"}
      >
        {children}
      </div>
    </div>
  );
}

/** A caption under a specimen in a matrix. */
function Caption({ children }: { children: ReactNode }) {
  return <span className="font-mono text-2xs text-dim-foreground">{children}</span>;
}

function Cell({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      {children}
      <Caption>{caption}</Caption>
    </div>
  );
}

/** A framed stage for components that need their own surface, such as the composer tray. */
function Stage({ children, width = "md" }: { children: ReactNode; width?: "md" | "lg" }) {
  return (
    <div
      className={
        width === "lg"
          ? "w-full max-w-2xl rounded-card border border-divider p-4"
          : "w-full max-w-md rounded-card border border-divider p-4"
      }
    >
      {children}
    </div>
  );
}

/* Foundations */

const COLOR_TOKENS = [
  ["background", "bg-background"],
  ["card", "bg-card"],
  ["popover", "bg-popover"],
  ["muted", "bg-muted"],
  ["primary", "bg-primary"],
  ["strong-foreground", "bg-strong-foreground"],
  ["foreground", "bg-foreground"],
  ["muted-foreground", "bg-muted-foreground"],
  ["dim-foreground", "bg-dim-foreground"],
  ["placeholder", "bg-placeholder"],
  ["hairline", "bg-hairline"],
  ["divider", "bg-divider"],
  ["success", "bg-success"],
  ["warning", "bg-warning"],
  ["error", "bg-error"],
  ["info", "bg-info"],
  ["merged", "bg-merged"],
  ["ring", "bg-ring"],
] as const;

const TEXT_TIERS = [
  ["strong-foreground", "text-strong-foreground", "Titles and the current item"],
  ["foreground", "text-foreground", "Body text"],
  ["secondary-label", "text-secondary-label", "Secondary labels"],
  ["muted-foreground", "text-muted-foreground", "Descriptions, idle icons"],
  ["dim-foreground", "text-dim-foreground", "Meta, captions, section labels"],
  ["placeholder", "text-placeholder", "Placeholders"],
] as const;

const TYPE_ROLES = [
  ["title", "22 / 600", "Page and section titles"],
  ["prompt", "14 / 400", "The prompt, search fields, chat bubbles"],
  ["label", "14 / 500", "Row titles, button and menu labels"],
  ["body", "14 / 400", "Descriptions and running copy"],
  ["meta", "12 / 500", "Chips, metadata, small section headings"],
  ["caption", "11 / 500", "Key hints, status, captions"],
  ["micro", "10 / 500", "Status pills and counters in tight chrome"],
] as const;

const RADII = [
  ["kbd", "rounded-kbd"],
  ["badge", "rounded-badge"],
  ["row", "rounded-row"],
  ["item", "rounded-item"],
  ["control", "rounded-control"],
  ["card", "rounded-card"],
  ["pane", "rounded-pane"],
] as const;

const SURFACES = [
  ["surface-raised", "surface-raised", "Secondary buttons, select triggers"],
  ["surface-lit", "surface-lit", "Primary buttons"],
  ["surface-well", "surface-well", "Inputs, unchecked controls"],
  ["surface-card", "surface-card", "In-flow cards"],
  ["surface-card-settings", "surface-card-settings", "Settings groups"],
  ["surface-panel", "surface-panel", "Approval and question panels"],
  ["surface-popover", "surface-popover", "Menus and popovers"],
  ["surface-tooltip", "surface-tooltip", "Tooltips"],
  ["surface-tray", "surface-tray", "The composer tray"],
  ["surface-selected", "surface-selected", "The current item"],
  ["surface-ghost-hover", "surface-ghost-hover", "Hover on chrome-less controls"],
] as const;

const PROVIDER_LOGOS = [
  ["openai", OpenAI],
  ["claude", ClaudeAI],
  ["github", getSourceControlPresentationForKind("github").Icon],
  ["cursor", CursorIcon],
  ["trae", TraeIcon],
  ["apple", AppleIcon],
  ["android", AndroidIcon],
  ["gitlab", getSourceControlPresentationForKind("gitlab").Icon],
  ["azure-devops", getSourceControlPresentationForKind("azure-devops").Icon],
  ["bitbucket", getSourceControlPresentationForKind("bitbucket").Icon],
  ["forgejo", getSourceControlPresentationForKind("forgejo").Icon],
  ["jujutsu", JujutsuIcon],
  ["git", GitIcon],
  ["kiro", KiroIcon],
  ["antigravity", AntigravityIcon],
  ["linux", LinuxIcon],
  ["acp-registry", ACPRegistryIcon],
] as const;

function FoundationsSection() {
  return (
    <Section
      id="foundations"
      title="Foundations"
      layer="tokens"
      description="Theme tokens and surface recipes. Components read these; feature code should rarely name one directly. Custom themes and the surface-style setting repaint everything here."
    >
      <Specimen label="Color roles" source="bg-* / text-* tokens">
        <div className="grid w-full grid-cols-3 gap-3 sm:grid-cols-6">
          {COLOR_TOKENS.map(([name, className]) => (
            <div key={name} className="flex flex-col gap-1.5">
              <div className={`h-10 rounded-control border border-divider ${className}`} />
              <Caption>{name}</Caption>
            </div>
          ))}
        </div>
      </Specimen>
      <Specimen label="Text tiers" stack>
        {TEXT_TIERS.map(([name, className, use]) => (
          <div key={name} className="flex items-baseline gap-3">
            <span className={`w-40 text-sm font-medium ${className}`}>{name}</span>
            <span className="text-xs text-dim-foreground">{use}</span>
          </div>
        ))}
      </Specimen>
      <Specimen label="Type roles" source="<Text variant tone>" stack>
        {TYPE_ROLES.map(([variant, spec, use]) => (
          <div key={variant} className="flex items-baseline gap-4">
            <span className="w-32 shrink-0">
              <Text variant="caption" tone="dim" mono>
                {variant} {spec}
              </Text>
            </span>
            <Text variant={variant}>{use}</Text>
          </div>
        ))}
      </Specimen>
      <Specimen label="Radii by role" source="rounded-{role}">
        {RADII.map(([name, className]) => (
          <Cell key={name} caption={name}>
            <div className={`size-12 border border-divider surface-raised ${className}`} />
          </Cell>
        ))}
      </Specimen>
      <Specimen label="Surface recipes" source="surface-*">
        <div className="grid w-full grid-cols-2 gap-4 sm:grid-cols-4">
          {SURFACES.map(([name, className, use]) => (
            <div key={name} className="flex flex-col gap-1.5">
              <div className={`h-14 rounded-control ${className}`} />
              <Caption>{name}</Caption>
              <span className="text-2xs text-dim-foreground">{use}</span>
            </div>
          ))}
        </div>
      </Specimen>
      <Specimen label="Provider logos" source="~/components/Icons">
        {PROVIDER_LOGOS.map(([name, Logo]) => (
          <Cell key={name} caption={name}>
            <Logo aria-hidden className="size-6 text-foreground" />
          </Cell>
        ))}
      </Specimen>
    </Section>
  );
}

/* Surfaces grid */

const SURFACE_STYLE_LABELS: Record<SurfaceStyle, string> = {
  "gradient-rim": "Standard",
  flat: "Flat",
  "soft-gradient": "Soft",
  "aqua-gloss-full": "Gloss",
  "aqua-blue": "Accent gloss",
  "gradient-rim-everywhere": "Outline",
};

const ALL_SURFACE_UTILITIES = [
  ["surface-raised", "h-8 w-full rounded-control border border-transparent surface-raised"],
  [
    "surface-raised-hover",
    "h-8 w-full rounded-control border border-transparent surface-raised surface-raised-hover",
  ],
  [
    "surface-danger-hover",
    "h-8 w-full rounded-control border border-transparent surface-raised surface-danger-hover",
  ],
  ["surface-lit", "h-8 w-full rounded-control border border-transparent surface-lit"],
  [
    "surface-lit-hover",
    "h-8 w-full rounded-control border border-transparent surface-lit surface-lit-hover",
  ],
  [
    "surface-destructive",
    "h-8 w-full rounded-control border border-transparent surface-destructive",
  ],
  [
    "surface-destructive-hover",
    "h-8 w-full rounded-control border border-transparent surface-destructive surface-destructive-hover",
  ],
  ["surface-dismiss", "h-8 w-full rounded-control border surface-dismiss"],
  ["surface-pill", "h-7 w-full rounded-full border border-transparent surface-pill"],
  [
    "surface-neutral-pill",
    "h-7 w-full rounded-full border border-transparent surface-neutral-pill",
  ],
  ["surface-well", "h-8 w-full rounded-control border border-transparent surface-well"],
  [
    "surface-ghost-field",
    "h-8 w-full rounded-control border border-transparent surface-ghost-field",
  ],
  [
    "surface-ghost-field-focus",
    "h-8 w-full rounded-control border border-transparent surface-ghost-field-focus",
  ],
  ["surface-well-switch", "h-5.5 w-10 rounded-full border border-transparent surface-well-switch"],
  [
    "surface-focus",
    "h-8 w-full rounded-control border border-transparent surface-well surface-focus",
  ],
  [
    "surface-invalid",
    "h-8 w-full rounded-control border border-transparent surface-well surface-invalid",
  ],
  [
    "surface-invalid-focus",
    "h-8 w-full rounded-control border border-transparent surface-well surface-invalid-focus",
  ],
  ["surface-tint", "h-8 w-full rounded-control surface-tint [--surface-tint:var(--info)]"],
  [
    "surface-tint-fill",
    "h-8 w-full rounded-control surface-tint-fill [--surface-tint:var(--warning)]",
  ],
  ["surface-tint-rim", "h-8 w-full rounded-control surface-tint-rim [--surface-tint:var(--info)]"],
  ["surface-popover", "h-8 w-full rounded-card surface-popover"],
  ["surface-tooltip", "h-8 w-full rounded-control surface-tooltip"],
  ["surface-palette", "h-8 w-full rounded-card surface-palette"],
  ["surface-dialog", "h-8 w-full rounded-card surface-dialog"],
  ["surface-card", "h-8 w-full rounded-card surface-card"],
  ["surface-card-fill", "h-8 w-full rounded-card surface-card-fill"],
  ["surface-card-settings", "h-8 w-full rounded-card surface-card-settings"],
  ["surface-card-settings-rim", "h-8 w-full rounded-card surface-card-settings-rim"],
  ["surface-panel", "h-8 w-full rounded-card surface-panel"],
  ["surface-tray", "h-8 w-full rounded-card surface-tray"],
  ["surface-composer-banner", "h-8 w-full rounded-card surface-composer-banner"],
  ["surface-app-panel", "h-8 w-full rounded-card surface-app-panel"],
  ["surface-outline", "h-8 w-full rounded-control border surface-outline"],
  ["surface-badge", "h-6 w-full rounded-badge surface-badge"],
  ["surface-floating", "h-8 w-full rounded-control border surface-floating"],
  [
    "surface-floating-hover",
    "h-8 w-full rounded-control border surface-floating surface-floating-hover",
  ],
  ["surface-media-control", "size-7 rounded-full surface-media-control"],
  ["surface-search-separator", "h-0 w-full border-b surface-search-separator"],
  ["surface-divider-rule", "h-px w-full surface-divider-rule"],
  ["surface-divider-rule-danger", "h-px w-full surface-divider-rule-danger"],
  ["surface-command-input", "h-8 w-full rounded-control surface-command-input"],
  ["surface-command-footer", "h-8 w-full rounded-control surface-command-footer"],
  ["surface-composer", "h-8 w-full rounded-card surface-composer"],
  ["surface-bubble", "h-8 w-full rounded-card surface-bubble"],
  ["surface-bubble-quote", "h-8 w-full rounded-card surface-bubble-quote"],
  ["surface-kbd", "h-6 w-12 rounded-kbd surface-kbd"],
  ["surface-ghost-hover", "h-8 w-full rounded-control surface-ghost-hover"],
  ["surface-selected", "h-8 w-full rounded-control surface-selected"],
  ["surface-selected-soft", "h-8 w-full rounded-control surface-selected-soft"],
  ["surface-pane-tab", "h-7 w-full rounded-control surface-pane-tab"],
  ["surface-sidebar-row-hover", "h-7 w-full rounded-row surface-sidebar-row-hover"],
  ["surface-sidebar-row-selected", "h-7 w-full rounded-row surface-sidebar-row-selected"],
  ["surface-sidebar-row-active", "h-7 w-full rounded-row surface-sidebar-row-active"],
  ["surface-timeline-divider", "h-px w-full surface-timeline-divider"],
  ["surface-timeline-inspector", "h-8 w-full rounded-card surface-timeline-inspector"],
  ["surface-gloss-on", "h-5.5 w-10 rounded-full surface-gloss-on"],
  ["surface-gloss-thumb", "size-5 rounded-full surface-gloss-thumb"],
  ["surface-gloss-off-thumb", "size-5 rounded-full surface-gloss-off-thumb"],
  ["surface-grain", "h-8 w-full rounded-card surface-card surface-grain"],
] as const;

function SurfacesGridSection() {
  return (
    <Section
      id="surfaces"
      title="Surfaces"
      layer="tokens"
      description="Every surface-* utility rendered under all six surface styles via a local preview wrapper. Compare how rims, gradients, shadows and flat fills repaint each role."
    >
      <Specimen
        label="Surface utilities across every surface style"
        source="surface-* under data-surface-preview"
      >
        <div className="w-full overflow-x-auto rounded-card surface-card">
          <table className="w-full min-w-[52rem] table-fixed border-collapse text-left">
            <colgroup>
              <col className="w-48" />
              {SURFACE_STYLES.map((style) => (
                <col key={style} />
              ))}
            </colgroup>
            <thead>
              <tr className="border-b border-divider">
                <th className="px-3 py-2 font-mono text-caption text-dim-foreground">Utility</th>
                {SURFACE_STYLES.map((style) => (
                  <th key={style} className="px-2 py-2 text-center">
                    <div className="truncate text-meta text-foreground">
                      {SURFACE_STYLE_LABELS[style]}
                    </div>
                    <div className="truncate font-mono text-2xs text-dim-foreground">{style}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-divider">
              <tr>
                <td className="px-3 py-2 font-mono text-caption text-muted-foreground">
                  Buttons (reference)
                </td>
                {SURFACE_STYLES.map((style) => (
                  <td key={style} className="px-2 py-2">
                    <div
                      data-surface-preview={style}
                      data-surface-style={style}
                      className="flex items-center justify-center gap-1.5"
                    >
                      <Button render={<span />} size="xs">
                        Ok
                      </Button>
                      <Button render={<span />} size="xs" variant="secondary">
                        Btn
                      </Button>
                    </div>
                  </td>
                ))}
              </tr>
              {ALL_SURFACE_UTILITIES.map(([name, swatchClass]) => (
                <tr key={name}>
                  <td className="px-3 py-1.5 font-mono text-caption text-muted-foreground">
                    {name}
                  </td>
                  {SURFACE_STYLES.map((style) => (
                    <td key={style} className="px-2 py-1.5">
                      <div
                        data-surface-preview={style}
                        data-surface-style={style}
                        className="flex min-h-9 items-center justify-center px-1"
                      >
                        <div className={swatchClass} />
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Specimen>
    </Section>
  );
}

/* Buttons */

const BUTTON_STATES = ["rest", "hover / pressed", "focus", "disabled", "loading"] as const;
const MATRIX_VARIANTS = [
  ["default", "Approve"],
  ["secondary", "Button"],
  ["destructive", "Delete"],
  ["destructive-outline", "Decline"],
  ["ghost", "Ghost"],
] as const satisfies ReadonlyArray<readonly [ButtonVariant, string]>;

/** One variant across every interaction state, using the real Button. */
function ButtonStateRow({ variant, label }: { variant: ButtonVariant; label: string }) {
  return (
    <>
      <Caption>{variant}</Caption>
      <Button variant={variant} size="standard">
        {label}
      </Button>
      <Button variant={variant} size="standard" data-pressed>
        {label}
      </Button>
      <Button variant={variant} size="standard" data-focus-preview>
        {label}
      </Button>
      <Button variant={variant} size="standard" disabled>
        {label}
      </Button>
      <Button variant={variant} size="standard" disabled>
        <Spinner />
        {label}
      </Button>
    </>
  );
}

function ButtonsSection() {
  return (
    <Section
      id="buttons"
      title="Buttons"
      layer="primitive"
      description="One Button with a variant and a size. Use render={<a/>} or render={<MenuTrigger/>} to put the look on another element. InlineButton is the text action inside a sentence."
    >
      <Specimen label="Variants" source={'<Button variant size="standard">'}>
        {BUTTON_VARIANTS.map((variant) => (
          <Cell key={variant} caption={variant}>
            <Button variant={variant} size="standard">
              Button
            </Button>
          </Cell>
        ))}
      </Specimen>
      <Specimen label="Media overlays" source="<Button variant>">
        <div className="relative flex h-24 w-full max-w-md items-center justify-center gap-4 overflow-hidden rounded-card bg-linear-to-br from-info/40 to-merged/40">
          {BUTTON_OVERLAY_VARIANTS.map((variant) => (
            <Cell key={variant} caption={variant}>
              <Button
                variant={variant}
                size="icon-sm"
                aria-label={variant}
                className="static translate-y-0"
              >
                <XIcon />
              </Button>
            </Cell>
          ))}
        </div>
      </Specimen>
      <Specimen label="Text sizes" source="<Button size>">
        {BUTTON_TEXT_SIZES.map((size) => (
          <Cell key={size} caption={size}>
            <Button variant="secondary" size={size}>
              <PlusIcon />
              New thread
            </Button>
          </Cell>
        ))}
      </Specimen>
      <Specimen label="Icon sizes" source="<Button size='icon-*'>">
        {BUTTON_ICON_SIZES.map((size) => (
          <Cell key={size} caption={size}>
            <Button variant="secondary" size={size} aria-label={size}>
              <SettingsIcon />
            </Button>
          </Cell>
        ))}
      </Specimen>
      <Specimen label="States" source="disabled, key hint, spinner">
        <Button>
          Approve <Kbd>⏎</Kbd>
        </Button>
        <Button variant="secondary">
          Decline <Kbd>Esc</Kbd>
        </Button>
        <Button variant="destructive">
          <Trash2Icon />
          Delete <Kbd>⌘⌫</Kbd>
        </Button>
        <Button disabled>Disabled</Button>
        <Button variant="secondary" disabled>
          <Spinner />
          Saving
        </Button>
      </Specimen>
      <Specimen label="State matrix" source="hover = data-pressed, focus = data-focus-preview">
        <div className="grid grid-cols-[auto_repeat(5,auto)] items-center gap-x-4 gap-y-3">
          <span />
          {BUTTON_STATES.map((state) => (
            <Caption key={state}>{state}</Caption>
          ))}
          {MATRIX_VARIANTS.map(([variant, label]) => (
            <ButtonStateRow key={variant} variant={variant} label={label} />
          ))}
        </div>
      </Specimen>
      <Specimen label="Inline" source="<InlineButton tone>">
        <div className="grid grid-cols-3 gap-6">
          <div className="flex flex-col items-start gap-2">
            <Caption>Default</Caption>
            <InlineButton>Undo</InlineButton>
          </div>
          <div className="flex flex-col items-start gap-2">
            <Caption>Muted</Caption>
            <InlineButton tone="muted">Details</InlineButton>
          </div>
          <div className="flex flex-col items-start gap-2">
            <Caption>Destructive</Caption>
            <InlineButton tone="destructive">Remove</InlineButton>
          </div>
        </div>
      </Specimen>
    </Section>
  );
}

/* Controls */

function ControlsSection() {
  const [checked, setChecked] = useState(true);
  const [mode, setMode] = useState("build");
  return (
    <Section
      id="controls"
      title="Controls"
      layer="primitive"
      description="Switch, checkbox, radio and the segmented control. Pair each with a Label; the label is part of the hit target."
    >
      <Specimen label="Switch" source="<Switch size mixed>">
        <Label>
          <Switch checked={checked} onCheckedChange={setChecked} />
          Collapse on scroll
        </Label>
        <Label>
          <Switch size="sm" defaultChecked />
          Small
        </Label>
        <Label>
          <Switch mixed />
          Mixed
        </Label>
        <Label>
          <Switch defaultChecked data-focus-preview />
          Focus
        </Label>
        <Label>
          <Switch disabled />
          Disabled
        </Label>
        <Label>
          <Switch disabled defaultChecked />
          Disabled on
        </Label>
      </Specimen>
      <Specimen label="Checkbox" source="<Checkbox>">
        <Label>
          <Checkbox defaultChecked />
          Checked
        </Label>
        <Label>
          <Checkbox />
          Unchecked
        </Label>
        <Label>
          <Checkbox indeterminate />
          Mixed
        </Label>
        <Label>
          <Checkbox aria-invalid />
          Invalid
        </Label>
        <Label>
          <Checkbox data-focus-preview />
          Focus
        </Label>
        <Label>
          <Checkbox disabled defaultChecked />
          Disabled
        </Label>
      </Specimen>
      <Specimen label="Radio" source="<RadioGroup> <Radio>">
        <RadioGroup defaultValue="remote">
          <Label>
            <Radio value="remote" />
            Remote threads only
          </Label>
          <Label>
            <Radio value="every" />
            Every thread
          </Label>
          <Label>
            <Radio value="none" disabled />
            Disabled
          </Label>
        </RadioGroup>
      </Specimen>
      <Specimen label="Segmented" source="<ToggleGroup variant>">
        <Cell caption="segmented (default)">
          <ToggleGroup value={[mode]} onValueChange={(next) => next[0] && setMode(next[0])}>
            <Toggle value="build">
              <HammerIcon />
              Build
            </Toggle>
            <Toggle value="plan">
              <ListTodoIcon />
              Plan
            </Toggle>
          </ToggleGroup>
        </Cell>
        <Cell caption="default (icon toggles)">
          <ToggleGroup variant="default" defaultValue={["pin"]}>
            <Toggle value="pin" aria-label="Pin">
              <PinIcon />
            </Toggle>
            <Toggle value="archive" aria-label="Archive">
              <ArchiveIcon />
            </Toggle>
          </ToggleGroup>
        </Cell>
        <Cell caption="outline detached">
          <ToggleGroup variant="outline" detached defaultValue={["a"]}>
            <Toggle value="a">Public</Toggle>
            <Toggle value="b">Private</Toggle>
          </ToggleGroup>
        </Cell>
      </Specimen>
    </Section>
  );
}

/* Inputs */

const BRANCH_ITEMS = [
  { value: "main", label: "main" },
  { value: "maria/composer-tray", label: "maria/composer-tray" },
  { value: "julius/redesign", label: "julius/redesign" },
];
const EFFORT_ITEMS = [
  { value: "low", label: "Low" },
  { value: "high", label: "High" },
];

function InputsSection() {
  return (
    <Section
      id="inputs"
      title="Inputs"
      layer="primitive + composed"
      description="Input, Textarea and NumberField are primitives. InputGroup composes an input with addons (icons, key hints, buttons, units) and owns their spacing."
    >
      <Specimen label="Input sizes" source="<Input size>">
        {(["compact", "sm", "default", "lg"] as const).map((size) => (
          <Cell key={size} caption={size}>
            <Input size={size} placeholder="owner/repo" className="w-44" />
          </Cell>
        ))}
      </Specimen>
      <Specimen label="Input states">
        <Cell caption="empty">
          <Input placeholder="owner/repo" className="w-44" />
        </Cell>
        <Cell caption="filled">
          <Input defaultValue="pingdotgg/t3code" className="w-44" />
        </Cell>
        <Cell caption="focus">
          <Input data-focus-preview defaultValue="pingdotgg/t3" className="w-44" />
        </Cell>
        <Cell caption="mono">
          <Input font="mono" defaultValue="~/Development/t3" className="w-44" />
        </Cell>
        <Cell caption="invalid">
          <Input aria-invalid defaultValue="pingdotgg" className="w-44" />
        </Cell>
        <Cell caption="invalid, focus">
          <Input aria-invalid data-focus-preview defaultValue="pingdotgg" className="w-44" />
        </Cell>
        <Cell caption="disabled">
          <Input disabled placeholder="owner/repo" className="w-44" />
        </Cell>
      </Specimen>
      <Specimen label="Field error" source="<Input aria-invalid> <Text tone='destructive'>" stack>
        <div className="flex w-56 flex-col gap-1">
          <Input aria-invalid defaultValue="pingdotgg" />
          <Text variant="caption" tone="destructive">
            Use owner/repo
          </Text>
        </div>
      </Specimen>
      <Specimen label="Ghost input group" source="<InputGroup variant='ghost'>">
        <Cell caption="rest">
          <InputGroup variant="ghost" className="w-48">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput placeholder="Search" />
          </InputGroup>
        </Cell>
        <Cell caption="filled">
          <InputGroup variant="ghost" className="w-48">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput defaultValue="composer" />
          </InputGroup>
        </Cell>
        <Cell caption="focus">
          <InputGroup variant="ghost" className="w-48">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput data-focus-preview defaultValue="composer" />
          </InputGroup>
        </Cell>
      </Specimen>
      <Specimen label="Input group" source="<InputGroup> <InputGroupAddon align>">
        <InputGroup className="w-64">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput placeholder="Search branches…" />
          <InputGroupAddon align="inline-end">
            <Kbd>⌘K</Kbd>
          </InputGroupAddon>
        </InputGroup>
        <InputGroup className="w-48">
          <InputGroupInput defaultValue="30" />
          <InputGroupUnit>days</InputGroupUnit>
        </InputGroup>
        <InputGroup className="w-72">
          <InputGroupInput placeholder="https://github.com/…" />
          <InputGroupAddon align="inline-end">
            <Button size="xs" variant="secondary">
              Clone
            </Button>
          </InputGroupAddon>
        </InputGroup>
      </Specimen>
      <Specimen label="Textarea and number field" source="<Textarea> <NumberField>">
        <Textarea placeholder="Describe the change…" className="w-72" />
        <NumberField defaultValue={3} min={0} className="w-36">
          <NumberFieldGroup>
            <NumberFieldDecrement />
            <NumberFieldInput />
            <NumberFieldIncrement />
          </NumberFieldGroup>
        </NumberField>
      </Specimen>
      <Specimen label="Select" source="<Select> <SelectTrigger variant size>">
        {(["default", "ghost"] as const).map((variant) => (
          <Cell key={variant} caption={`variant ${variant}`}>
            <Select defaultValue="main" items={BRANCH_ITEMS}>
              <SelectTrigger variant={variant} className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {BRANCH_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Cell>
        ))}
        <Cell caption="empty">
          <Select items={BRANCH_ITEMS}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder="Select a branch" />
            </SelectTrigger>
            <SelectPopup>
              {BRANCH_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Cell>
        <Cell caption="focus">
          <Select defaultValue="main" items={BRANCH_ITEMS}>
            <SelectTrigger data-focus-preview className="w-44">
              <SelectValue />
            </SelectTrigger>
          </Select>
        </Cell>
        <Cell caption="invalid">
          <Select items={BRANCH_ITEMS}>
            <SelectTrigger aria-invalid className="w-44">
              <SelectValue placeholder="Select a branch" />
            </SelectTrigger>
          </Select>
        </Cell>
        <Cell caption="disabled">
          <Select defaultValue="main" items={BRANCH_ITEMS} disabled>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
          </Select>
        </Cell>
        {(["xs", "compact", "sm"] as const).map((size) => (
          <Cell key={size} caption={`size ${size}`}>
            <Select defaultValue="high" items={EFFORT_ITEMS}>
              <SelectTrigger size={size} className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {EFFORT_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Cell>
        ))}
      </Specimen>
    </Section>
  );
}

/* Badges and chips */

function BadgesSection() {
  return (
    <Section
      id="badges"
      title="Badges and chips"
      layer="primitive"
      description="Badge carries a state or a count. ContextChip is the inline reference inside running text (files, skills, pull requests); it sizes in em with the text around it."
    >
      <Specimen label="Badge variants" source="<Badge variant>">
        {BADGE_VARIANTS.map((variant) => (
          <Cell key={variant} caption={variant}>
            <Badge variant={variant}>{variant}</Badge>
          </Cell>
        ))}
      </Specimen>
      <Specimen label="Badge sizes" source="<Badge size>">
        {BADGE_SIZES.map((size) => (
          <Cell key={size} caption={size}>
            <Badge variant="secondary" size={size}>
              <BotIcon />
              Working
            </Badge>
          </Cell>
        ))}
      </Specimen>
      <Specimen label="Context chips" source="<ContextChip kind>">
        <p className="text-sm text-foreground">
          Look at{" "}
          <ContextChip kind="file">
            <FileIcon />
            <ContextChipLabel>ChatComposer.tsx</ContextChipLabel>
          </ContextChip>{" "}
          with{" "}
          <ContextChip kind="skill">
            <WrenchIcon />
            <ContextChipLabel>frontend-design</ContextChipLabel>
          </ContextChip>{" "}
          and{" "}
          <ContextChip kind="pr-open">
            <GitBranchIcon />
            <ContextChipLabel>#1234</ContextChipLabel>
          </ContextChip>{" "}
          then{" "}
          <ContextChip kind="terminal">
            <SquareTerminalIcon />
            <ContextChipLabel>vp test</ContextChipLabel>
          </ContextChip>
          .{" "}
          <ContextChip kind="file" state="unresolved">
            <FileIcon />
            <ContextChipLabel>missing.ts</ContextChipLabel>
          </ContextChip>{" "}
          <ContextChip kind="file" state="invalid">
            <CircleAlertIcon />
            <ContextChipLabel>too-large.bin</ContextChipLabel>
          </ContextChip>
        </p>
      </Specimen>
      <Specimen label="Key hints" source="<Kbd> <KbdGroup>">
        <Kbd>⌘K</Kbd>
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>⇧</Kbd>
          <Kbd>P</Kbd>
        </KbdGroup>
        <Kbd>Esc</Kbd>
        <Kbd>
          <ArrowUpIcon />
        </Kbd>
      </Specimen>
      <Specimen label="Diff stats" source="<DiffStatLabel>">
        <DiffStatLabel additions={42} deletions={18} />
        <DiffStatLabel additions={12} deletions={4} font="mono" layout="inline" />
      </Specimen>
    </Section>
  );
}

/* Status and loading */

function StatusSection() {
  return (
    <Section
      id="status"
      title="Status and loading"
      layer="primitive"
      description="Prefer the live label (a shimmer on the row's own text) over a spinner for work in progress. Spinners are for buttons and places with no label. Every animation here is duty-cycled so it does not repaint every frame."
    >
      <Specimen label="Spinner" source="<Spinner size tone>">
        {(["xs", "sm", "md", "lg"] as const).map((size) => (
          <Cell key={size} caption={size}>
            <Spinner size={size} />
          </Cell>
        ))}
        <Cell caption="tone muted">
          <Spinner size="md" tone="muted" />
        </Cell>
      </Specimen>
      <Specimen label="Live label" source="live-tool-shine">
        <span className="live-tool-shine text-sm">Running vp test run ChatComposer</span>
      </Specimen>
      <Specimen label="Status dot" source="<StatusDot tone size pulse ping label>">
        {(["neutral", "success", "warning", "danger", "info", "merged", "foreground"] as const).map(
          (tone) => (
            <Cell key={tone} caption={tone}>
              <StatusDot tone={tone} />
            </Cell>
          ),
        )}
        <Cell caption="pulse">
          <StatusDot tone="info" pulse />
        </Cell>
        <Cell caption="md ping">
          <StatusDot size="md" tone="warning" ping />
        </Cell>
        <Cell caption="md label">
          <StatusDot size="md" tone="success" label="Connected" />
        </Cell>
      </Specimen>
      <Specimen label="Meter" source="<Meter value max tone size>" stack>
        <div className="flex w-72 flex-col gap-3">
          {(
            [
              ["neutral", 64],
              ["success", 88],
              ["warning", 45],
              ["destructive", 92],
            ] as const
          ).map(([tone, value]) => (
            <div key={tone} className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <Caption>{tone}</Caption>
                <Caption>{value}%</Caption>
              </div>
              <Meter value={value} max={100} tone={tone} aria-label={`${tone} meter`} />
            </div>
          ))}
          <div className="flex flex-col gap-1">
            <Caption>size sm</Caption>
            <Meter value={72} max={100} size="sm" aria-label="Small meter" />
          </div>
        </div>
      </Specimen>
      <Specimen label="Skeleton" source="<Skeleton shape>" stack>
        <div className="flex w-72 items-center gap-3">
          <Skeleton shape="pill" className="size-8" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
        <Skeleton shape="card" className="h-16 w-72" />
      </Specimen>
    </Section>
  );
}

/* Groups */

function GroupsSection() {
  const [openSections, setOpenSections] = useState({ pinned: true, settled: false });
  return (
    <Section
      id="groups"
      title="Groups"
      layer="composed"
      description="Composed primitives own the joins between their children: shared borders, radii and separators. Put Buttons, Inputs or Select triggers inside; do not restyle the edges yourself."
    >
      <Specimen label="Button group" source="<Group> <GroupSeparator>">
        <Group>
          <Button variant="secondary">Commit</Button>
          <GroupSeparator />
          <Button variant="secondary" size="icon" aria-label="More">
            <PlusIcon />
          </Button>
        </Group>
        <Group>
          <Button variant="secondary" size="sm">
            Left
          </Button>
          <GroupSeparator />
          <Button variant="secondary" size="sm">
            Middle
          </Button>
          <GroupSeparator />
          <Button variant="secondary" size="sm">
            Right
          </Button>
        </Group>
        <Group orientation="vertical">
          <Button variant="secondary" size="sm">
            Top
          </Button>
          <GroupSeparator orientation="horizontal" />
          <Button variant="secondary" size="sm">
            Bottom
          </Button>
        </Group>
      </Specimen>
      <Specimen label="Input and button" source="<Group>">
        <Group>
          <Input placeholder="Branch name" className="w-48" />
          <GroupSeparator />
          <Button variant="secondary">Create</Button>
        </Group>
      </Specimen>
      <Specimen label="Floating toolbar" source="<FloatingToolbar density orientation>">
        <Cell caption="compact (zoom controls)">
          <FloatingToolbar density="compact">
            <Button size="icon-xs" variant="ghost" aria-label="Zoom out">
              <MinusIcon />
            </Button>
            <Separator orientation="vertical" className="h-3.5" />
            <Button size="icon-xs" variant="ghost" aria-label="Zoom in">
              <PlusIcon />
            </Button>
            <Separator orientation="vertical" className="h-3.5" />
            <Button size="icon-xs" variant="ghost" aria-label="Fit to view">
              <MaximizeIcon />
            </Button>
          </FloatingToolbar>
        </Cell>
        <Cell caption="default (canvas mode switch)">
          <FloatingToolbar>
            <Button variant="secondary" size="xs" aria-pressed>
              3D
            </Button>
            <Button variant="ghost" size="xs" aria-pressed={false}>
              Flat
            </Button>
          </FloatingToolbar>
        </Cell>
      </Specimen>
      <Specimen label="Collapsible section header" source="<CollapsibleSectionHeader tone>" stack>
        <div className="w-72">
          <CollapsibleSectionHeader
            expanded={openSections.pinned}
            onClick={() => setOpenSections((s) => ({ ...s, pinned: !s.pinned }))}
          >
            Pinned
          </CollapsibleSectionHeader>
          <CollapsibleSectionHeader
            expanded={openSections.settled}
            tone="settled"
            accessory={<SectionHeaderStatus>2 failed</SectionHeaderStatus>}
            onClick={() => setOpenSections((s) => ({ ...s, settled: !s.settled }))}
          >
            Settled
          </CollapsibleSectionHeader>
          {(["info", "emphasized", "accent"] as const).map((tone) => (
            <CollapsibleSectionHeader key={tone} expanded tone={tone}>
              {tone}
            </CollapsibleSectionHeader>
          ))}
        </div>
      </Specimen>
      <Specimen label="Labeled section" source="<LabeledSection label>" stack>
        <div className="w-72">
          <LabeledSection label="Local servers">
            <Button variant="secondary" size="sm">
              localhost:5173
            </Button>
            <Button variant="secondary" size="sm">
              localhost:3000
            </Button>
          </LabeledSection>
        </div>
      </Specimen>
      <Specimen label="Separator" source="<Separator>">
        <div className="flex h-8 w-72 items-center gap-3 text-sm text-muted-foreground">
          Left
          <Separator orientation="vertical" />
          Right
        </div>
      </Specimen>
    </Section>
  );
}

/* Panels */

function PanelsSection() {
  return (
    <Section
      id="panels"
      title="Panels"
      layer="composed"
      description="Structured frames for data tables, diffs, maps and inspectors. PanelFrame owns the card surface, radius, toolbar fill, notice strip and hairline dividers."
    >
      <Specimen
        label="Panel frame (default density)"
        source="<PanelFrame.Root> <Toolbar> <Notice> <Body> <Footer>"
      >
        <div className="w-full max-w-xl">
          <PanelFrame.Root>
            <PanelFrame.Toolbar className="justify-between">
              <span className="text-label text-foreground">Diff preview</span>
              <Button size="xs" variant="secondary">
                Refresh
              </Button>
            </PanelFrame.Toolbar>
            <PanelFrame.Notice>
              <span className="min-w-0 flex-1">
                Showing tracked changes. Checking untracked files…
              </span>
              <Button size="xs" variant="secondary">
                Retry
              </Button>
            </PanelFrame.Notice>
            <PanelFrame.Body>
              <p className="p-3 text-body text-muted-foreground">
                Panel body fills the remaining height without painting its own border or radius.
              </p>
            </PanelFrame.Body>
            <PanelFrame.Footer>
              <span>3 files changed</span>
              <span>HEAD</span>
            </PanelFrame.Footer>
          </PanelFrame.Root>
        </div>
      </Specimen>
      <Specimen label="Panel frame (compact density)" source='<PanelFrame.Root density="compact">'>
        <div className="w-full max-w-xl">
          <PanelFrame.Root density="compact">
            <PanelFrame.Toolbar className="justify-between">
              <span className="text-meta text-foreground">metrics.csv</span>
              <span>42 rows</span>
            </PanelFrame.Toolbar>
            <PanelFrame.Notice render={<p />}>
              This preview exceeds the size limit. Changes shown are incomplete.
            </PanelFrame.Notice>
            <PanelFrame.Body>
              <p className="p-3 text-meta text-muted-foreground">
                Compact density pairs caption notices and tight toolbars for dense panes.
              </p>
            </PanelFrame.Body>
            <PanelFrame.Footer>
              <span>UTF-8</span>
              <span>4 columns</span>
            </PanelFrame.Footer>
          </PanelFrame.Root>
        </div>
      </Specimen>
      <Specimen label="Card section" source='<CardSection divided="top" padding>'>
        <div className="w-full max-w-xl rounded-card surface-card">
          <CardSection>
            <div className="text-label text-foreground">t3-workstation</div>
            <p className="text-meta text-muted-foreground">This machine, connected (0.1.11)</p>
          </CardSection>
          <CardSection divided="top">
            <div className="space-y-1.5">
              <div className="text-label text-foreground">Linked machines</div>
              <p className="text-meta text-muted-foreground">
                Sections inside a card separate with border-divider rather than hand-rolled borders.
              </p>
            </div>
          </CardSection>
        </div>
      </Specimen>
    </Section>
  );
}

/* Settings */

function SettingsCatalogSection() {
  const [autoPull, setAutoPull] = useState(true);
  const [mode, setMode] = useState("worktree");
  const [search, setSearch] = useState("");
  return (
    <Section
      id="settings"
      title="Settings"
      layer="meta"
      description="SettingsSection, SettingsRow, SettingsNote, SettingsLoadingRows, SettingsEmptyState and SettingsNoMatches. Settings screens compose these rather than building cards by hand."
    >
      <Specimen
        label="Grouped section with every control kind and notes"
        source='<SettingsSection variant="grouped"> <SettingsRow> <SettingsNote>'
        stack
      >
        <div className="w-full max-w-2xl">
          <SettingsSection
            title="Workspace defaults"
            warning="Applies to newly created threads on this machine."
            headerAction={
              <Button size="xs" variant="secondary">
                Reset all
              </Button>
            }
          >
            <SettingsNote>
              SettingsNote sits flush with rows inside a grouped card for quiet section guidance.
            </SettingsNote>
            <SettingsRow
              leading={<GlobeIcon />}
              title="Auto-pull default branch"
              description="Fetch and fast-forward before starting a new worktree."
              resetAction={
                <SettingResetButton ariaLabel="Reset auto-pull" onClick={() => setAutoPull(true)} />
              }
              control={
                <Switch
                  aria-label="Auto-pull default branch"
                  checked={autoPull}
                  onCheckedChange={setAutoPull}
                />
              }
            />
            <SettingsRow
              title="Default reasoning effort"
              description="Select control inside a settings row."
              control={
                <Select defaultValue="high" items={EFFORT_ITEMS}>
                  <SelectTrigger size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {EFFORT_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
            <SettingsRow
              title="Checkout root"
              description="Text input control inside a settings row."
              control={<Input size="sm" defaultValue="~/Development/t3" className="w-44" />}
            />
            <SettingsRow
              title="Retain logs"
              description="NumberField control inside a settings row."
              control={
                <NumberField defaultValue={30} min={1} className="w-36">
                  <NumberFieldGroup>
                    <NumberFieldDecrement />
                    <NumberFieldInput />
                    <NumberFieldIncrement />
                  </NumberFieldGroup>
                </NumberField>
              }
            />
            <SettingsRow
              title="Thread environment"
              description="Segmented ToggleGroup inside a settings row."
              control={
                <ToggleGroup value={[mode]} onValueChange={(next) => next[0] && setMode(next[0])}>
                  <Toggle value="local">Local</Toggle>
                  <Toggle value="worktree">Worktree</Toggle>
                </ToggleGroup>
              }
            />
            <SettingsRow
              title="Authorized clients"
              description="Action button control inside a settings row."
              status={
                <span className="inline-flex items-center gap-1.5">
                  <StatusDot tone="success" />1 authorized client
                </span>
              }
              control={
                <Button size="sm" variant="secondary">
                  Manage
                </Button>
              }
            />
            <SettingsRow
              title="Advanced diagnostics"
              description="Navigation row with a trailing chevron."
              trailing={<ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />}
            />
            <SettingsNote icon={<TriangleAlertIcon className="text-warning-foreground" />}>
              SettingsNote with an icon leads a one-line warning or caveat.
            </SettingsNote>
          </SettingsSection>
        </div>
      </Specimen>
      <Specimen
        label="Plain section and toolbar"
        source='<SettingsSection variant="plain"> <SettingsToolbar> <SettingsSearchField>'
        stack
      >
        <div className="w-full max-w-2xl">
          <SettingsSection title="Filterable list" variant="plain">
            <SettingsToolbar>
              <SettingsSearchField
                value={search}
                onChange={setSearch}
                placeholder="Search items…"
              />
              <Button size="sm" variant="secondary">
                Add item
              </Button>
            </SettingsToolbar>
            <SettingsNoMatches onClear={() => setSearch("")}>
              No settings match “{search || "telemetry"}”.
            </SettingsNoMatches>
          </SettingsSection>
        </div>
      </Specimen>
      <Specimen label="Loading rows" source="<SettingsLoadingRows count>" stack>
        <div className="w-full max-w-2xl">
          <SettingsSection title="Connected machines">
            <SettingsLoadingRows label="Loading connected machines" count={3} />
          </SettingsSection>
        </div>
      </Specimen>
      <Specimen label="Empty state" source="<SettingsEmptyState>" stack>
        <div className="w-full max-w-2xl rounded-card surface-card p-4">
          <SettingsEmptyState
            icon={<GlobeIcon />}
            title="No linked environments"
            description="Link another machine so agents can run threads there."
          >
            <Button size="sm" variant="secondary">
              Add environment
            </Button>
          </SettingsEmptyState>
        </div>
      </Specimen>
    </Section>
  );
}

/* Menus and overlays */

function OverlaysSection() {
  const [effort, setEffort] = useState("high");
  const [fastMode, setFastMode] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <Section
      id="overlays"
      title="Menus, popovers and dialogs"
      layer="primitive"
      description="Every floating surface shares the popover recipe. Triggers render a Button (or SelectButton for a picker) through render; never style the trigger element itself."
    >
      <Specimen label="Menu" source="<Menu> <MenuItem variant>">
        <Menu>
          <MenuTrigger render={<SelectButton className="w-56" />}>maria/composer-tray</MenuTrigger>
          <MenuPopup align="start">
            <MenuGroup>
              <MenuGroupLabel>Reasoning</MenuGroupLabel>
              <MenuRadioGroup value={effort} onValueChange={setEffort}>
                <MenuRadioItem value="low">Low</MenuRadioItem>
                <MenuRadioItem value="medium">Medium</MenuRadioItem>
                <MenuRadioItem value="high">High</MenuRadioItem>
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
            <MenuCheckboxItem variant="switch" checked={fastMode} onCheckedChange={setFastMode}>
              Fast mode
            </MenuCheckboxItem>
            <MenuSeparator />
            <MenuItem>
              <CopyIcon />
              Copy branch name
              <MenuShortcut>⌘C</MenuShortcut>
            </MenuItem>
            <MenuItem variant="destructive">
              <Trash2Icon />
              Delete branch
            </MenuItem>
          </MenuPopup>
        </Menu>
        <Menu>
          <MenuTrigger render={<Button variant="ghost" size="icon" aria-label="Thread actions" />}>
            <SettingsIcon />
          </MenuTrigger>
          <MenuPopup>
            <MenuItem>
              <PinIcon />
              Pin
            </MenuItem>
            <MenuItem>
              <ArchiveIcon />
              Settle
            </MenuItem>
          </MenuPopup>
        </Menu>
      </Specimen>
      <Specimen label="Tooltip" source="<Tooltip> <TooltipPopup variant>">
        {(["default", "popover", "code"] as const).map((variant) => (
          <Tooltip key={variant}>
            <TooltipTrigger render={<Button variant="secondary" size="sm" />}>
              {variant}
            </TooltipTrigger>
            <TooltipPopup variant={variant}>
              {variant === "code" ? "pnpm vitest run ChatComposer" : "Attach files"}{" "}
              {variant === "default" ? <Kbd>⌘U</Kbd> : null}
            </TooltipPopup>
          </Tooltip>
        ))}
      </Specimen>
      <Specimen label="Popover" source="<Popover> <PopoverPopup>">
        <Popover>
          <PopoverTrigger render={<Button variant="secondary" size="sm" />}>
            Open popover
          </PopoverTrigger>
          <PopoverPopup>
            <div className="flex w-64 flex-col gap-2 py-2">
              <PopoverTitle>Remote threads</PopoverTitle>
              <p className="text-sm text-muted-foreground">
                Threads that ran on another machine stay there until you open them.
              </p>
            </div>
          </PopoverPopup>
        </Popover>
      </Specimen>
      <Specimen label="Dialogs" source="<Dialog> <AlertDialog>">
        <Dialog>
          <DialogTrigger render={<Button variant="secondary" size="sm" />}>Dialog</DialogTrigger>
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>Rename thread</DialogTitle>
              <DialogDescription>Names show in the sidebar and the tab.</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <Input defaultValue="Composer tray redesign" />
            </DialogPanel>
            <DialogFooter>
              <Button variant="secondary">Cancel</Button>
              <Button>Save</Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
        <Button variant="destructive-outline" size="sm" onClick={() => setConfirmOpen(true)}>
          Alert dialog
        </Button>
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete thread?</AlertDialogTitle>
              <AlertDialogDescription>
                This deletes “Composer tray redesign” and its chat history. You can't undo this.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="secondary" />}>Cancel</AlertDialogClose>
              <AlertDialogClose render={<Button variant="destructive" />}>
                Delete thread
              </AlertDialogClose>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </Specimen>
    </Section>
  );
}

/* Command palette */

const PALETTE_GROUPS: ReadonlyArray<CommandPaletteGroup> = [
  {
    value: "actions",
    label: "Actions",
    items: [
      paletteItem("new-thread", "New thread", <PlusIcon />, "Start a thread in this project"),
      paletteItem("add-project", "Add project", <FolderIcon />),
      paletteItem("settings", "Open settings", <SettingsIcon />),
      paletteItem("theme", "Change theme", <PaletteIcon />, "Dark, light, or a custom theme"),
    ],
  },
  {
    value: "threads",
    label: "Recent threads",
    items: [
      paletteItem("t1", "Composer tray redesign", <BotIcon />, "maria/composer-tray", "2m"),
      paletteItem("t2", "Nightly typecheck", <BotIcon />, "main", "1h"),
      paletteItem("t3", "Model picker polish", <BotIcon />, "julius/picker", "3d"),
    ],
  },
];

function paletteItem(
  value: string,
  title: string,
  icon: ReactNode,
  description?: string,
  timestamp?: string,
): CommandPaletteActionItem {
  return {
    kind: "action",
    value,
    title,
    icon,
    searchTerms: [title],
    ...(description ? { description } : {}),
    ...(timestamp ? { timestamp } : {}),
    run: async () => {
      toastManager.add({ type: "info", title: `Ran “${title}”` });
    },
  };
}

function filterPaletteGroups(query: string): ReadonlyArray<CommandPaletteGroup> {
  const needle = query.trim().toLowerCase();
  if (!needle) return PALETTE_GROUPS;
  return PALETTE_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) =>
      item.searchTerms.some((term) => term.toLowerCase().includes(needle)),
    ),
  })).filter((group) => group.items.length > 0);
}

/**
 * The ui/command parts with the palette's result rows. autoFocus is off so the
 * page does not jump here on load; CommandPaletteContent always takes focus.
 */
function InlinePaletteDemo() {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  return (
    <Command
      aria-label="Command palette parts"
      mode="none"
      value={query}
      onValueChange={setQuery}
      onItemHighlighted={(value) => setHighlighted(typeof value === "string" ? value : null)}
    >
      <CommandInput autoFocus={false} placeholder="Search threads, projects, and commands…" />
      <CommandPanel className="max-h-80">
        <CommandPaletteResults
          groups={filterPaletteGroups(query)}
          highlightedItemValue={highlighted}
          isActionsOnly={false}
          keybindings={[]}
          onExecuteItem={(item) => {
            if (item.kind === "action") void item.run();
          }}
        />
      </CommandPanel>
      <CommandFooter>
        <KbdGroup>
          <Kbd>Enter</Kbd>
          <span>Run</span>
        </KbdGroup>
      </CommandFooter>
    </Command>
  );
}

/** The real palette chrome and result rows over a static item list. */
function PaletteDemo() {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const groups = filterPaletteGroups(query);
  return (
    <CommandPaletteContent
      aria-label="Command palette demo"
      footerActionLabel="Run"
      inputProps={{ placeholder: "Search threads, projects, and commands…" }}
      mode="none"
      value={query}
      onValueChange={setQuery}
      onItemHighlighted={(value) => setHighlighted(typeof value === "string" ? value : null)}
    >
      <CommandPaletteResults
        groups={groups}
        highlightedItemValue={highlighted}
        isActionsOnly={false}
        keybindings={[]}
        onExecuteItem={(item) => {
          if (item.kind === "action") void item.run();
        }}
      />
    </CommandPaletteContent>
  );
}

function PaletteSection() {
  return (
    <Section
      id="palette"
      title="Command palette"
      layer="meta"
      description="Two layers. ui/command holds the parts (input, panel, rows, footer). CommandPaletteContent composes them into the palette chrome, and a palette mode supplies only its groups. Every search surface (files, threads, add project) reuses that chrome instead of building its own."
    >
      <Specimen label="Parts" source="<Command> <CommandInput> <CommandPanel> <CommandFooter>">
        <div className="w-full max-w-xl overflow-hidden rounded-pane surface-palette">
          <InlinePaletteDemo />
        </div>
      </Specimen>
      <Specimen
        label="Palette in its dialog"
        source="<CommandDialogPopup> <CommandPaletteContent> <CommandPaletteResults>"
      >
        <CommandDialog>
          <CommandDialogTrigger render={<Button variant="secondary" size="sm" />}>
            <SearchIcon />
            Open palette
          </CommandDialogTrigger>
          <CommandDialogPopup aria-label="Command palette demo" className="overflow-hidden">
            <PaletteDemo />
          </CommandDialogPopup>
        </CommandDialog>
      </Specimen>
    </Section>
  );
}

/* Feedback */

function FeedbackSection() {
  return (
    <Section
      id="feedback"
      title="Feedback"
      layer="primitive + meta"
      description="Alert is an in-flow notice with icon, title, description and action slots it lays out itself. Toasts come from toastManager. Empty is a slot-based empty state."
    >
      <Specimen label="Alert variants" source="<Alert variant>" stack>
        {ALERT_VARIANTS.map((variant) => (
          <Alert key={variant} variant={variant} className="w-full max-w-lg">
            {variant === "error" || variant === "warning" ? <TriangleAlertIcon /> : <BellIcon />}
            <AlertTitle>
              {variant === "default" ? "Some requests are slow" : `${variant} alert`}
            </AlertTitle>
            <AlertDescription>Reconnect this device to keep working on it.</AlertDescription>
            <AlertAction>
              <Button size="xs" variant="secondary">
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ))}
      </Specimen>
      <Specimen
        label="Strip alerts (inside a card)"
        source='<Alert variant density="strip" edge>'
        stack
      >
        <div className="w-full max-w-lg overflow-clip rounded-card surface-card">
          <CardSection>
            <div className="text-label text-foreground">Diff panel</div>
            <p className="text-meta text-muted-foreground">
              Full-width tinted strips sit flush inside cards and panels with no outer radius.
            </p>
          </CardSection>
          {(["warning", "error", "info"] as const).map((variant) => (
            <Alert key={variant} variant={variant} density="strip" edge="top">
              {variant === "info" ? <BellIcon /> : <TriangleAlertIcon />}
              {variant === "warning"
                ? "Diff too large to display."
                : variant === "error"
                  ? "Could not reach the device host."
                  : "Showing tracked changes only."}
              <AlertAction>
                <Button size="xs" variant="secondary">
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          ))}
        </div>
      </Specimen>
      <Specimen label="Toasts" source="toastManager.add({ type })">
        {(["success", "error", "info", "warning", "loading"] as const).map((type) => (
          <Button
            key={type}
            variant="secondary"
            size="sm"
            onClick={() =>
              toastManager.add({
                type,
                title:
                  type === "success"
                    ? "Pull request approved"
                    : type === "error"
                      ? "The review could not be submitted"
                      : type === "warning"
                        ? "Update required"
                        : type === "loading"
                          ? "Downloading runtime"
                          : "Some requests are slow",
                description:
                  type === "error"
                    ? "Your draft is kept. Try again when the host is reachable."
                    : undefined,
              })
            }
          >
            {type}
          </Button>
        ))}
      </Specimen>
      <Specimen label="Empty state" source="<Empty size> <EmptyMedia variant>">
        <Stage>
          <Empty size="compact">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GlobeIcon />
              </EmptyMedia>
              <EmptyTitle>No preview yet</EmptyTitle>
              <EmptyDescription>
                Start a dev server or open a URL. Agents can open pages here too.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="secondary" size="sm">
                Open URL
              </Button>
            </EmptyContent>
          </Empty>
        </Stage>
      </Specimen>
    </Section>
  );
}

/* Work log */

function WorkLogSection() {
  const [expanded, setExpanded] = useState(true);
  return (
    <Section
      id="worklog"
      title="Work log"
      layer="meta"
      description="The model for a strict meta component: rows take icon, label and trailing slots and nothing else. No className, no style; geometry, spacing and hover all belong to the component."
    >
      <Specimen label="Rows and groups" source="<WorkLogBlock> <WorkLogRow> <WorkLogList>">
        <Stage width="lg">
          <WorkLogBlock>
            <WorkLogRow
              icon={<FileIcon className="size-3.5 text-muted-foreground" />}
              label={
                <>
                  Read <span className="text-foreground">ChatComposer.tsx</span>
                </>
              }
            />
          </WorkLogBlock>
          <WorkLogBlock>
            <WorkLogRow
              icon={<FilePenIcon className="size-3.5 text-muted-foreground" />}
              label={
                <>
                  Edit <span className="text-foreground">ChatComposer.tsx</span>
                </>
              }
              trailing={<DiffStatLabel additions={42} deletions={18} layout="inline" />}
            />
          </WorkLogBlock>
          <WorkLogBlock>
            <WorkLogRow
              icon={<SquareTerminalIcon className="size-3.5 text-muted-foreground" />}
              label={<span className="live-tool-shine">Running pnpm vitest run ChatComposer</span>}
            />
          </WorkLogBlock>
          <WorkLogBlock layout="group-header" continues>
            <WorkLogButton
              icon={<ListTodoIcon className="size-3.5 text-muted-foreground" />}
              label="Read 3 files and ran 2 commands"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            />
          </WorkLogBlock>
          {expanded ? (
            <WorkLogBlock layout="group-content">
              <WorkLogList>
                {["ChatComposer.tsx", "composerFooterLayout.ts", "ComposerBanner.tsx"].map(
                  (file) => (
                    <WorkLogRow
                      key={file}
                      icon={<FileIcon className="size-3.5 text-muted-foreground" />}
                      label={
                        <>
                          Read <span className="text-foreground">{file}</span>
                        </>
                      }
                    />
                  ),
                )}
              </WorkLogList>
            </WorkLogBlock>
          ) : null}
          <WorkLogBlock>
            <WorkLogRow
              icon={<SquareTerminalIcon className="size-3.5 text-muted-foreground" />}
              label="Ran pnpm vitest run ChatComposer"
            >
              <WorkLogDetails kind="panel">
                <code className="font-mono text-xs text-muted-foreground">✓ 42 passed (1.8s)</code>
              </WorkLogDetails>
            </WorkLogRow>
          </WorkLogBlock>
          <WorkLogBlock>
            <TimelineSystemDivider
              placement="turn"
              label="Run interrupted"
              detail="Stopped by user"
              icon={CircleStopIcon}
              wrapDetail
            />
          </WorkLogBlock>
          <TimelineSystemDivider
            label="Forked from conversation"
            icon={GitForkIcon}
            actionLabel="Open source conversation"
            onAction={() => {}}
          />
          <TimelineSystemDivider label="New session" icon={EraserIcon} />
          <TimelineSystemDivider
            label="Context handoff"
            detail="Claude → Codex"
            icon={ArrowRightLeftIcon}
            tone="danger"
          />
        </Stage>
      </Specimen>
    </Section>
  );
}

/* Composer parts */

const TASK_STEPS = [
  { id: "read", text: "Read the composer banner callers", status: "completed", durationMs: 4000 },
  { id: "rows", text: "Move every row onto one anatomy", status: "running" },
  { id: "check", text: "Capture the stack before and after", status: "pending" },
] as const;

function ComposerSection() {
  return (
    <Section
      id="composer"
      title="Composer parts"
      layer="meta"
      description="The composer's status lines and request cards. Every line above the composer is one ComposerBanner row."
    >
      <Specimen label="Status lines" source="<ComposerBanner.Root variant>">
        <Stage width="lg">
          <div className="flex flex-col overflow-hidden rounded-card surface-tray">
            <ComposerBanner.Dock>
              {(["default", "info", "warning", "error", "success"] as const).map((variant) => (
                <ComposerBanner.Root key={variant} variant={variant}>
                  <ComposerBanner.Row>
                    <ComposerBanner.Icon>
                      {variant === "error" || variant === "warning" ? (
                        <TriangleAlertIcon />
                      ) : (
                        <BellIcon />
                      )}
                    </ComposerBanner.Icon>
                    <ComposerBanner.Content>
                      <span className={composerBannerTitleClassName}>{variant} status line</span>
                      <span className={composerBannerDetailClassName}>Resets 4:00 PM</span>
                    </ComposerBanner.Content>
                    <ComposerBanner.Actions>
                      <Button size="xs" variant="ghost-muted">
                        Action
                      </Button>
                      <ComposerBanner.Dismiss aria-label="Dismiss" />
                    </ComposerBanner.Actions>
                  </ComposerBanner.Row>
                </ComposerBanner.Root>
              ))}
            </ComposerBanner.Dock>
          </div>
        </Stage>
      </Specimen>
      <Specimen label="Task list" source="<ComposerTaskStatus>">
        <Stage width="lg">
          <div className="flex flex-col overflow-hidden rounded-card surface-tray">
            <ComposerTaskStatus steps={TASK_STEPS} />
          </div>
        </Stage>
      </Specimen>
      <Specimen label="Tray actions" source="Button in the tray">
        <Stage>
          <div className="flex items-center gap-1 rounded-card p-2 surface-tray">
            <Button variant="ghost" size="icon-sm" aria-label="Attach">
              <PaperclipIcon />
            </Button>
            <Button variant="ghost-muted" size="xs">
              <HammerIcon />
              Build
            </Button>
            <span className="flex-1" />
            <Button variant="ghost" size="icon-sm" aria-label="Dictate">
              <MicIcon />
            </Button>
            <Button size="icon-sm" aria-label="Send">
              <ArrowUpIcon />
            </Button>
          </div>
        </Stage>
      </Specimen>
    </Section>
  );
}
