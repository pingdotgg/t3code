import { useAtomValue } from "@effect/atom-react";
import { collectComposerModelMentions } from "@t3tools/client-runtime/composer-model-mentions";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { buildEnrichedModelReferences } from "../lib/enrichedLinkPresentation";
import type { SelectableMarkdownModel } from "../native/SelectableMarkdownText.types";
import { serverEnvironment } from "./server";

const EMPTY_MODELS: ReadonlyArray<SelectableMarkdownModel> = [];
const emptyModelsAtom = Atom.make(EMPTY_MODELS);

const modelMentionsAtom = Atom.family((key: string) => {
  const [environmentId, ...sources] = key.split("\n");
  const wanted = new Set(sources);
  return Atom.make((get) => {
    const models = buildEnrichedModelReferences(
      get(serverEnvironment.providersValueAtom(environmentId as EnvironmentId)) ?? [],
      wanted,
    );
    const previous = Option.getOrUndefined(get.self<ReadonlyArray<SelectableMarkdownModel>>());
    // Provider status pushes do not change a message's chip labels or artwork.
    return previous?.length === models.length &&
      previous.every((model, index) => {
        const next = models[index]!;
        return (
          model.source === next.source &&
          model.label === next.label &&
          model.providerLabel === next.providerLabel &&
          model.iconUrl === next.iconUrl
        );
      })
      ? previous
      : models;
  }).pipe(Atom.withLabel("mobile:model-mentions"));
});

export function useModelMentions(environmentId: EnvironmentId | undefined, markdown: string) {
  const sources = [
    ...new Set(collectComposerModelMentions(markdown).map((mention) => mention.source)),
  ].sort();
  return useAtomValue(
    environmentId && sources.length
      ? modelMentionsAtom([environmentId, ...sources].join("\n"))
      : emptyModelsAtom,
  );
}
