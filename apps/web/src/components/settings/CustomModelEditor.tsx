"use client";

import { PlusIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "@t3tools/i18n/react";
import type { ProviderDriverKind, ServerProviderModel } from "@t3tools/contracts";
import type { CustomModelDefinition } from "@t3tools/shared/model";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  DESCRIPTOR_PRESETS_BY_KIND,
  type CustomModelDraft,
  type EditorChoice,
  type EditorDescriptor,
  choiceFromPreset,
  definitionFromDraft,
  descriptorFromPreset,
  descriptorsFromCapabilities,
  draftFromDefinition,
  emptyEditorChoice,
  emptyEditorDescriptor,
  validateDraft,
} from "./customModelEditor.logic";

const CUSTOM_ID_VALUE = "__custom__";
const START_FROM_NONE = "__none__";

interface CustomModelEditorProps {
  readonly instanceId: string;
  readonly driverKind: ProviderDriverKind | null;
  readonly entry: CustomModelDefinition;
  /** Built-in models whose descriptors can be copied as a starting point. */
  readonly builtInModels: ReadonlyArray<ServerProviderModel>;
  readonly onSave: (next: CustomModelDefinition) => void;
  readonly onCancel: () => void;
}

/**
 * Inline editor for one custom model: display name plus the option
 * descriptors the composer should offer for it (Reasoning effort, Fast
 * mode, ...). Draft state is local; nothing is persisted until Save.
 */
export function CustomModelEditor({
  instanceId,
  driverKind,
  entry,
  builtInModels,
  onSave,
  onCancel,
}: CustomModelEditorProps) {
  const { t } = useTranslation("settings");
  const [draft, setDraft] = useState<CustomModelDraft>(() => draftFromDefinition(entry));
  const [error, setError] = useState<string | null>(null);
  const presets = useMemo(
    () => (driverKind ? (DESCRIPTOR_PRESETS_BY_KIND[driverKind] ?? []) : []),
    [driverKind],
  );
  const startFromCandidates = useMemo(
    () => builtInModels.filter((model) => (model.capabilities?.optionDescriptors?.length ?? 0) > 0),
    [builtInModels],
  );
  const domId = (suffix: string) => `provider-instance-${instanceId}-custom-model-${suffix}`;

  const updateDescriptor = (key: string, patch: Partial<EditorDescriptor>) => {
    setError(null);
    setDraft((current) => ({
      ...current,
      descriptors: current.descriptors.map((descriptor) =>
        descriptor.key === key ? { ...descriptor, ...patch } : descriptor,
      ),
    }));
  };

  const updateChoice = (descriptorKey: string, choiceKey: string, patch: Partial<EditorChoice>) => {
    setError(null);
    setDraft((current) => ({
      ...current,
      descriptors: current.descriptors.map((descriptor) => {
        if (descriptor.key !== descriptorKey) return descriptor;
        return {
          ...descriptor,
          choices: descriptor.choices.map((choice) => {
            if (choice.key === choiceKey) return { ...choice, ...patch };
            // Only one choice can be the default.
            return patch.isDefault ? { ...choice, isDefault: false } : choice;
          }),
        };
      }),
    }));
  };

  const removeDescriptor = (key: string) => {
    setError(null);
    setDraft((current) => ({
      ...current,
      descriptors: current.descriptors.filter((descriptor) => descriptor.key !== key),
    }));
  };

  const addDescriptor = (descriptor: EditorDescriptor) => {
    setError(null);
    setDraft((current) => ({ ...current, descriptors: [...current.descriptors, descriptor] }));
  };

  // Selecting a preset id replaces the descriptor's label/type/choices so the
  // usual values are one click away; "Custom…" leaves the row blank to type into.
  const applyPresetId = (descriptor: EditorDescriptor, value: string | null) => {
    if (value === null) return;
    if (value === CUSTOM_ID_VALUE) {
      updateDescriptor(descriptor.key, { id: "" });
      return;
    }
    const preset = presets.find((candidate) => candidate.id === value);
    if (!preset) return;
    updateDescriptor(descriptor.key, {
      id: preset.id,
      label: preset.label,
      type: preset.type,
      choices: (preset.choices ?? []).map(choiceFromPreset),
      currentBooleanValue: undefined,
      description: undefined,
    });
  };

  const handleStartFrom = (slug: string | null) => {
    if (slug === null || slug === START_FROM_NONE) return;
    const model = startFromCandidates.find((candidate) => candidate.slug === slug);
    if (!model) return;
    setError(null);
    setDraft((current) => ({
      ...current,
      descriptors: descriptorsFromCapabilities(model.capabilities, driverKind),
    }));
  };

  const handleSave = () => {
    const problem = validateDraft(draft, (key, values) => {
      switch (key) {
        case "needsId":
          return t("customModel.validation.needsId", { option: values.option });
        case "duplicateId":
          return t("customModel.validation.duplicateId", {
            option: values.option,
            id: values.id ?? "",
          });
        case "needsLabel":
          return t("customModel.validation.needsLabel", { option: values.option });
        case "needsChoice":
          return t("customModel.validation.needsChoice", { option: values.option });
        case "choiceNeedsValue":
          return t("customModel.validation.choiceNeedsValue", { option: values.option });
        case "duplicateChoiceId":
          return t("customModel.validation.duplicateChoiceId", {
            option: values.option,
            id: values.id ?? "",
          });
      }
    });
    if (problem) {
      setError(problem);
      return;
    }
    onSave(definitionFromDraft(draft));
  };

  const idSelectValue = (descriptor: EditorDescriptor) =>
    presets.some((preset) => preset.id === descriptor.id) ? descriptor.id : CUSTOM_ID_VALUE;

  const renderChoice = (descriptor: EditorDescriptor, choice: EditorChoice) => (
    <div key={choice.key} className="flex items-center gap-2">
      <Input
        size="compact"
        value={choice.id}
        onChange={(event) => updateChoice(descriptor.key, choice.key, { id: event.target.value })}
        placeholder={t("customModel.choiceValuePlaceholder")}
        font="mono"
        className="w-28"
        spellCheck={false}
        aria-label={t("customModel.choiceValue")}
      />
      <Input
        size="compact"
        value={choice.label}
        onChange={(event) =>
          updateChoice(descriptor.key, choice.key, { label: event.target.value })
        }
        placeholder={t("customModel.choiceLabel")}
        className="min-w-0 flex-1"
        aria-label={t("customModel.choiceLabel")}
      />
      <label className="flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
        <Switch
          size="sm"
          checked={choice.isDefault}
          onCheckedChange={(checked) =>
            updateChoice(descriptor.key, choice.key, { isDefault: checked })
          }
          aria-label={t("customModel.defaultChoice")}
        />
        {t("customModel.default")}
      </label>
      <Button
        size="icon-micro"
        variant="ghost-muted"
        aria-label={t("customModel.removeChoice")}
        onClick={() =>
          updateDescriptor(descriptor.key, {
            choices: descriptor.choices.filter((candidate) => candidate.key !== choice.key),
          })
        }
      >
        <XIcon className="size-3" />
      </Button>
    </div>
  );

  const renderDescriptor = (descriptor: EditorDescriptor, index: number) => (
    <div
      key={descriptor.key}
      className="flex flex-col gap-2 rounded-md border border-border/60 bg-background/40 p-2.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-14 shrink-0 text-2xs text-muted-foreground">
          {t("customModel.option", { number: index + 1 })}
        </span>
        {presets.length > 0 ? (
          <Select
            value={idSelectValue(descriptor)}
            onValueChange={(value) => applyPresetId(descriptor, value)}
          >
            <SelectTrigger size="compact" className="w-40" aria-label={t("customModel.optionId")}>
              <SelectValue>
                {idSelectValue(descriptor) === CUSTOM_ID_VALUE
                  ? t("customModel.custom")
                  : descriptor.id}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {presets.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  <span className="flex items-baseline gap-2">
                    <code className="font-mono text-xs">{preset.id}</code>
                    <span className="text-muted-foreground">{preset.label}</span>
                  </span>
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM_ID_VALUE}>{t("customModel.custom")}</SelectItem>
            </SelectPopup>
          </Select>
        ) : null}
        {idSelectValue(descriptor) === CUSTOM_ID_VALUE ? (
          <Input
            size="compact"
            value={descriptor.id}
            onChange={(event) => updateDescriptor(descriptor.key, { id: event.target.value })}
            placeholder={t("customModel.optionId")}
            font="mono"
            className="w-36"
            spellCheck={false}
            aria-label={t("customModel.optionId")}
          />
        ) : null}
        <Input
          size="compact"
          value={descriptor.label}
          onChange={(event) => updateDescriptor(descriptor.key, { label: event.target.value })}
          placeholder={t("customModel.optionLabel")}
          className="min-w-0 flex-1"
          aria-label={t("customModel.optionLabel")}
        />
        <Select
          value={descriptor.type}
          onValueChange={(value) =>
            updateDescriptor(descriptor.key, { type: value === "boolean" ? "boolean" : "select" })
          }
        >
          <SelectTrigger size="compact" className="w-24" aria-label={t("customModel.optionType")}>
            <SelectValue>
              {descriptor.type === "boolean" ? t("customModel.toggle") : t("customModel.choices")}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="select">{t("customModel.choices")}</SelectItem>
            <SelectItem value="boolean">{t("customModel.toggle")}</SelectItem>
          </SelectPopup>
        </Select>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-label={t("customModel.removeOption", { number: index + 1 })}
          onClick={() => removeDescriptor(descriptor.key)}
        >
          <XIcon className="size-3" />
        </Button>
      </div>
      {descriptor.type === "select" ? (
        <div className="flex flex-col gap-1.5 pl-16">
          {descriptor.choices.map((choice) => renderChoice(descriptor, choice))}
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            className="-ml-2 self-start"
            onClick={() =>
              updateDescriptor(descriptor.key, {
                choices: [...descriptor.choices, emptyEditorChoice()],
              })
            }
          >
            <PlusIcon className="size-3" />
            {t("customModel.addChoice")}
          </Button>
        </div>
      ) : null}
    </div>
  );

  return (
    <div
      className="mx-2 mt-1 mb-2 flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-3"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={domId("name")} className="text-xs text-muted-foreground">
          {t("customModel.displayName")}
        </label>
        <Input
          id={domId("name")}
          size="sm"
          autoFocus
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          placeholder={draft.slug}
          className="sm:w-72"
          spellCheck={false}
        />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {t("customModel.optionsInComposer")}
          </span>
          {startFromCandidates.length > 0 ? (
            <Select value={START_FROM_NONE} onValueChange={handleStartFrom}>
              <SelectTrigger
                size="compact"
                className="w-44"
                aria-label={t("customModel.copyOptionsFromModel")}
              >
                <SelectValue>{t("customModel.copyFrom")}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {startFromCandidates.map((model) => (
                  <SelectItem key={model.slug} value={model.slug}>
                    {model.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
        </div>
        {draft.descriptors.length === 0 ? (
          <p className="text-xs text-muted-foreground/70">{t("customModel.noCustomOptions")}</p>
        ) : null}
        {draft.descriptors.map(renderDescriptor)}
        <div className="flex flex-wrap gap-1">
          {presets
            .filter(
              (preset) => !draft.descriptors.some((descriptor) => descriptor.id === preset.id),
            )
            .map((preset) => (
              <Button
                key={preset.id}
                type="button"
                size="xs"
                variant="ghost-muted"
                className={cn("-ml-2 first:ml-0")}
                onClick={() => addDescriptor(descriptorFromPreset(preset))}
              >
                <PlusIcon className="size-3" />
                {preset.label}
              </Button>
            ))}
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            onClick={() => addDescriptor(emptyEditorDescriptor())}
          >
            <PlusIcon className="size-3" />
            {t("customModel.customOption")}
          </Button>
        </div>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={handleSave}>
          {t("customModel.save")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("customModel.cancel")}
        </Button>
      </div>
    </div>
  );
}
