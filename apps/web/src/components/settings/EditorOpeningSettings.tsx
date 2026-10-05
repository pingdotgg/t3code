import { resolveEnvironmentMachineKind, isWslDistroName } from "@t3tools/contracts";
import { useId, useState, type ReactNode } from "react";

import { isWindowsPlatform } from "~/lib/utils";
import { useLocalWslEditor } from "~/localWslEditor";
import type { EnvironmentPresentation } from "~/state/environments";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { EnvironmentRow, environmentTransportLabel } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { searchableSetting } from "./settingsSearch";

const options = [
  { value: "automatic", label: "Automatic" },
  { value: "wsl", label: "Local WSL" },
];

/**
 * Edits a distro name without changing the saved route until submission.
 * Validation checks its syntax; the user supplies the installed distro name.
 */
function WslDistroForm({
  distro,
  environmentLabel,
  onSave,
  modePicker,
}: {
  readonly distro: string;
  readonly environmentLabel: string;
  readonly onSave: (distro: string) => void;
  readonly modePicker: ReactNode;
}) {
  const [draft, setDraft] = useState(distro);
  const inputId = useId();
  const valid = isWslDistroName(draft.trim());
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSave(draft.trim());
      }}
    >
      <div className="flex items-center gap-2">
        <Input
          className="max-w-sm"
          id={inputId}
          aria-label={`${environmentLabel} local WSL distribution`}
          aria-describedby={`${inputId}-hint`}
          aria-invalid={draft.length > 0 && !valid}
          placeholder="Ubuntu"
          size="sm"
          font="mono"
          value={draft}
          onValueChange={setDraft}
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={!valid || draft.trim() === distro}
        >
          Save
        </Button>
        {modePicker}
      </div>
      <p id={`${inputId}-hint`} className="text-xs text-muted-foreground">
        {draft.length > 0 && !valid
          ? "Use letters, numbers, spaces, dots, hyphens, or underscores. Start and end with a letter, number, or underscore."
          : "Use the installed distribution name. Requires VS Code or VS Code Insiders with the WSL extension."}
      </p>
    </form>
  );
}

/**
 * Configures one environment's route on this device. Selecting WSL starts an
 * unsaved draft; selecting Automatic removes the saved override immediately.
 */
function EditorOpeningRow({
  environment,
  showEnvironment,
}: {
  readonly environment: EnvironmentPresentation;
  readonly showEnvironment: boolean;
}) {
  const [preference, setPreference] = useLocalWslEditor(environment.environmentId);
  const [editingWsl, setEditingWsl] = useState(false);
  const mode = preference !== null || editingWsl ? "wsl" : "automatic";
  const modePicker = (
    <Select
      items={options}
      value={mode}
      onValueChange={(value) => {
        if (value === "automatic") {
          setPreference(null);
          setEditingWsl(false);
        } else if (value === "wsl") {
          setEditingWsl(true);
        }
      }}
    >
      <SelectTrigger
        size="sm"
        className="w-32 shrink-0"
        aria-label={`${environment.label} editor opening`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {options.map(({ value, label }) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
  const distroForm =
    mode === "wsl" ? (
      <WslDistroForm
        key={preference?.distro ?? ""}
        distro={preference?.distro ?? ""}
        environmentLabel={environment.label}
        onSave={(distro) => setPreference({ distro })}
        modePicker={modePicker}
      />
    ) : null;
  if (!showEnvironment) {
    return (
      <div className="px-3 pb-2.5 sm:px-4">
        {distroForm ?? <div className="flex justify-end">{modePicker}</div>}
      </div>
    );
  }
  return (
    <EnvironmentRow
      kind={resolveEnvironmentMachineKind(environment.serverConfig)}
      label={environment.label}
      subtitle={mode === "automatic" ? environmentTransportLabel(environment) : null}
      below={distroForm ? <div className="mt-3">{distroForm}</div> : null}
    >
      {mode === "automatic" ? modePicker : null}
    </EnvironmentRow>
  );
}

/**
 * Windows-only route settings, with named rows when several environments exist
 * and the environment name in the heading when there is only one.
 */
export function EditorOpeningSettings({
  environments,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  if (!isWindowsPlatform(navigator.platform) || environments.length === 0) return null;
  const { id, title } = searchableSetting("editor-opening");
  const singleEnvironment = environments.length === 1 ? environments[0] : undefined;
  return (
    <FoldedSettingsSection
      id={id}
      title={title}
      summary={singleEnvironment ? `This device (${singleEnvironment.label})` : "This device"}
    >
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        If an environment runs in WSL on this Windows device, open its files directly in that
        distribution without SSH. Save a distribution to enable this, or choose Automatic to restore
        the usual editor opening behavior. This preference stays on this device.
      </p>
      {environments.map((environment) => (
        <EditorOpeningRow
          key={environment.environmentId}
          environment={environment}
          showEnvironment={singleEnvironment === undefined}
        />
      ))}
    </FoldedSettingsSection>
  );
}
