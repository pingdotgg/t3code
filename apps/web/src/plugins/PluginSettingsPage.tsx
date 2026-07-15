"use client";

import type { PluginId } from "@t3tools/contracts/plugin";
import type { SettingsSchema } from "@t3tools/contracts/pluginSettings";
import { useCallback, useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { ProviderSettingsForm } from "~/components/settings/ProviderSettingsForm";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { getPluginSettingsCommand, setPluginSettingsCommand } from "~/state/plugins";
import { useAtomCommand } from "~/state/use-atom-command";

export interface PluginSettingsPageProps {
  readonly pluginId: PluginId;
  readonly settingsSchema: SettingsSchema;
}

interface Draft {
  readonly values: Record<string, unknown>;
  readonly revision: number;
  readonly incompatible: boolean;
}

/**
 * Host-rendered settings page for a plugin that declares a settings schema.
 *
 * The plugin ships no form: it declares the schema, the host renders it. That is
 * the point of declarative settings — one consistent UI, one validated write path.
 *
 * Concurrency: the draft carries a `revision` and every save sends it back as
 * `expectedRevision`. A stale save is rejected by the server rather than silently
 * clobbering another tab, and the user is told to reload rather than losing work
 * they can no longer see.
 */
export function PluginSettingsPage({ pluginId, settingsSchema }: PluginSettingsPageProps) {
  const getSettings = useAtomCommand(getPluginSettingsCommand, { reportFailure: false });
  const saveSettings = useAtomCommand(setPluginSettingsCommand, { reportFailure: false });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [edited, setEdited] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const result = await getSettings({ pluginId });
    if (result._tag !== "Success") {
      setError("Could not load settings.");
      return;
    }
    // `declared: false` means the plugin declares no schema (or is disabled), so
    // there is nothing to render — distinct from "declared but empty".
    if (!result.value.declared) {
      setDraft(null);
      setError("This plugin does not expose settings, or is not currently enabled.");
      return;
    }
    setDraft({
      values: { ...result.value.values },
      revision: result.value.revision,
      incompatible: result.value.incompatible,
    });
    setEdited({ ...result.value.values });
  }, [getSettings, pluginId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (draft === null || edited === null) return;
    setSaving(true);
    setError(null);
    const result = await saveSettings({
      pluginId,
      values: edited,
      expectedRevision: draft.revision,
    });
    setSaving(false);
    if (result._tag === "Success") {
      // Re-read rather than keeping the raw client edits. The server canonicalises
      // (decode -> re-encode, and strips keys the schema does not declare), so the
      // stored values can legitimately differ from what was typed; showing the edits
      // would leave the form disagreeing with storage until the next reload.
      await load();
      return;
    }
    // Surface the server's own message: it distinguishes a schema rejection from a
    // concurrent-edit conflict, and the user's next action differs for each ("fix
    // the value" vs "reload, someone else changed this").
    //
    // `result.cause` is an Effect Cause, NOT the error — reading `.message` off it
    // always missed, so every failure fell back to the generic text and the conflict
    // path was unreachable. squashAtomCommandFailure extracts the actual failure.
    const failure = squashAtomCommandFailure(result);
    setError(
      typeof failure === "object" && failure !== null && "message" in failure
        ? String((failure as { readonly message: unknown }).message)
        : "Could not save settings.",
    );
  }, [draft, edited, pluginId, saveSettings]);

  if (draft === null) {
    return error === null ? (
      <Spinner />
    ) : (
      <Alert variant="warning">
        <AlertTitle>Settings unavailable</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid gap-4">
      {draft.incompatible ? (
        // The stored values no longer decode against the plugin's current schema
        // (e.g. an upgrade changed it). The form still opens BECAUSE that is when
        // repair is needed; the stored data is preserved until a valid save.
        <Alert variant="warning">
          <AlertTitle>These settings need attention</AlertTitle>
          <AlertDescription>
            The saved settings no longer match what this plugin expects. Review the fields below and
            save to repair them.
          </AlertDescription>
        </Alert>
      ) : null}
      {error === null ? null : (
        <Alert variant="warning">
          <AlertTitle>Could not save</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <ProviderSettingsForm
        settingsSchema={settingsSchema}
        value={edited ?? draft.values}
        idPrefix={`plugin-settings-${pluginId}`}
        variant="card"
        onChange={(next) => setEdited(next ?? {})}
      />
      <div className="flex justify-end">
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
