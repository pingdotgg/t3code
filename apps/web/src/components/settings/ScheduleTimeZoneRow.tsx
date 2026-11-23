import {
  deviceTimeZone,
  scheduleTimeZoneChoices,
  schedulesDifferFromDevice,
} from "@t3tools/client-runtime/scheduled-task-time-zone";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ServerSettings,
} from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

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

const zoneName = (zone: string) => zone.replaceAll("_", " ");

/**
 * Picks the zone daily and weekly tasks run in on every connected environment, whatever the
 * page's scope: a traveler moves all their schedules at once. `scheduleZones` are the zones
 * those environments report, so the row can say when they no longer match this device.
 */
export function ScheduleTimeZoneRow({
  environments,
  scheduleZones,
}: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly serverConfig: { readonly settings: ServerSettings } | null;
  }>;
  readonly scheduleZones: ReadonlyArray<string | undefined>;
}) {
  const gt = useGT();
  const setting = useSearchableSetting();
  const writable = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);
  const editable = environments.flatMap((environment, index) =>
    writable.has(environment.environmentId) ? [{ environment, zone: scheduleZones[index] }] : [],
  );
  const canWrite = editable.length > 0;
  // Only environments a save reaches decide the value and the prompt, so a save can settle both.
  const zones = (canWrite ? editable.map((entry) => entry.environment) : environments).map(
    (environment) => environment.serverConfig?.settings.scheduledTaskTimeZone ?? "",
  );
  const saved = zones[0] ?? "";
  const mixed = zones.some((zone) => zone !== saved);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "schedule time zone update",
  });
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
  const save = (zone: string) => {
    for (const { environment } of editable) {
      void updateSettings({
        environmentId: environment.environmentId,
        input: { patch: { scheduledTaskTimeZone: zone } },
      });
    }
  };

  return (
    <SettingsRow
      settingKeys={["scheduledTaskTimeZone"]}
      mixed={mixed}
      {...setting("schedule-time-zone")}
      description={gt(
        "Daily and weekly tasks run at their set time in this zone. Changing it moves upcoming runs on each connected environment you can change that supports it.",
      )}
      status={
        canWrite &&
        schedulesDifferFromDevice(
          editable.map((entry) => entry.zone),
          device,
        ) ? (
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
        canWrite && (saved !== "" || mixed) ? (
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
          disabled={!canWrite}
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
