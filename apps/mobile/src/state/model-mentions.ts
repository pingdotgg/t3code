import { useAtomValue } from "@effect/atom-react";
import { collectComposerModelMentions } from "@t3tools/client-runtime/composerModelMentions";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { buildEnrichedModelReferences } from "../lib/enrichedLinkPresentation";
import type { SelectableMarkdownModel } from "../native/SelectableMarkdownText.types";
import { serverEnvironment } from "./server";

const EMPTY_MODELS: ReadonlyArray<SelectableMarkdownModel> = [];
const emptyModelsAtom = Atom.make(EMPTY_MODELS);
const decodeSources = Schema.decodeUnknownSync(Schema.Array(Schema.String));

const modelMentionsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((key: string) => {
    const sources = new Set(decodeSources(JSON.parse(key)));
    return Atom.make((get) => {
      const models = buildEnrichedModelReferences(
        get(serverEnvironment.providersValueAtom(environmentId)) ?? [],
        sources,
      );
      const previous = Option.getOrUndefined(get.self<ReadonlyArray<SelectableMarkdownModel>>());
      // Provider status pushes do not change a message's chip labels or artwork.
      return previous?.length === models.length &&
        previous.every((model, index) => {
          const next = models[index]!;
          return (
            model.source === next.source &&
            model.label === next.label &&
            model.iconUrl === next.iconUrl
          );
        })
        ? previous
        : models;
    }).pipe(Atom.withLabel("mobile:model-mentions"));
  }),
);

export function useModelMentions(environmentId: EnvironmentId, markdown: string) {
  const sources = [
    ...new Set(collectComposerModelMentions(markdown).map((mention) => mention.source)),
  ].sort();
  return useAtomValue(
    sources.length ? modelMentionsAtom(environmentId)(JSON.stringify(sources)) : emptyModelsAtom,
  );
}
