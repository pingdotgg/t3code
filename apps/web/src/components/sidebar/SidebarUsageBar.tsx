import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useAtomValue } from "@effect/atom-react";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  DEFAULT_CLIENT_SETTINGS,
  type ServerProvider,
  type SidebarUsageBarAlignment,
} from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  type LimitAccount,
} from "@t3tools/shared/usageLimits";
import { formatDuration, limitsNotice } from "@t3tools/shared/usageLimitsCopy";
import { useNavigate } from "@tanstack/react-router";
import { msg, T, useGT, useMessages } from "gt-react";
import {
  AlignHorizontalJustifyCenterIcon,
  AlignHorizontalJustifyEndIcon,
  AlignHorizontalJustifyStartIcon,
  AlignHorizontalSpaceBetweenIcon,
  ArrowRightIcon,
  Settings2Icon,
} from "lucide-react";
import { type MouseEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import type { MessageResolver } from "../../i18n/messages";
import { useNowMinute } from "../../hooks/useNowMinute";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { environmentPresentations } from "../../state/presentation";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useSidebar } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { Toggle } from "../ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { barColor, LimitWindows } from "../usage/UsageLimits";
import {
  buildUsageGauges,
  type ResolvedUsageBarStyle,
  resolveUsageBarStyle,
  type UsageGauge as UsageGaugeData,
} from "./sidebarUsageBar.logic";
import { UsageGauge } from "./UsageGauge";

const LOW_REMAINING_PERCENT = 15;
const PREFIX_CLASS_NAME = "me-1 font-normal text-muted-foreground/70";

function providerLabel(driver: ServerProvider["driver"]): string {
  return providerClients.get(driver)?.label ?? String(driver);
}

function gaugeColor(gauge: UsageGaugeData): string {
  const accent = gauge.accounts.length === 1 ? gauge.accounts[0]?.accentColor : undefined;
  return normalizeProviderAccentColor(accent) ?? barColor(gauge.driver);
}

function useUsageGauges(now: number) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const focus = useClientSettings((settings) => settings.sidebarUsageBarFocus);
  return buildUsageGauges(collectLimitPools(collectLimitAccounts(presentations), now), now, focus);
}

function useBarSettings() {
  const style = useClientSettings((settings) => settings.sidebarUsageBarStyle);
  const alignment = useClientSettings((settings) => settings.sidebarUsageBarAlignment);
  const paceMarks = useClientSettings((settings) => settings.sidebarUsageBarPaceMarks);
  const hidden = useClientSettings((settings) => settings.sidebarUsageBarHidden);
  return { style, alignment, paceMarks, hidden };
}

function gaugeTitle(gauge: UsageGaugeData): string {
  const label = providerLabel(gauge.driver);
  return gauge.name ? `${label} ${gauge.name}` : label;
}

function chipLabel(gauge: UsageGaugeData, resolve: MessageResolver): string {
  const title = gaugeTitle(gauge);
  return gauge.inner
    ? resolve(
        msg(
          "{title}: {innerPercent}% left in the {innerWindow} window, {outerPercent}% left in the {outerWindow} window",
          {
            title,
            innerPercent: gauge.inner.remaining,
            innerWindow: gauge.inner.shortLabel,
            outerPercent: gauge.outer.remaining,
            outerWindow: gauge.outer.shortLabel,
          },
        ),
      )
    : resolve(
        msg("{title}: {percent}% left in the {window} window", {
          title,
          percent: gauge.outer.remaining,
          window: gauge.outer.shortLabel,
        }),
      );
}

function ChipContent({
  gauge,
  style,
  paceMarks,
  now,
}: {
  readonly gauge: UsageGaugeData;
  readonly style: ResolvedUsageBarStyle;
  readonly paceMarks: boolean;
  readonly now: number;
}) {
  const m = useMessages();
  const low = gauge.focus.remaining <= LOW_REMAINING_PERCENT;
  const resetsIn =
    gauge.focus.resetsAt !== null && gauge.focus.resetsAt > now
      ? formatDuration(gauge.focus.resetsAt - now, m)
      : null;
  return (
    <>
      <UsageGauge
        outer={gauge.outer}
        inner={gauge.inner}
        color={gaugeColor(gauge)}
        paceMarks={paceMarks}
      >
        {style === "minimal" ? (
          <span
            className={cn(
              "relative text-4xs font-semibold tabular-nums",
              low ? "text-warning-foreground" : "text-foreground",
            )}
          >
            {gauge.focus.remaining}
          </span>
        ) : (
          <ProviderInstanceIcon
            driverKind={gauge.driver}
            displayName={providerLabel(gauge.driver)}
            className="size-2.5"
            iconClassName="size-2.5 text-foreground/80"
          />
        )}
      </UsageGauge>
      {style === "minimal" ? null : style === "detailed" && gauge.inner ? (
        // Nested arcs do not say which is which, so both windows get a labelled line.
        <span className="flex min-w-0 flex-col gap-0.5 leading-none">
          {[gauge.inner, gauge.outer].map((arc) => (
            <span
              key={arc.window.id}
              className={cn(
                "text-2xs font-semibold whitespace-nowrap tabular-nums",
                arc.remaining <= LOW_REMAINING_PERCENT
                  ? "text-warning-foreground"
                  : "text-foreground",
              )}
            >
              <span className={PREFIX_CLASS_NAME}>{arc.shortLabel}:</span>
              {arc.remaining}%
            </span>
          ))}
        </span>
      ) : (
        <span className="flex min-w-0 flex-col gap-0.5 leading-none">
          <span
            className={cn(
              "text-xs font-semibold whitespace-nowrap tabular-nums",
              low ? "text-warning-foreground" : "text-foreground",
            )}
          >
            {style === "compact" ? (
              <span className={PREFIX_CLASS_NAME}>{gauge.name ?? gauge.focus.shortLabel}:</span>
            ) : null}
            {gauge.focus.remaining}%
          </span>
          {style === "detailed" ? (
            <span className="text-3xs whitespace-nowrap text-muted-foreground tabular-nums">
              {gauge.name ?? gauge.focus.shortLabel}
              {resetsIn ? ` · ${resetsIn}` : ""}
            </span>
          ) : null}
        </span>
      )}
    </>
  );
}

const CHIP_CLASS_NAME =
  "inline-flex h-7.5 shrink-0 items-center gap-1.5 rounded-md text-start outline-none";

const ALIGNMENT_CLASS_NAME: Record<SidebarUsageBarAlignment, string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  spread: "justify-between",
};

function UsageStrip({
  gauges,
  width,
  renderChip,
}: {
  readonly gauges: readonly UsageGaugeData[];
  readonly width: number;
  readonly renderChip: (gauge: UsageGaugeData, style: ResolvedUsageBarStyle) => ReactNode;
}) {
  const { style, alignment } = useBarSettings();
  const resolved = resolveUsageBarStyle(style, gauges.length, width);
  return (
    <div
      className={cn(
        "flex min-h-8 flex-wrap items-center gap-1",
        gauges.length === 1 && alignment === "spread"
          ? "justify-center"
          : ALIGNMENT_CLASS_NAME[alignment],
      )}
    >
      {gauges.map((gauge) => renderChip(gauge, resolved))}
    </div>
  );
}

function AccountLabel({ account }: { readonly account: LimitAccount }) {
  const gt = useGT();
  const label = account.displayName ?? account.email ?? providerLabel(account.driver);
  return label.includes("@") ? (
    <RedactedSensitiveText
      key={label}
      value={label}
      ariaLabel={gt("Toggle account label visibility")}
      revealTooltip={gt("Click to reveal account")}
      hideTooltip={gt("Click to hide account")}
      className="max-w-full truncate align-bottom font-sans text-xs leading-normal"
    />
  ) : (
    label
  );
}

function UsageCard({
  gauge,
  now,
  onCustomize,
  onOpenUsage,
}: {
  readonly gauge: UsageGaugeData;
  readonly now: number;
  readonly onCustomize: () => void;
  readonly onOpenUsage: () => void;
}) {
  const m = useMessages();
  const gt = useGT();
  const label = gaugeTitle(gauge);
  const shown = new Set(gauge.windows.map((arc) => arc.window.id));
  const checkedAt = gauge.accounts
    .map((account) => account.limits.checkedAt)
    .sort()
    .at(-1);
  return (
    <div className="flex w-80 max-w-full flex-col gap-2.5">
      <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
        <ProviderInstanceIcon
          driverKind={gauge.driver}
          displayName={label}
          className="size-4"
          iconClassName="size-4 text-foreground/80"
        />
        <span className="truncate">{label}</span>
        {gauge.plan ? (
          <span className="shrink-0 text-xs font-normal text-muted-foreground">{gauge.plan}</span>
        ) : null}
      </div>
      {gauge.accounts.map((account) => {
        const notice = limitsNotice(account.limits, m);
        return (
          <div key={account.key} className="flex min-w-0 flex-col gap-1">
            {gauge.accounts.length > 1 ? (
              <span className="truncate text-xs text-muted-foreground">
                <AccountLabel account={account} />
              </span>
            ) : null}
            {notice ? (
              <span className="text-xs text-muted-foreground">{notice}</span>
            ) : (
              <LimitWindows
                compact
                driver={account.driver}
                accentColor={account.accentColor}
                windows={account.limits.windows.filter((window) => shown.has(window.id))}
                now={now}
              />
            )}
          </div>
        );
      })}
      <div className="flex items-center gap-1 border-t pt-2 text-2xs text-muted-foreground">
        {checkedAt ? (
          <span>{gt("Updated {time}", { time: formatRelativeTimeLabel(checkedAt, now, m) })}</span>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={gt("Customize usage bar")}
          className="ms-auto"
          onClick={onCustomize}
        >
          <Settings2Icon />
        </Button>
        <Button variant="ghost" size="xs" onClick={onOpenUsage}>
          <T>Open Usage</T>
          <ArrowRightIcon />
        </Button>
      </div>
    </div>
  );
}

const STYLE_OPTIONS = [
  { value: "auto", label: msg("Auto", { $context: "usage bar style" }) },
  { value: "detailed", label: msg("Detailed", { $context: "usage bar style" }) },
  { value: "compact", label: msg("Compact", { $context: "usage bar style" }) },
  { value: "minimal", label: msg("Minimal", { $context: "usage bar style" }) },
] as const;

const ALIGNMENT_OPTIONS = [
  {
    value: "start",
    label: msg("Left", { $context: "alignment" }),
    icon: AlignHorizontalJustifyStartIcon,
  },
  {
    value: "center",
    label: msg("Center", { $context: "alignment" }),
    icon: AlignHorizontalJustifyCenterIcon,
  },
  {
    value: "end",
    label: msg("Right", { $context: "alignment" }),
    icon: AlignHorizontalJustifyEndIcon,
  },
  {
    value: "spread",
    label: msg("Spread", { $context: "alignment" }),
    icon: AlignHorizontalSpaceBetweenIcon,
  },
] as const;

const FOCUS_OPTIONS = [
  {
    value: "lowest",
    label: msg("Lowest", { $context: "usage window with the least left" }),
    description: msg("Whichever window has the least left"),
  },
  { value: "short", label: "5h", description: msg("The short window, such as 5 hours") },
  {
    value: "long",
    label: msg("Weekly", { $context: "usage window" }),
    description: msg("The long window, such as a week"),
  },
] as const;

function ControlRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function pick<T extends string>(options: readonly { readonly value: T }[], value: unknown) {
  return options.find((option) => option.value === value)?.value;
}

function setGaugeHidden(hidden: readonly string[], key: string, hide: boolean) {
  void updateClientSettings({
    sidebarUsageBarHidden: hide ? [...hidden, key] : hidden.filter((entry) => entry !== key),
  });
}

function UsageBarControls({ gauges }: { readonly gauges: readonly UsageGaugeData[] }) {
  const { style, alignment, paceMarks, hidden } = useBarSettings();
  const focus = useClientSettings((settings) => settings.sidebarUsageBarFocus);
  const gt = useGT();
  const messages = useMessages();
  return (
    <div className="flex flex-col gap-1.5">
      <ControlRow label={gt("Style", { $context: "usage bar setting" })}>
        <ToggleGroup
          aria-label={gt("Usage bar style")}
          value={[style]}
          onValueChange={(value) => {
            const next = pick(STYLE_OPTIONS, value[0]);
            if (next) void updateClientSettings({ sidebarUsageBarStyle: next });
          }}
        >
          {STYLE_OPTIONS.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {messages(option.label)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </ControlRow>
      <ControlRow label={gt("Alignment")}>
        <ToggleGroup
          aria-label={gt("Usage bar alignment")}
          value={[alignment]}
          onValueChange={(value) => {
            const next = pick(ALIGNMENT_OPTIONS, value[0]);
            if (next) void updateClientSettings({ sidebarUsageBarAlignment: next });
          }}
        >
          {ALIGNMENT_OPTIONS.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              aria-label={messages(option.label)}
            >
              <option.icon className="size-3.5" />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </ControlRow>
      {/* Only Compact and Minimal fit one number for nested arcs; Detailed labels both. */}
      {style === "compact" || style === "minimal" ? (
        <ControlRow label={gt("Number shows")}>
          <ToggleGroup
            aria-label={gt("Window the number reports")}
            value={[focus]}
            onValueChange={(value) => {
              const next = pick(FOCUS_OPTIONS, value[0]);
              if (next) void updateClientSettings({ sidebarUsageBarFocus: next });
            }}
          >
            {FOCUS_OPTIONS.map((option) => (
              <ToggleGroupItem
                key={option.value}
                value={option.value}
                aria-label={messages(option.description)}
                title={messages(option.description)}
              >
                {messages(option.label)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </ControlRow>
      ) : null}
      <ControlRow label={gt("Pace marks")}>
        <Switch
          size="sm"
          checked={paceMarks}
          aria-label={gt("Show pace marks")}
          onCheckedChange={(checked) =>
            void updateClientSettings({ sidebarUsageBarPaceMarks: Boolean(checked) })
          }
        />
      </ControlRow>
      {gauges.length > 1 ? (
        <div className="flex flex-col gap-1.5 pt-1">
          <span className="text-xs text-muted-foreground">
            <T>Gauges</T>
          </span>
          <div className="flex flex-wrap gap-1">
            {gauges.map((gauge) => (
              <Toggle
                key={gauge.key}
                variant="pill"
                size="xs"
                pressed={!hidden.includes(gauge.key)}
                onPressedChange={(pressed) => setGaugeHidden(hidden, gauge.key, !pressed)}
              >
                <ProviderInstanceIcon
                  driverKind={gauge.driver}
                  displayName={providerLabel(gauge.driver)}
                  className="size-3.5"
                  iconClassName="size-3.5"
                />
                {gaugeTitle(gauge)}
              </Toggle>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function resetBarCustomization() {
  void updateClientSettings({
    sidebarUsageBarStyle: DEFAULT_CLIENT_SETTINGS.sidebarUsageBarStyle,
    sidebarUsageBarAlignment: DEFAULT_CLIENT_SETTINGS.sidebarUsageBarAlignment,
    sidebarUsageBarFocus: DEFAULT_CLIENT_SETTINGS.sidebarUsageBarFocus,
    sidebarUsageBarPaceMarks: DEFAULT_CLIENT_SETTINGS.sidebarUsageBarPaceMarks,
    sidebarUsageBarHidden: DEFAULT_CLIENT_SETTINGS.sidebarUsageBarHidden,
  });
}

const PREVIEW_WIDTH = 248;

/** Settings entry point: a preview at a typical sidebar width above the same controls. */
export function SidebarUsageBarDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            <T>Customize usage bar</T>
          </DialogTitle>
        </DialogHeader>
        {open ? <SidebarUsageBarDialogBody /> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={resetBarCustomization}>
            <T>Reset to defaults</T>
          </Button>
          <Button onClick={() => onOpenChange(false)}>
            <T>Done</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function SidebarUsageBarDialogBody() {
  const gt = useGT();
  const messages = useMessages();
  const now = Date.parse(`${useNowMinute()}Z`);
  const gauges = useUsageGauges(now);
  const { paceMarks, hidden } = useBarSettings();
  const visible = gauges.filter((gauge) => !hidden.includes(gauge.key));
  return (
    <DialogPanel>
      <div className="flex flex-col gap-4">
        <div className="flex justify-center rounded-lg border bg-sidebar p-2">
          <div style={{ width: PREVIEW_WIDTH }}>
            {visible.length > 0 ? (
              <UsageStrip
                gauges={visible}
                width={PREVIEW_WIDTH}
                renderChip={(gauge, style) => (
                  <span
                    key={gauge.key}
                    role="img"
                    aria-label={chipLabel(gauge, messages)}
                    className={cn(CHIP_CLASS_NAME, style === "minimal" ? "px-0.5" : "px-1")}
                  >
                    <ChipContent gauge={gauge} style={style} paceMarks={paceMarks} now={now} />
                  </span>
                )}
              />
            ) : (
              <p className="py-2 text-center text-xs text-muted-foreground">
                {gauges.length === 0
                  ? gt("No connected provider reports usage limits yet.")
                  : gt("Every gauge is hidden.")}
              </p>
            )}
          </div>
        </div>
        <UsageBarControls gauges={gauges} />
      </div>
    </DialogPanel>
  );
}

export function SidebarUsageBar() {
  const enabled = useClientSettings((settings) => settings.sidebarUsageBarEnabled);
  return enabled ? <SidebarUsageBarStrip /> : null;
}

function SidebarUsageBarStrip() {
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const now = Date.parse(`${useNowMinute()}Z`);
  const gauges = useUsageGauges(now);
  const { paceMarks, hidden } = useBarSettings();
  const visible = gauges.filter((gauge) => !hidden.includes(gauge.key));
  const [strip, setStrip] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [customizing, setCustomizing] = useState(false);
  const [cardHandle] = useState(() => PopoverCreateHandle<string>());
  const cardActions = useRef<PopoverPrimitive.Root.Actions | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the strip DOM width before paint so Auto picks a style that fits
  useLayoutEffect(() => {
    if (!strip) return;
    const measure = () => setWidth(strip.clientWidth);
    measure();
    return observeResize(strip, measure);
  }, [strip]);

  if (gauges.length === 0) return null;

  const openUsage = () => {
    cardHandle.close();
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/usage" });
  };
  const customize = () => {
    cardHandle.close();
    setCustomizing(true);
  };
  const showMenu = async (event: MouseEvent) => {
    event.preventDefault();
    const chip =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-gauge-key]")
        : null;
    const gauge = visible.find((entry) => entry.key === chip?.dataset.gaugeKey);
    const choice = await ensureLocalApi().contextMenu.show(
      [
        { id: "customize", label: gt("Customize usage bar…") },
        { id: "usage", label: gt("Open Usage") },
        ...(gauge && visible.length > 1
          ? [
              {
                id: "hide-gauge",
                label: gt("Hide {gauge}", { gauge: gaugeTitle(gauge) }),
                separatorBefore: true,
              },
            ]
          : []),
        { id: "hide", label: gt("Hide usage bar"), separatorBefore: !gauge || visible.length < 2 },
      ] as const,
      { x: event.clientX, y: event.clientY },
    );
    if (choice === "customize") customize();
    if (choice === "usage") openUsage();
    if (choice === "hide-gauge" && gauge) setGaugeHidden(hidden, gauge.key, true);
    if (choice === "hide") void updateClientSettings({ sidebarUsageBarEnabled: false });
  };

  return (
    <>
      {/* Popups portal out but still bubble React events, so they stay outside the menu target. */}
      <div ref={setStrip} className="px-1" onContextMenu={(event) => void showMenu(event)}>
        {visible.length > 0 ? (
          <UsageStrip
            gauges={visible}
            width={width}
            renderChip={(gauge, style) => (
              <PopoverTrigger
                key={gauge.key}
                handle={cardHandle}
                payload={gauge.key}
                openOnHover
                render={
                  <button
                    type="button"
                    data-gauge-key={gauge.key}
                    aria-label={chipLabel(gauge, messages)}
                    className={cn(
                      CHIP_CLASS_NAME,
                      style === "minimal" ? "px-0.5" : "px-1",
                      "cursor-pointer hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[popup-open]:bg-accent",
                    )}
                  />
                }
              >
                <ChipContent gauge={gauge} style={style} paceMarks={paceMarks} now={now} />
              </PopoverTrigger>
            )}
          />
        ) : (
          <button
            type="button"
            className="h-8 w-full rounded-md text-start text-xs text-muted-foreground hover:bg-accent"
            onClick={() => setCustomizing(true)}
          >
            <T>Every gauge is hidden. Customize…</T>
          </button>
        )}
      </div>
      <Popover handle={cardHandle} actionsRef={cardActions}>
        {({ payload }) => {
          const gauge = visible.find((entry) => entry.key === payload);
          return gauge ? (
            <PopoverPopup side="top" align="start" sideOffset={6} padding="compact">
              <UsageCard gauge={gauge} now={now} onCustomize={customize} onOpenUsage={openUsage} />
            </PopoverPopup>
          ) : null;
        }}
      </Popover>
      <Popover open={customizing} onOpenChange={setCustomizing}>
        <PopoverPopup anchor={strip} side="top" align="start" sideOffset={6}>
          <div className="flex w-80 flex-col gap-3">
            <span className="text-sm font-medium text-foreground">
              <T>Usage bar</T>
            </span>
            <UsageBarControls gauges={gauges} />
          </div>
        </PopoverPopup>
      </Popover>
    </>
  );
}
