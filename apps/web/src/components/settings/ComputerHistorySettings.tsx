import { useCallback, useEffect, useRef, useState } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import type {
  ComputerHistoryClearScope,
  ComputerHistoryStatus,
  ComputerHistoryTimelineItem,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  SettingIconAction,
  SettingResetButton,
  SettingRowTitle,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function isDesktopHost(): boolean {
  return typeof window !== "undefined" && window.desktopBridge !== undefined;
}

function normalizeEntry(value: string): string {
  return value.trim();
}

function PrivacyExclusionList({
  title,
  addLabel,
  placeholder,
  items,
  onChange,
  disabled,
}: {
  title: string;
  addLabel: string;
  placeholder: string;
  items: ReadonlyArray<string>;
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const commit = () => {
    const next = normalizeEntry(draft);
    if (!next) {
      setAdding(false);
      setDraft("");
      return;
    }
    const lowered = next.toLowerCase();
    if (items.some((item) => item.toLowerCase() === lowered)) {
      setDraft("");
      setAdding(false);
      return;
    }
    onChange([...items, next]);
    setDraft("");
    setAdding(false);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <div className="bg-muted/40 flex min-h-48 flex-col gap-2 rounded-xl border border-border/60 p-3">
        {adding ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              commit();
            }}
          >
            <Input
              autoFocus
              value={draft}
              disabled={disabled}
              placeholder={placeholder}
              onValueChange={(value) => setDraft(value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setAdding(false);
                  setDraft("");
                }
              }}
            />
            <Button type="submit" size="sm" disabled={disabled || !normalizeEntry(draft)}>
              Add
            </Button>
          </form>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="justify-start gap-1.5"
            disabled={disabled}
            onClick={() => setAdding(true)}
          >
            <PlusIcon className="size-3.5" />
            {addLabel}
          </Button>
        )}

        {items.length === 0 ? (
          <p className="text-muted-foreground px-0.5 text-xs">None excluded</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {items.map((item) => (
              <li key={item}>
                <div className="flex w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-2 py-1 text-sm">
                  <span className="min-w-0 truncate">{item}</span>
                  <SettingIconAction
                    type="button"
                    disabled={disabled}
                    aria-label={`Remove ${item}`}
                    onClick={() => onChange(items.filter((entry) => entry !== item))}
                  >
                    <XIcon className="size-3" />
                  </SettingIconAction>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ComputerHistoryPrivacyDialog({
  open,
  onOpenChange,
  apps,
  websites,
  disabled,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apps: ReadonlyArray<string>;
  websites: ReadonlyArray<string>;
  disabled?: boolean;
  onSave: (next: { apps: string[]; websites: string[] }) => void;
}) {
  const [draftApps, setDraftApps] = useState<string[]>([...apps]);
  const [draftWebsites, setDraftWebsites] = useState<string[]>([...websites]);

  useEffect(() => {
    if (!open) return;
    setDraftApps([...apps]);
    setDraftWebsites([...websites]);
  }, [open, apps, websites]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Computer History privacy</DialogTitle>
          <DialogDescription>
            Choose apps and websites that should never be recorded. Everything else is included when
            Computer History is on.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <PrivacyExclusionList
              title="Exclude these apps"
              addLabel="Add app"
              placeholder="App name or bundle id"
              items={draftApps}
              onChange={setDraftApps}
              disabled={disabled}
            />
            <PrivacyExclusionList
              title="Exclude these websites"
              addLabel="Add website"
              placeholder="Hostname or URL fragment"
              items={draftWebsites}
              onChange={setDraftWebsites}
              disabled={disabled}
            />
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Private-mode web browsing activity is never included in computer history.
          </p>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
          <Button
            type="button"
            disabled={disabled}
            onClick={() => {
              onSave({ apps: draftApps, websites: draftWebsites });
              onOpenChange(false);
            }}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function ComputerHistorySettings() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const history = settings.computerHistory;
  const defaults = DEFAULT_UNIFIED_SETTINGS.computerHistory;
  const onDesktop = isDesktopHost();
  const [status, setStatus] = useState<ComputerHistoryStatus | null>(null);
  const [items, setItems] = useState<ComputerHistoryTimelineItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);

  const refresh = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge?.getComputerHistoryStatus || !bridge.getComputerHistoryTimeline) return;
    const [nextStatus, timeline] = await Promise.all([
      bridge.getComputerHistoryStatus(),
      bridge.getComputerHistoryTimeline(),
    ]);
    setStatus(nextStatus);
    setItems([...timeline.items]);
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(id);
  }, [refresh, history.enabled, history.paused]);

  const patchQueue = useRef(Promise.resolve());
  const patch = (partial: Partial<typeof history>) => {
    // Persist only the keys being changed so concurrent toggles cannot clobber
    // unrelated nested Computer History fields via a stale full-object snapshot.
    // Serialize desktop IPC patches so rapid toggles cannot complete out of order.
    updateSettings({
      computerHistory: partial,
    });
    const bridge = window.desktopBridge;
    if (!bridge?.patchComputerHistorySettings) return;
    patchQueue.current = patchQueue.current
      .catch(() => undefined)
      .then(async () => {
        const nextStatus = await bridge.patchComputerHistorySettings({
          ...(partial.enabled === undefined ? {} : { enabled: partial.enabled }),
          ...(partial.paused === undefined ? {} : { paused: partial.paused }),
          ...(partial.mirrorToCodex === undefined ? {} : { mirrorToCodex: partial.mirrorToCodex }),
          ...(partial.appFilterMode === undefined ? {} : { appFilterMode: partial.appFilterMode }),
          ...(partial.apps === undefined ? {} : { apps: [...partial.apps] }),
          ...(partial.websiteFilterMode === undefined
            ? {}
            : { websiteFilterMode: partial.websiteFilterMode }),
          ...(partial.websites === undefined ? {} : { websites: [...partial.websites] }),
        });
        setStatus(nextStatus);
        const timeline = await bridge.getComputerHistoryTimeline?.();
        if (timeline) setItems([...timeline.items]);
      });
  };

  const hasPrivacyOverrides =
    history.apps.length > 0 ||
    history.websites.length > 0 ||
    history.appFilterMode !== defaults.appFilterMode ||
    history.websiteFilterMode !== defaults.websiteFilterMode;

  const exclusionSummary = (() => {
    const appCount = history.apps.length;
    const siteCount = history.websites.length;
    if (appCount === 0 && siteCount === 0) return "No app or website filters";
    const describe = (count: number, noun: string, mode: "exclude" | "includeOnly") => {
      const label = `${count} ${noun}${count === 1 ? "" : "s"}`;
      return mode === "includeOnly" ? `only ${label}` : `excluding ${label}`;
    };
    const parts: string[] = [];
    if (appCount > 0) {
      parts.push(describe(appCount, "app", history.appFilterMode));
    }
    if (siteCount > 0) {
      parts.push(describe(siteCount, "website", history.websiteFilterMode));
    }
    return parts.join(" · ");
  })();

  return (
    <SettingsPageContainer>
      <SettingsSection id="computer-history" title="Computer History">
        <p className="text-muted-foreground mb-3 px-3 text-sm sm:px-4">
          Opt-in activity timeline from accessibility events (not screenshots). Summaries become
          local memories agents can reference. Requires Accessibility (macOS), UI Automation
          (Windows), or AT-SPI (Linux).
        </p>
        {!onDesktop ? (
          <p className="text-muted-foreground mb-3 px-3 text-sm sm:px-4">
            Computer History recording runs in the T3 Code desktop app.
          </p>
        ) : null}

        <SettingsRow
          {...searchableSetting("computer-history-enabled")}
          description="Turn on background interaction capture"
          resetAction={
            history.enabled !== defaults.enabled ? (
              <SettingResetButton
                label="computer history"
                onClick={() => patch({ enabled: defaults.enabled })}
              />
            ) : null
          }
          control={
            <Switch
              checked={history.enabled}
              disabled={!onDesktop}
              onCheckedChange={(checked) => patch({ enabled: Boolean(checked) })}
              aria-label="Enable Computer History"
            />
          }
        />

        <SettingsRow
          title={<SettingRowTitle>Paused</SettingRowTitle>}
          description="Stop collecting new events without turning the feature off"
          control={
            <Switch
              checked={history.paused}
              disabled={!onDesktop || !history.enabled}
              onCheckedChange={(checked) => patch({ paused: Boolean(checked) })}
              aria-label="Pause Computer History"
            />
          }
        />

        <SettingsRow
          title={<SettingRowTitle>Mirror to Codex skysight</SettingRowTitle>}
          description="Also write memories under ~/.codex/memories/extensions/skysight/"
          control={
            <Switch
              checked={history.mirrorToCodex}
              disabled={!onDesktop}
              onCheckedChange={(checked) => patch({ mirrorToCodex: Boolean(checked) })}
              aria-label="Mirror Computer History to Codex"
            />
          }
        />

        {status ? (
          <SettingsRow
            title={<SettingRowTitle>Recorder status</SettingRowTitle>}
            description={
              status.lastError
                ? status.lastError
                : `Phase: ${status.phase} · events in segment: ${status.eventCount} · platform: ${status.platform}`
            }
            control={
              <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={busy}>
                Refresh
              </Button>
            }
          />
        ) : null}
      </SettingsSection>

      <SettingsSection {...searchableSetting("computer-history-privacy")} title="Privacy">
        <p className="text-muted-foreground mb-3 px-3 text-sm sm:px-4">
          Exclude sensitive apps and websites from Computer History. Private browsing is never
          recorded.
        </p>
        <SettingsRow
          title={<SettingRowTitle>Excluded apps &amp; websites</SettingRowTitle>}
          description={exclusionSummary}
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={!onDesktop}
              onClick={() => setPrivacyOpen(true)}
            >
              Manage
            </Button>
          }
        />
        {hasPrivacyOverrides ? (
          <div className="flex justify-end px-3 pb-2 sm:px-4">
            <SettingResetButton
              label="exclusions"
              onClick={() =>
                patch({
                  apps: [...defaults.apps],
                  websites: [...defaults.websites],
                  appFilterMode: defaults.appFilterMode,
                  websiteFilterMode: defaults.websiteFilterMode,
                })
              }
            />
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection {...searchableSetting("computer-history-timeline")} title="History">
        <p className="text-muted-foreground mb-3 px-3 text-sm sm:px-4">
          Summaries from the local event stream. Clearing deletes events and derived memories.
        </p>
        <div className="flex flex-wrap gap-2 px-3 pb-3 sm:px-4">
          {(
            [
              ["last_ten_minutes", "Clear 10 min"],
              ["last_hour", "Clear hour"],
              ["last_day", "Clear day"],
              ["all", "Clear all"],
            ] as const satisfies ReadonlyArray<readonly [ComputerHistoryClearScope, string]>
          ).map(([scope, label]) => (
            <Button
              key={scope}
              variant="outline"
              size="sm"
              disabled={!onDesktop || busy}
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  try {
                    const timeline = await window.desktopBridge?.clearComputerHistory?.(scope);
                    if (timeline) setItems([...timeline.items]);
                    await refresh();
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        {items.length === 0 ? (
          <p className="text-muted-foreground px-3 text-sm sm:px-4">No summaries yet.</p>
        ) : (
          <ul className="flex flex-col gap-3 px-3 sm:px-4">
            {items.map((item) => (
              <li key={item.id} className="border-border/60 border-b pb-3 last:border-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{item.title}</div>
                    <div className="text-muted-foreground text-xs">
                      {item.level} · {new Date(item.startedAt).toLocaleString()}
                      {item.applications.length > 0
                        ? ` · ${item.applications.slice(0, 3).join(", ")}`
                        : ""}
                    </div>
                    <p className="text-muted-foreground mt-1 text-sm">{item.description}</p>
                    {item.suggestion ? (
                      <p className="mt-1 text-xs">
                        Suggested {item.suggestion.type}: {item.suggestion.name}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void window.desktopBridge?.revealComputerHistoryMemory?.(item.path)
                      }
                    >
                      Reveal
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void (async () => {
                          const timeline =
                            await window.desktopBridge?.deleteComputerHistoryMemory?.(item.path);
                          if (timeline) setItems([...timeline.items]);
                        })();
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      <ComputerHistoryPrivacyDialog
        open={privacyOpen}
        onOpenChange={setPrivacyOpen}
        apps={history.apps}
        websites={history.websites}
        disabled={!onDesktop}
        onSave={({ apps, websites }) =>
          // Preserve existing filter modes — Done only edits the lists.
          patch({ apps, websites })
        }
      />
    </SettingsPageContainer>
  );
}
