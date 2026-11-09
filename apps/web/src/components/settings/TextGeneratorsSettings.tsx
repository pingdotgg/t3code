import {
  type EnvironmentId,
  isSecretReference,
  type ProviderInstanceId,
  type SecretReference,
  type ServerProvider,
  TextGeneratorConfig,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  nextTextGeneratorId,
  refreshTextGeneratorModels,
  TEXT_GENERATOR_PRESETS,
  type TextGeneratorPreset,
  textGeneratorDisplayName,
} from "../../textGenerators";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const decodeTextGenerator = Schema.decodeUnknownOption(TextGeneratorConfig);

const KIND_LABELS = {
  openaiCompatible: "OpenAI-compatible",
  anthropic: "Anthropic",
} satisfies Record<TextGeneratorConfig["kind"], string>;

type Editing = { readonly id: ProviderInstanceId; readonly config: TextGeneratorConfig } | "new";

/** Rows that list, add, edit, and remove one environment's text generators. */
export function TextGeneratorsSettings({
  environmentId,
  environmentLabel,
  providers,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<ProviderInstanceId | null>(null);
  const generators = Object.entries(settings.textGenerators) as Array<
    [ProviderInstanceId, TextGeneratorConfig]
  >;
  const removingConfig = removing === null ? undefined : settings.textGenerators[removing];

  return (
    <>
      <SettingsSection
        {...searchableSetting("text-generators")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setEditing("new")}>
              <PlusIcon className="size-3" aria-hidden />
              Add API
            </Button>
          ) : null
        }
      >
        {generators.length === 0 ? (
          <SettingsRow
            title="No text generators configured."
            description="Model APIs that write titles, commit messages, and other text, but can't run agents."
          />
        ) : null}
        {generators.map(([id, config]) => {
          const name = textGeneratorDisplayName(config);
          return (
            <SettingsRow
              key={id}
              title={name}
              description={
                <span className="break-all">
                  {KIND_LABELS[config.kind]}
                  {config.enabled ? "" : " · Disabled"} · {config.baseUrl}
                </span>
              }
              control={
                readOnly ? null : (
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Refresh ${name} models`}
                      disabled={!config.enabled}
                      onClick={() => refreshTextGeneratorModels(environmentId, id)}
                    >
                      <RefreshCwIcon aria-hidden />
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setEditing({ id, config })}>
                      Edit
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setRemoving(id)}>
                      Remove
                    </Button>
                    <Switch
                      checked={config.enabled}
                      onCheckedChange={(enabled) =>
                        updateSettings({ textGenerators: { [id]: { ...config, enabled } } })
                      }
                      aria-label={`Enable ${name}`}
                    />
                  </div>
                )
              }
            />
          );
        })}
      </SettingsSection>
      {editing !== null ? (
        <TextGeneratorDialog
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          editing={editing}
          onClose={() => setEditing(null)}
          onSave={(id, config) => {
            updateSettings({ textGenerators: { [id]: config } });
            setEditing(null);
          }}
          newId={(preset) => nextTextGeneratorId(preset.id, settings, providers)}
        />
      ) : null}
      <AlertDialog
        open={removingConfig !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removingConfig ? textGeneratorDisplayName(removingConfig) : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Its API key is deleted from {environmentLabel}. Text it was chosen to write falls back
              to the text generation model.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing !== null) updateSettings({ textGenerators: { [removing]: null } });
                setRemoving(null);
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** The key goes once to the server's secret storage; settings keep only a redaction marker. */
function TextGeneratorDialog({
  environmentId,
  environmentLabel,
  editing,
  onClose,
  onSave,
  newId,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly editing: Editing;
  readonly onClose: () => void;
  readonly onSave: (id: ProviderInstanceId, config: TextGeneratorConfig) => void;
  readonly newId: (preset: TextGeneratorPreset) => ProviderInstanceId;
}) {
  const existing = editing === "new" ? null : editing.config;
  const [preset, setPreset] = useState(TEXT_GENERATOR_PRESETS[0]!);
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? preset.baseUrl);
  const [label, setLabel] = useState(existing?.label ?? "");
  const secretSources = useSecretSources(environmentId);
  const [keyDraft, setKeyDraft] = useState<string | SecretReference>(
    isSecretReference(existing?.apiKey) ? existing.apiKey : "",
  );
  const [keyValid, setKeyValid] = useState(true);
  // A saved literal key arrives redacted; sending the marker back keeps it.
  const storedKey = typeof existing?.apiKey === "string" ? existing.apiKey : "";
  const apiKey = typeof keyDraft === "string" ? keyDraft.trim() || storedKey : keyDraft;
  const kind = existing?.kind ?? preset.kind;
  const config = decodeTextGenerator({
    kind,
    ...(label.trim() ? { label: label.trim() } : {}),
    baseUrl: baseUrl.trim(),
    apiKey,
    enabled: existing?.enabled ?? true,
  });
  const keyRequired = existing === null && preset.id !== "custom";
  const canSave = keyValid && Option.isSome(config) && (!keyRequired || apiKey !== "");

  const save = () => {
    if (!canSave) return;
    onSave(editing === "new" ? newId(preset) : editing.id, config.value);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {existing ? `Edit ${textGeneratorDisplayName(existing)}` : "Add a text generator"}
          </DialogTitle>
          <DialogDescription>
            Choose it for thread titles, commit messages, and other generated text on{" "}
            {environmentLabel}. The key stays on that server.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            {existing === null ? (
              <div className="grid gap-1.5">
                <Label htmlFor="text-generator-preset">Service</Label>
                <Select
                  value={preset.id}
                  onValueChange={(value) => {
                    const next = TEXT_GENERATOR_PRESETS.find((candidate) => candidate.id === value);
                    if (!next) return;
                    setPreset(next);
                    setBaseUrl(next.baseUrl);
                  }}
                >
                  <SelectTrigger id="text-generator-preset" size="sm" aria-label="Service">
                    <SelectValue>
                      {(value: string) =>
                        TEXT_GENERATOR_PRESETS.find((candidate) => candidate.id === value)?.label
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {TEXT_GENERATOR_PRESETS.map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id}>
                        {candidate.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="text-generator-url">Base URL</Label>
              <Input
                id="text-generator-url"
                placeholder="http://localhost:11434/v1"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                spellCheck={false}
                autoFocus={existing === null && preset.id === "custom"}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="text-generator-key">
                {keyRequired ? "API key" : "API key (optional)"}
              </Label>
              <SecretSourceInput
                id="text-generator-key"
                aria-label="API key"
                value={keyDraft}
                configured={storedKey !== ""}
                sources={secretSources}
                onChange={(event) => setKeyDraft(event.target.value)}
                onSecretChange={(secret) => setKeyDraft(secret ?? "")}
                onValidityChange={setKeyValid}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="text-generator-label">Label (optional)</Label>
              <Input
                id="text-generator-label"
                placeholder={existing === null ? preset.label : "Defaults to the service name"}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {existing ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
