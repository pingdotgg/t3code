import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { brandProviderInstanceEntries, deriveProviderInstanceEntries } from "~/providerInstances";
import { serverEnvironment } from "~/state/server";
import { contextChipAccentWithHueOf } from "~/themePalette";
import { ContextChipPopover } from "../contextChipParts";
import { ProviderInstanceIcon, providerLogoColor } from "./ProviderInstanceIcon";
import { getDisplayModelName } from "./providerIconUtils";

interface ModelMentionPresentation {
  readonly label: string;
  readonly providerLabel: string;
  readonly driverKind: ProviderDriverKind;
  readonly providerDisplayName: string;
  readonly acpRegistryAgentId: string | undefined;
  readonly acpRegistryIconUrl: string | undefined;
}

function presentationsEqual(left: ModelMentionPresentation, right: ModelMentionPresentation) {
  return (
    left.label === right.label &&
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
    const [environmentId, instanceId, model] = key.split("\u0000") as [string, string, string];
    if (!environmentId) return null;
    const config = get(serverEnvironment.configValueAtom(environmentId as EnvironmentId));
    const provider = config?.providers.find((candidate) => candidate.instanceId === instanceId);
    const option = provider?.models.find((candidate) => candidate.slug === model);
    if (!config || !provider || !option) return null;
    const [entry] = brandProviderInstanceEntries(
      deriveProviderInstanceEntries([provider]),
      config.settings,
    );
    if (!entry) return null;
    const next: ModelMentionPresentation = {
      label: getDisplayModelName(option),
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

export function ModelMentionChip(props: {
  environmentId: EnvironmentId | null;
  instanceId: string;
  model: string;
  source: string;
}) {
  const presentation = useAtomValue(
    modelMentionPresentationAtom(
      `${props.environmentId ?? ""}\u0000${modelMentionKey(props.instanceId, props.model)}`,
    ),
  );
  if (!presentation) return props.source;
  const accent = logoAccent(presentation.driverKind);
  return (
    <ContextChipPopover
      // A black-and-white logo takes the text color, so its chip does too.
      kind={accent ? "model" : "neutral"}
      accent={accent}
      icon={
        <ProviderInstanceIcon
          driverKind={presentation.driverKind}
          displayName={presentation.providerDisplayName}
          acpRegistryAgentId={presentation.acpRegistryAgentId}
          acpRegistryIconUrl={presentation.acpRegistryIconUrl}
          className="z-auto"
          iconClassName="size-[1em]"
        />
      }
      label={presentation.label}
      accessibleLabel={`Model ${presentation.label}`}
      copyMarkdown={props.source}
    >
      <div className="space-y-1 p-2 text-sm">
        <p className="font-medium">{presentation.label}</p>
        <p className="text-muted-foreground">{presentation.providerLabel}</p>
        <p className="font-mono text-xs text-muted-foreground">{props.source}</p>
      </div>
    </ContextChipPopover>
  );
}
