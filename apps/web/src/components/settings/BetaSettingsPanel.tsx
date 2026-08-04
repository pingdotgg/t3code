import { useEffect, useState } from "react";
import {
  DEFAULT_THREAD_AUTO_SETTLE_AFTER_DAYS,
  MAX_THREAD_AUTO_SETTLE_AFTER_DAYS,
  MIN_THREAD_AUTO_SETTLE_AFTER_DAYS,
} from "@t3tools/contracts";

import {
  usePrimarySettings,
  useSidebarV2Enabled,
  useUpdateClientSettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function AutoSettleDaysInput({
  value,
  onCommit,
  disabled,
}: {
  value: number;
  onCommit: (days: number) => void;
  disabled: boolean;
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
      min={MIN_THREAD_AUTO_SETTLE_AFTER_DAYS}
      max={MAX_THREAD_AUTO_SETTLE_AFTER_DAYS}
      disabled={disabled}
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
          parsed >= MIN_THREAD_AUTO_SETTLE_AFTER_DAYS &&
          parsed <= MAX_THREAD_AUTO_SETTLE_AFTER_DAYS
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
  const sidebarV2Enabled = useSidebarV2Enabled();
  const autoSettleAfterDays = usePrimarySettings(
    (settings) => settings.threadSettlement.autoSettleAfterDays,
  );
  const primaryEnvironment = usePrimaryEnvironment();
  const supportsThreadSettlementPolicy =
    primaryEnvironment?.serverConfig?.environment.capabilities.threadSettlementPolicy === true;
  const updateClientSettings = useUpdateClientSettings();
  const updatePrimarySettings = useUpdatePrimarySettings();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Beta features">
        <SettingsRow
          {...searchableSetting("sidebar-v2")}
          description="One flat thread list in creation order. Active work renders as rich cards; settled threads collapse to compact rows. Settling requires an up-to-date server — on older servers threads simply stay active. Switch back any time."
          control={
            <Switch
              checked={sidebarV2Enabled}
              // Touching the switch pins the choice, so a nightly build that
              // defaults v2 on does not flip it back after the user opts out.
              onCheckedChange={(checked) =>
                updateClientSettings({
                  sidebarV2Enabled: Boolean(checked),
                  sidebarV2ConfiguredByUser: true,
                })
              }
              aria-label="Enable the sidebar v2 beta"
            />
          }
        />
        {sidebarV2Enabled ? (
          <>
            <SettingsRow
              title={searchableSetting("auto-settle-inactive-threads").title}
              description={
                supportsThreadSettlementPolicy
                  ? "Inactive threads from this environment appear settled on every connected client. Threads on merged or closed PRs always settle."
                  : "This server version uses the default inactivity policy and cannot change it remotely."
              }
              control={
                <Switch
                  checked={autoSettleAfterDays !== null}
                  disabled={!supportsThreadSettlementPolicy}
                  onCheckedChange={(checked) =>
                    updatePrimarySettings({
                      threadSettlement: {
                        autoSettleAfterDays: checked ? DEFAULT_THREAD_AUTO_SETTLE_AFTER_DAYS : null,
                      },
                    })
                  }
                  aria-label="Auto-settle inactive threads"
                />
              }
            />
            {autoSettleAfterDays !== null ? (
              <SettingsRow
                title="Days of inactivity before auto-settle"
                description="Any new activity un-settles a thread automatically."
                control={
                  <AutoSettleDaysInput
                    value={autoSettleAfterDays}
                    disabled={!supportsThreadSettlementPolicy}
                    onCommit={(days) =>
                      updatePrimarySettings({
                        threadSettlement: { autoSettleAfterDays: days },
                      })
                    }
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
