import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { ServerSettings } from "@t3tools/contracts";
import { useContext, useState } from "react";

import { offeredRelease } from "../state/engineUpdate";
import {
  changeUpdatePrefs,
  engineReleaseAtom,
  runUpdates,
  type UpdatePrefs,
  updatePrefsAtom,
  updateRowsAtom,
} from "../state/updatesAtoms";
import { ENGINE_KEY, updateEverythingQueue, type UpdateRow } from "../state/updates";
import { buttonClass } from "./controls/buttonClass";
import { Switch } from "./controls/Switch";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";
import { saveProviderUpdateChecks, type SettingsInput } from "./settingsModel";
import { UpdateItemRow } from "./updates/UpdateItemRow";

function everythingText(queue: ReadonlyArray<UpdateRow>): string {
  if (queue.length === 0) return "Everything the app can update is up to date.";
  return `${queue.length} ${queue.length === 1 ? "update" : "updates"} offered: ${queue
    .map((row) => `${row.name} ${row.offer?.version ?? ""}`)
    .join(", ")}.`;
}

export function UpdatesPage({
  settings,
  save,
}: {
  settings: ServerSettings;
  save: (input: SettingsInput) => void;
}) {
  const registry = useContext(RegistryContext);
  const rows = useAtomValue(updateRowsAtom);
  const prefs = useAtomValue(updatePrefsAtom);
  const release = useAtomValue(engineReleaseAtom);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const run = async (targets: ReadonlyArray<UpdateRow>) => {
    setPending((current) => new Set([...current, ...targets.map((row) => row.key)]));
    await runUpdates(registry, targets);
    setPending(
      (current) => new Set([...current].filter((key) => !targets.some((row) => row.key === key))),
    );
  };

  const engine = rows.find((row) => row.key === ENGINE_KEY);
  const engineRow: UpdateRow | undefined =
    engine === undefined
      ? undefined
      : {
          ...engine,
          latest: engine.latest ?? release,
          status:
            offeredRelease(engine.installed, engine.latest ?? release) !== null
              ? "behind"
              : (engine.latest ?? release) === null
                ? "unknown"
                : "current",
        };
  const providers = rows.filter((row) => row.kind === "provider");
  const queue = updateEverythingQueue(rows);
  const setAutomatic = (key: keyof UpdatePrefs["autoUpdate"], enabled: boolean) =>
    void changeUpdatePrefs(registry, (current) => ({
      ...current,
      autoUpdate: { ...current.autoUpdate, [key]: enabled },
    }));

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title="All updates">
        <SettingsRow
          title="Update everything"
          description={everythingText(queue)}
          control={
            <button
              type="button"
              disabled={queue.length === 0 || queue.some((row) => pending.has(row.key))}
              onClick={() => void run(queue)}
              className={buttonClass}
            >
              Update everything
            </button>
          }
        />
      </SettingsSection>
      <SettingsSection
        title="Engine"
        note="An automatic update starts when no thread has an active run, and never interrupts one."
      >
        {engineRow !== undefined && (
          <UpdateItemRow
            row={engineRow}
            prefs={prefs}
            busy={pending.has(ENGINE_KEY)}
            onUpdate={() => void run([engineRow])}
          />
        )}
        <SettingsRow
          title="Update the engine automatically"
          description="Installs a new T3 release between runs."
          control={
            <Switch
              label="Update the engine automatically"
              checked={prefs?.autoUpdate.engine ?? false}
              disabled={prefs === null}
              onChange={(enabled) => setAutomatic("engine", enabled)}
            />
          }
        />
      </SettingsSection>
      <SettingsSection
        title="Providers"
        note={
          settings.enableProviderUpdateChecks
            ? "An automatic update starts when no thread on that instance has an active run."
            : "Update checks are off, so these versions may be out of date."
        }
      >
        {providers.length === 0 && (
          <p className="px-3 py-2.5 text-faint">The engine lists no Claude Code instance.</p>
        )}
        {providers.map((row) => (
          <UpdateItemRow
            key={row.key}
            row={row}
            prefs={prefs}
            busy={pending.has(row.key)}
            onUpdate={() => void run([row])}
          />
        ))}
        <SettingsRow
          title="Check for provider updates"
          description="T3 looks up the latest Claude Code releases. This setting belongs to the engine."
          control={
            <Switch
              label="Check for provider updates"
              checked={settings.enableProviderUpdateChecks}
              onChange={(enabled) => save(saveProviderUpdateChecks(enabled))}
            />
          }
        />
        <SettingsRow
          title="Update providers automatically"
          description="Installs a new provider release between runs on that instance."
          control={
            <Switch
              label="Update providers automatically"
              checked={prefs?.autoUpdate.providers ?? false}
              disabled={prefs === null}
              onChange={(enabled) => setAutomatic("providers", enabled)}
            />
          }
        />
      </SettingsSection>
    </div>
  );
}
