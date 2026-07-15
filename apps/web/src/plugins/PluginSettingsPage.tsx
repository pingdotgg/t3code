"use client";

import type { PluginId } from "@t3tools/contracts/plugin";
import type { SettingsSchema } from "@t3tools/contracts/pluginSettings";
import type * as Cause from "effect/Cause";
import { useCallback, useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { ProviderSettingsForm } from "~/components/settings/ProviderSettingsForm";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { getPluginSettingsCommand, setPluginSettingsCommand } from "~/state/plugins";
import { useAtomCommand } from "~/state/use-atom-command";

export interface PluginSettingsPageProps {
  readonly pluginId: PluginId;
  readonly settingsSchema: SettingsSchema;
}

export interface Draft {
  readonly values: Record<string, unknown>;
  readonly revision: number;
  readonly incompatible: boolean;
}

/**
 * The server's own message, or a generic fallback.
 *
 * Exported and pure so it can be tested: apps/web has no component-rendering
 * setup, and the message choice is the part with a real decision in it. The
 * server distinguishes a schema rejection from a concurrent-edit conflict, and
 * the user's next action differs for each ("fix the value" vs "reload, someone
 * else changed this"), so falling back to the generic text loses what they need.
 *
 * `result.cause` is an Effect Cause, NOT the error — reading `.message` off it
 * always missed, so every failure produced the generic text and the conflict
 * message was unreachable. squashAtomCommandFailure extracts the real failure.
 */
export function settingsSaveErrorMessage(result: { readonly cause: Cause.Cause<unknown> }): string {
  const failure = squashAtomCommandFailure(result);
  return typeof failure === "object" && failure !== null && "message" in failure
    ? String((failure as { readonly message: unknown }).message)
    : "Could not save settings.";
}

/**
 * Save, then adopt the result — the sequencing that the component only wires up.
 *
 * `applyDraft` and `reload` are injected rather than closed over so the ORDER
 * between them is observable. It is load-bearing: the new revision is adopted
 * BEFORE the re-read, because the write already succeeded and the server has
 * advanced. If the re-read then fails and we had kept the pre-save revision, the
 * next save would send a stale expectedRevision and conflict against the user's
 * own write.
 */
export async function performSettingsSave(input: {
  readonly pluginId: PluginId;
  readonly draft: Draft;
  readonly edited: Record<string, unknown>;
  readonly save: (value: {
    readonly pluginId: PluginId;
    readonly values: Record<string, unknown>;
    readonly expectedRevision: number;
  }) => Promise<AtomCommandResult<{ readonly revision: number }, unknown>>;
  readonly applyDraft: (draft: Draft) => void;
  readonly reload: () => Promise<void>;
}): Promise<{ readonly error: string | null }> {
  const result = await input.save({
    pluginId: input.pluginId,
    values: input.edited,
    expectedRevision: input.draft.revision,
  });
  if (result._tag !== "Success") {
    return { error: settingsSaveErrorMessage(result) };
  }
  input.applyDraft({
    values: { ...input.edited },
    revision: result.value.revision,
    incompatible: false,
  });
  // Re-read rather than keeping the raw client edits. The server canonicalises
  // (decode -> re-encode, and strips keys the schema does not declare at every
  // level), so the stored values can legitimately differ from what was typed;
  // showing the edits would leave the form disagreeing with storage until the
  // next reload.
  await input.reload();
  return { error: null };
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
    const outcome = await performSettingsSave({
      pluginId,
      draft,
      edited,
      save: saveSettings,
      applyDraft: setDraft,
      reload: load,
    });
    setSaving(false);
    setError(outcome.error);
  }, [draft, edited, load, pluginId, saveSettings]);

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
