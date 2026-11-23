import {
  deviceTimeZone,
  scheduleTimeZoneChoices,
  schedulesDifferFromDevice,
} from "@t3tools/client-runtime/scheduled-task-time-zone";
import { T, useGT, Var } from "gt-react";
import { useState } from "react";

import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { SelectButton } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const zoneName = (zone: string) => zone.replaceAll("_", " ");

/**
 * Picks the zone daily and weekly tasks run in. `scheduleZones` are the zones the scoped
 * environments report, so a traveler sees when their schedules no longer match this device.
 */
export function ScheduleTimeZoneRow({
  scheduleZones,
}: {
  readonly scheduleZones: ReadonlyArray<string | undefined>;
}) {
  const gt = useGT();
  const setting = useSearchableSetting();
  const saved = useScopedSettings((settings) => settings.scheduledTaskTimeZone);
  const mixed = useScopedSettingsMixed(["scheduledTaskTimeZone"]);
  const updateSettings = useUpdateScopedSettings();
  const { contains } = useComboboxFilter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const device = deviceTimeZone();
  const machineLabel = gt("Each machine's time zone");
  const label = (zone: string) => (zone === "" ? machineLabel : zoneName(zone));
  const choices = ["", ...scheduleTimeZoneChoices(saved)];
  const filtered = query.trim()
    ? choices.filter((zone) => contains(label(zone), query) || contains(zone, query))
    : choices;
  const save = (zone: string) => updateSettings({ scheduledTaskTimeZone: zone });

  return (
    <SettingsRow
      serverScoped
      settingKeys={["scheduledTaskTimeZone"]}
      {...setting("schedule-time-zone")}
      description={gt(
        "Daily and weekly tasks run at their set time in this zone. Changing it moves upcoming runs.",
      )}
      status={
        schedulesDifferFromDevice(scheduleZones, device) ? (
          <span className="flex flex-wrap items-center gap-2" role="status">
            <T>
              This device is in <Var>{zoneName(device)}</Var>.
            </T>
            <Button size="xs" variant="outline" onClick={() => save(device)}>
              <T>
                Use <Var>{zoneName(device)}</Var>
              </T>
            </Button>
          </span>
        ) : null
      }
      resetAction={
        saved !== "" || mixed ? (
          <SettingResetButton
            ariaLabel={gt("Reset schedule time zone to default")}
            onClick={() => save("")}
          />
        ) : null
      }
      control={
        <Combobox
          items={choices}
          filteredItems={filtered}
          filter={null}
          autoHighlight
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setQuery("");
          }}
          value={mixed ? null : saved}
          onValueChange={(next) => {
            if (typeof next === "string") save(next);
            setOpen(false);
          }}
        >
          <ComboboxTrigger
            aria-label={gt("Schedule time zone")}
            render={<SelectButton size="sm" />}
          >
            {mixed ? gt("Mixed") : label(saved)}
          </ComboboxTrigger>
          <ComboboxPopup align="end" className="w-72">
            <ComboboxSearchInput
              aria-label={gt("Search time zones")}
              placeholder={gt("Search time zones…")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <ComboboxEmpty>
              <T>No time zones found.</T>
            </ComboboxEmpty>
            <ComboboxList className="max-h-72">
              {filtered.map((zone, index) => (
                <ComboboxItem key={zone} index={index} value={zone}>
                  <span className="block truncate">{label(zone)}</span>
                </ComboboxItem>
              ))}
            </ComboboxList>
          </ComboboxPopup>
        </Combobox>
      }
    />
  );
}
