import {
  COMPACT_WHEN_IDLE_DEFAULTS,
  COMPACT_WHEN_IDLE_MAX,
  compactIdleChoice,
  type CompactIdleChoice,
  parseCompactWhenIdleCount,
} from "@t3tools/contracts";
import { useRef } from "react";

import { scopedIdleCompaction } from "~/components/settings/scopedSettings";
import { SettingResetButton, SettingsRow } from "~/components/settings/settingsLayout";
import { useSettingsScope } from "~/components/settings/SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "~/components/settings/useScopedSettings";
import { Input } from "~/components/ui/input";

interface ValueRow {
  readonly key:
    | "compactBeforeCacheExpiresTokens"
    | "compactWhenIdleTokens"
    | "compactWhenIdleMinutes";
  readonly title: string;
  readonly description: string;
  readonly fallback: number;
  readonly max: number;
  readonly shownFor: readonly CompactIdleChoice[];
}

const VALUE_ROWS: readonly ValueRow[] = [
  {
    key: "compactBeforeCacheExpiresTokens",
    title: "Cache expiry tokens",
    description: 'Tokens needed before "compact before cache expires" is triggered.',
    fallback: COMPACT_WHEN_IDLE_DEFAULTS.cacheTokens,
    max: COMPACT_WHEN_IDLE_MAX.tokens,
    shownFor: ["beforeCacheExpires", "whenIdle"],
  },
  {
    key: "compactWhenIdleTokens",
    title: "Idle tokens",
    description: 'Tokens needed before "compact when idle" is triggered.',
    fallback: COMPACT_WHEN_IDLE_DEFAULTS.tokens,
    max: COMPACT_WHEN_IDLE_MAX.tokens,
    shownFor: ["whenIdle"],
  },
  {
    key: "compactWhenIdleMinutes",
    title: "Idle minutes",
    description: 'Minutes after the last user message before "compact when idle" is triggered.',
    fallback: COMPACT_WHEN_IDLE_DEFAULTS.minutes,
    max: COMPACT_WHEN_IDLE_MAX.minutes,
    shownFor: ["whenIdle"],
  },
];

/** The values under "Compact idle threads" that the selected choice reads. */
export function CompactIdleValueRows() {
  const settings = useScopedSettings();
  const { targets } = useSettingsScope();
  if (scopedIdleCompaction(targets.length > 0 ? targets : [{ settings }]).mixed) return null;
  const choice = compactIdleChoice(settings);
  return VALUE_ROWS.filter((row) => row.shownFor.includes(choice)).map((row) => (
    <CompactIdleValueRow key={row.key} row={row} />
  ));
}

function CompactIdleValueRow({ row }: { readonly row: ValueRow }) {
  const { targets } = useSettingsScope();
  const value = useScopedSettings((settings) => settings[row.key]);
  const mixed = useScopedSettingsMixed([row.key]);
  const updateSettings = useUpdateScopedSettings();
  const edited = useRef(false);
  const scopeKey = targets.map((target) => target.environmentId).join(",");
  const save = (next: string) => updateSettings({ [row.key]: next });

  return (
    <SettingsRow
      title={row.title}
      description={row.description}
      serverScoped
      settingKeys={[row.key]}
      resetAction={
        mixed || value !== "" ? (
          <SettingResetButton
            ariaLabel={`Reset ${row.title.toLowerCase()} to default`}
            onClick={() => save("")}
          />
        ) : null
      }
      control={
        <Input
          key={`${scopeKey}:${mixed}:${value}`}
          aria-label={row.title}
          inputMode="numeric"
          placeholder={mixed ? "Mixed" : String(row.fallback)}
          defaultValue={mixed ? "" : value}
          onChange={() => {
            edited.current = true;
          }}
          onBlur={(event) => {
            const typed = event.target.value.trim();
            // Clear a rejected value and save "", so the placeholder shows the server's default.
            const accepted = typed === "" || parseCompactWhenIdleCount(typed, row.max) !== null;
            if (!accepted) event.target.value = "";
            const next = accepted ? typed : "";
            if ((edited.current || !accepted) && (mixed || next !== value)) save(next);
            edited.current = false;
          }}
        />
      }
    />
  );
}
