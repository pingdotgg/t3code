import type { SidebarV2ThreadGroup, SidebarV2ThreadOrderMode } from "@t3tools/contracts/settings";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const AUTO_SETTLE_MIN_DAYS = 1;
const AUTO_SETTLE_MAX_DAYS = 90;
const AUTO_SETTLE_DEFAULT_DAYS = 3;
const THREAD_ORDER_MODE_LABELS: Record<SidebarV2ThreadOrderMode, string> = {
  created_at: "Static creation order",
  automatic: "Automatic status order",
};
const THREAD_GROUP_DETAILS: Record<SidebarV2ThreadGroup, { label: string; description: string }> = {
  review: {
    label: "Needs review",
    description: "Done, approval, input, failed, plan-ready, and freshly woken threads.",
  },
  working: {
    label: "Working",
    description: "Threads whose agent session is running or connecting.",
  },
  ready: {
    label: "Other active",
    description: "Idle threads and completed threads you have already reviewed.",
  },
};

function moveThreadGroup(
  groups: ReadonlyArray<SidebarV2ThreadGroup>,
  index: number,
  offset: -1 | 1,
): SidebarV2ThreadGroup[] {
  const targetIndex = index + offset;
  if (targetIndex < 0 || targetIndex >= groups.length) return [...groups];
  const reordered = [...groups];
  const [group] = reordered.splice(index, 1);
  if (group === undefined) return reordered;
  reordered.splice(targetIndex, 0, group);
  return reordered;
}

function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number) => void;
}) {
  // Local draft so the field can be emptied mid-edit; the setting only moves
  // on valid input and snaps back to the persisted value on blur.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <Input
      type="number"
      min={AUTO_SETTLE_MIN_DAYS}
      max={AUTO_SETTLE_MAX_DAYS}
      className="w-full sm:w-24"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        // Number(), not parseInt: "3.5" must be rejected (not truncated to a
        // committed 3 while the field shows 3.5) — commit only when the
        // persisted value matches the displayed one.
        const parsed = Number(event.target.value);
        if (
          Number.isInteger(parsed) &&
          parsed >= AUTO_SETTLE_MIN_DAYS &&
          parsed <= AUTO_SETTLE_MAX_DAYS
        ) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label="Days of inactivity before auto-settle"
    />
  );
}

export function BetaSettingsPanel() {
  const sidebarV2Enabled = useClientSettings((settings) => settings.sidebarV2Enabled);
  const sidebarAutoSettleAfterDays = useClientSettings(
    (settings) => settings.sidebarAutoSettleAfterDays,
  );
  const sidebarV2ThreadGroupOrder = useClientSettings(
    (settings) => settings.sidebarV2ThreadGroupOrder,
  );
  const sidebarV2ThreadOrderMode = useClientSettings(
    (settings) => settings.sidebarV2ThreadOrderMode,
  );
  const updateSettings = useUpdateClientSettings();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Beta features">
        <SettingsRow
          title="Sidebar v2"
          description="One flat thread list with configurable ordering. Active work renders as rich cards; settled threads collapse to compact rows. Settling requires an up-to-date server — on older servers threads simply stay active. Switch back any time."
          control={
            <Switch
              checked={sidebarV2Enabled}
              onCheckedChange={(checked) => updateSettings({ sidebarV2Enabled: Boolean(checked) })}
              aria-label="Enable the sidebar v2 beta"
            />
          }
        />
        {sidebarV2Enabled ? (
          <>
            <SettingsRow
              title="Thread ordering"
              description={
                sidebarV2ThreadOrderMode === "automatic"
                  ? "Automatically regroup active threads as their status changes. Within Needs review, the most recent attention event appears first."
                  : "Keep active threads in newest-created-first order. Status changes do not move them."
              }
              control={
                <Select
                  value={sidebarV2ThreadOrderMode}
                  onValueChange={(value) => {
                    if (value === "created_at" || value === "automatic") {
                      updateSettings({ sidebarV2ThreadOrderMode: value });
                    }
                  }}
                >
                  <SelectTrigger className="w-full sm:w-52" aria-label="Sidebar thread ordering">
                    <SelectValue>{THREAD_ORDER_MODE_LABELS[sidebarV2ThreadOrderMode]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem hideIndicator value="created_at">
                      {THREAD_ORDER_MODE_LABELS.created_at}
                    </SelectItem>
                    <SelectItem hideIndicator value="automatic">
                      {THREAD_ORDER_MODE_LABELS.automatic}
                    </SelectItem>
                  </SelectPopup>
                </Select>
              }
            />
            {sidebarV2ThreadOrderMode === "automatic" ? (
              <SettingsRow
                title="Automatic group priority"
                description="Arrange the active-thread groups from top to bottom. Threads move automatically when their status changes."
              >
                <ol className="mt-3 space-y-1 pb-3.5">
                  {sidebarV2ThreadGroupOrder.map((group, index) => {
                    const details = THREAD_GROUP_DETAILS[group];
                    return (
                      <li
                        key={group}
                        className="flex items-center gap-3 rounded-lg border border-border/70 bg-background/40 px-3 py-2"
                      >
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[11px] text-muted-foreground">
                          {index + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-foreground">{details.label}</div>
                          <div className="text-xs leading-5 text-muted-foreground/80">
                            {details.description}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5">
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            disabled={index === 0}
                            aria-label={`Move ${details.label} up`}
                            title={`Move ${details.label} up`}
                            onClick={() =>
                              updateSettings({
                                sidebarV2ThreadGroupOrder: moveThreadGroup(
                                  sidebarV2ThreadGroupOrder,
                                  index,
                                  -1,
                                ),
                              })
                            }
                          >
                            <ArrowUpIcon className="size-3.5" />
                          </Button>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            disabled={index === sidebarV2ThreadGroupOrder.length - 1}
                            aria-label={`Move ${details.label} down`}
                            title={`Move ${details.label} down`}
                            onClick={() =>
                              updateSettings({
                                sidebarV2ThreadGroupOrder: moveThreadGroup(
                                  sidebarV2ThreadGroupOrder,
                                  index,
                                  1,
                                ),
                              })
                            }
                          >
                            <ArrowDownIcon className="size-3.5" />
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </SettingsRow>
            ) : null}
            <SettingsRow
              title="Auto-settle inactive threads"
              description="Threads with no activity for this long settle automatically. Threads on merged or closed PRs always settle."
              control={
                <Switch
                  checked={sidebarAutoSettleAfterDays !== null}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      sidebarAutoSettleAfterDays: checked ? AUTO_SETTLE_DEFAULT_DAYS : null,
                    })
                  }
                  aria-label="Auto-settle inactive threads"
                />
              }
            />
            {sidebarAutoSettleAfterDays !== null ? (
              <SettingsRow
                title="Days of inactivity before auto-settle"
                description="Any new activity un-settles a thread automatically."
                control={
                  <AutoSettleDaysInput
                    value={sidebarAutoSettleAfterDays}
                    onCommit={(days) => updateSettings({ sidebarAutoSettleAfterDays: days })}
                  />
                }
              />
            ) : null}
          </>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
