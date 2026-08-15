import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ComputerHistoryClearScope,
  ComputerHistoryStatus,
  ComputerHistoryTimelineItem,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { ComputerHistoryPrivacyDialog } from "./ComputerHistoryPrivacyControls";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function isDesktopHost(): boolean {
  return typeof window !== "undefined" && window.desktopBridge !== undefined;
}

function RowTitle({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center gap-2">{children}</span>;
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
          title={<RowTitle>Paused</RowTitle>}
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
          title={<RowTitle>Mirror to Codex skysight</RowTitle>}
          description="Also write memories under ~/.codex/memories/extensions/skysight/"
          control={
            <Switch
              checked={history.mirrorToCodex}
              onCheckedChange={(checked) => patch({ mirrorToCodex: Boolean(checked) })}
              aria-label="Mirror Computer History to Codex"
            />
          }
        />

        {status ? (
          <SettingsRow
            title={<RowTitle>Recorder status</RowTitle>}
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
          title={<RowTitle>Excluded apps &amp; websites</RowTitle>}
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
        {(history.apps.length > 0 || history.websites.length > 0) &&
        (history.apps.length !== defaults.apps.length ||
          history.websites.length !== defaults.websites.length) ? (
          <div className="flex justify-end px-3 pb-2 sm:px-4">
            <SettingResetButton
              label="exclusions"
              onClick={() =>
                patch({
                  apps: [...defaults.apps],
                  websites: [...defaults.websites],
                  appFilterMode: "exclude",
                  websiteFilterMode: "exclude",
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
