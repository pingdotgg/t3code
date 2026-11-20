import { useGT } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import {
  collectComposerModelMentions,
  formatComposerModelMention,
} from "@t3tools/client-runtime/composer-model-mentions";
import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import { modelMentionSettings } from "@t3tools/shared/model";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import type { CSSProperties } from "react";

import { rememberModelMentionOptions } from "~/modelMentionOptionsStore";
import { brandProviderInstanceEntries, deriveProviderInstanceEntries } from "~/providerInstances";
import { serverEnvironment } from "~/state/server";
import { contextChipAccentWithHueOf } from "~/themePalette";
import { ContextChip, ContextChipLabel } from "../ContextChip";
import { ContextChipPopover } from "../contextChipParts";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { ProviderInstanceIcon, providerLogoColor } from "./ProviderInstanceIcon";
import { getDisplayModelName } from "./providerIconUtils";
import { TraitsMenuContent } from "./TraitsPicker";

interface ModelMentionPresentation {
  readonly label: string;
  readonly optionsLabel: string | undefined;
  readonly hasOptions: boolean;
  readonly providerLabel: string;
  readonly driverKind: ProviderDriverKind;
  readonly providerDisplayName: string;
  readonly acpRegistryAgentId: string | undefined;
  readonly acpRegistryIconUrl: string | undefined;
}

function presentationsEqual(left: ModelMentionPresentation, right: ModelMentionPresentation) {
  return (
    left.label === right.label &&
    left.optionsLabel === right.optionsLabel &&
    left.hasOptions === right.hasOptions &&
    left.providerLabel === right.providerLabel &&
    left.driverKind === right.driverKind &&
    left.providerDisplayName === right.providerDisplayName &&
    left.acpRegistryAgentId === right.acpRegistryAgentId &&
    left.acpRegistryIconUrl === right.acpRegistryIconUrl
  );
}

// Keyed per mention so provider status pushes don't rerender every message that names a model.
const modelMentionPresentationAtom = Atom.family((key: string) =>
  Atom.make((get): ModelMentionPresentation | null => {
    const [environmentId, source] = key.split("\u0000") as [string, string];
    const mention = collectComposerModelMentions(source)[0];
    if (!environmentId || !mention) return null;
    const { instanceId, model } = mention;
    const config = get(serverEnvironment.configValueAtom(environmentId as EnvironmentId));
    const provider = config?.providers.find((candidate) => candidate.instanceId === instanceId);
    const option = provider?.models.find((candidate) => candidate.slug === model);
    if (!config || !provider || !option) return null;
    const [entry] = brandProviderInstanceEntries(
      deriveProviderInstanceEntries([provider]),
      config.settings,
    );
    if (!entry) return null;
    const settings = modelMentionSettings(option.capabilities, mention.options);
    const next: ModelMentionPresentation = {
      label: getDisplayModelName(option),
      // A mention without options (typed, or from upstream clients) leaves them to the agent.
      optionsLabel: mention.options.length > 0 ? settings.optionsLabel : undefined,
      hasOptions: settings.options.length > 0,
      providerLabel: option.subProvider ?? entry.displayName,
      driverKind: entry.driverKind,
      providerDisplayName: entry.displayName,
      acpRegistryAgentId: entry.acpRegistryAgentId,
      acpRegistryIconUrl: entry.acpRegistryIconUrl,
    };
    const previous = Option.getOrNull(get.self<ModelMentionPresentation | null>());
    return previous && presentationsEqual(previous, next) ? previous : next;
  }).pipe(Atom.withLabel("model-mention-presentation")),
);

export function modelMentionKey(instanceId: string, model: string): string {
  return `${instanceId}\u0000${model}`;
}

// Keeps its identity until the environment's models change, so status pushes don't reconcile the composer.
export const modelMentionKeysAtom = Atom.family((environmentId: string) =>
  Atom.make((get): ReadonlySet<string> => {
    const config = environmentId
      ? get(serverEnvironment.configValueAtom(environmentId as EnvironmentId))
      : null;
    const next = new Set(
      config?.providers.flatMap((provider) =>
        provider.models.map((option) => modelMentionKey(provider.instanceId, option.slug)),
      ),
    );
    const previous = Option.getOrNull(get.self<ReadonlySet<string>>());
    return previous && previous.size === next.size && [...next].every((key) => previous.has(key))
      ? previous
      : next;
  }).pipe(Atom.withLabel("model-mention-keys")),
);

function logoAccent(driverKind: ProviderDriverKind): string | undefined {
  const color = providerLogoColor(driverKind);
  return (color && contextChipAccentWithHueOf("model", color)) || undefined;
}

function ModelMentionOptionsMenu(props: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  model: string;
  options: ReadonlyArray<ProviderOptionSelection>;
  onSourceChange: (source: string) => void;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const provider = config?.providers.find((candidate) => candidate.instanceId === props.instanceId);
  if (!provider) return null;
  const capabilities = provider.models.find((option) => option.slug === props.model)?.capabilities;
  return (
    <TraitsMenuContent
      provider={provider.driver}
      instanceId={props.instanceId}
      models={provider.models}
      model={props.model}
      modelOptions={props.options}
      allowPromptInjectedEffort={false}
      onModelOptionsChange={(next) => {
        const { options } = modelMentionSettings(capabilities, next ?? []);
        rememberModelMentionOptions(props.instanceId, props.model, options);
        props.onSourceChange(formatComposerModelMention(props.instanceId, props.model, options));
      }}
    />
  );
}

export function ModelMentionChip(props: {
  environmentId: EnvironmentId | null;
  instanceId: string;
  model: string;
  source: string;
  /** Makes the chip edit the model's options, writing them back into the mention. */
  onSourceChange?: ((source: string) => void) | undefined;
}) {
  const gt = useGT();
  const presentation = useAtomValue(
    modelMentionPresentationAtom(`${props.environmentId ?? ""}\u0000${props.source}`),
  );
  if (!presentation) return props.source;
  const accent = logoAccent(presentation.driverKind);
  const label = presentation.optionsLabel
    ? `${presentation.label} · ${presentation.optionsLabel}`
    : presentation.label;
  const icon = (
    <ProviderInstanceIcon
      driverKind={presentation.driverKind}
      displayName={presentation.providerDisplayName}
      acpRegistryAgentId={presentation.acpRegistryAgentId}
      acpRegistryIconUrl={presentation.acpRegistryIconUrl}
      className="z-auto"
      iconClassName="size-[1em]"
    />
  );
  if (props.environmentId && props.onSourceChange && presentation.hasOptions) {
    const options = collectComposerModelMentions(props.source)[0]?.options ?? [];
    return (
      <Menu>
        <MenuTrigger
          render={
            <ContextChip
              kind="neutral"
              style={accent ? ({ "--context-chip-accent": accent } as CSSProperties) : undefined}
              render={<button type="button" />}
              aria-label={gt("Model {label}. Change options", { label })}
              data-markdown-copy={props.source}
            />
          }
        >
          {icon}
          <ContextChipLabel>{label}</ContextChipLabel>
        </MenuTrigger>
        <MenuPopup align="start">
          <ModelMentionOptionsMenu
            environmentId={props.environmentId}
            instanceId={props.instanceId as ProviderInstanceId}
            model={props.model}
            options={options}
            onSourceChange={props.onSourceChange}
          />
        </MenuPopup>
      </Menu>
    );
  }
  return (
    <ContextChipPopover
      kind="neutral"
      accent={accent}
      icon={icon}
      label={label}
      accessibleLabel={gt("Model {label}", { label })}
      copyMarkdown={props.source}
    >
      <div className="space-y-1 p-2 text-sm">
        <p className="font-medium">{presentation.label}</p>
        {presentation.optionsLabel ? (
          <p className="text-muted-foreground">{presentation.optionsLabel}</p>
        ) : null}
        <p className="text-muted-foreground">{presentation.providerLabel}</p>
        <p className="font-mono text-xs text-muted-foreground">{props.source}</p>
      </div>
    </ContextChipPopover>
  );
}
