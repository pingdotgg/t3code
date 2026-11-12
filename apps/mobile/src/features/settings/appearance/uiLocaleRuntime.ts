import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";

import { resolveActiveUiLocale, type ResolvedUiLocale } from "../../../lib/uiLocale";

function makeUiLocaleAtom(input: {
  readonly configsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, ServerConfig>>;
  readonly systemLocale: string | null;
}): Atom.Atom<ResolvedUiLocale> {
  return Atom.make((get) =>
    resolveActiveUiLocale(
      [...get(input.configsAtom).values()].map((config) => config.settings),
      input.systemLocale,
    ),
  ).pipe(Atom.withLabel("mobile:ui-locale"));
}

export function watchUiLocale(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly configsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, ServerConfig>>;
  readonly systemLocale: string | null;
  readonly changeLanguage: (locale: string) => Promise<unknown>;
}): () => void {
  const localeAtom = makeUiLocaleAtom(input);
  return input.registry.subscribe(
    localeAtom,
    (locale) => {
      void input.changeLanguage(locale);
    },
    { immediate: true },
  );
}
