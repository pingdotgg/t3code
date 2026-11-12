import type { ElementType } from "react";
import type { SourceControlProviderInfo } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type {
  ChangeRequestTerminology,
  SourceControlDefinition,
} from "@t3tools/client-runtime/source-control-clients";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { SourceControlIconArtwork } from "./components/SourceControlIconArtwork";

export type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";

type SourceControlIcon = ElementType<{ className?: string }>;

const SOURCE_CONTROL_ICONS = new WeakMap<SourceControlDefinition, SourceControlIcon>();

/** One component per definition, so a host's icon keeps its identity across renders. */
export function sourceControlIcon(definition: SourceControlDefinition): SourceControlIcon {
  const artwork = definition.icon;
  if (artwork === null) return PullRequestGlyph.pullRequest;
  let Icon = SOURCE_CONTROL_ICONS.get(definition);
  if (Icon === undefined) {
    Icon = (props: { className?: string }) => (
      <SourceControlIconArtwork {...props} icon={artwork} />
    );
    SOURCE_CONTROL_ICONS.set(definition, Icon);
  }
  return Icon;
}

export interface SourceControlPresentation {
  readonly definition: SourceControlDefinition;
  readonly providerName: string;
  readonly terminology: ChangeRequestTerminology;
  readonly Icon: SourceControlIcon;
}

function presentDefinition(
  definition: SourceControlDefinition,
  providerName: string,
): SourceControlPresentation {
  return {
    definition,
    providerName,
    terminology: definition.changeRequest,
    Icon: sourceControlIcon(definition),
  };
}

export function getSourceControlPresentation(
  provider: SourceControlProviderInfo | null | undefined,
): SourceControlPresentation {
  const definition = sourceControlClients.get(provider?.kind);
  return presentDefinition(definition, provider?.name || definition.label);
}

export function getSourceControlPresentationForKind(kind: string): SourceControlPresentation {
  const definition = sourceControlClients.get(kind);
  return presentDefinition(definition, definition.label);
}
