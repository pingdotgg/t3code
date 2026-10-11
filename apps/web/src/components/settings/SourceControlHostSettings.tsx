import type { EnvironmentId } from "@t3tools/contracts";
import type { SourceControlClientDefinition } from "@t3tools/client-runtime/source-control-clients";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ProviderSettingsForm } from "./ProviderSettingsForm";

/**
 * One host's settings, drawn from its definition's settings schema and saved under
 * `sourceControlHosts[kind]`. Secret fields are write-only: the server keeps them in its secret
 * store and only reports whether each one is set.
 */
export function SourceControlHostSettings({
  environmentId,
  definition,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly definition: SourceControlClientDefinition & {
    readonly settings: NonNullable<SourceControlClientDefinition["settings"]>;
  };
  readonly onSaved: () => void;
}) {
  const saved = useEnvironmentSettings(
    environmentId,
    (settings) => settings.sourceControlHosts[definition.kind],
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `save ${definition.label} settings`,
  });
  const [saving, setSaving] = useState(false);
  const formDefinition = { settingsSchema: definition.settings };
  const hasSaved = Object.values(saved ?? {}).some((value) => value !== "");

  const save = async (fields: Record<string, unknown>) => {
    setSaving(true);
    try {
      const result = await updateSettings({
        environmentId,
        input: { patch: { sourceControlHosts: { [definition.kind]: fields } } },
      });
      if (result._tag === "Success") onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    // Locked while saving, so an edit made mid-request is not overwritten by the saved value.
    <fieldset disabled={saving} className="contents">
      <ProviderSettingsForm
        definition={formDefinition}
        value={saved ?? {}}
        idPrefix={`source-control-${definition.kind}-${environmentId}`}
        variant="settings"
        onChange={(next) => {
          const fields = next ?? {};
          // Only what changed: each saved secret travels as its redaction marker anyway.
          const changed = Object.fromEntries(
            Object.entries(fields).filter(([key, value]) => saved?.[key] !== value),
          );
          const cleared = Object.keys(saved ?? {}).filter((key) => !(key in fields));
          void save({ ...changed, ...Object.fromEntries(cleared.map((key) => [key, ""])) });
        }}
      />
      {hasSaved ? (
        <div className="flex justify-end pt-2">
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void save(Object.fromEntries(Object.keys(saved ?? {}).map((key) => [key, ""])))
            }
          >
            Remove
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}
