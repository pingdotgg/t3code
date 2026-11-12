import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { UiLocaleSetting } from "../../../lib/uiLocale";
import { resolveActiveUiLocale, type ResolvedUiLocale } from "../../../lib/uiLocale";

// 06 号任务给 contracts 的 ServerSettings 加上 uiLocale 后，删掉这个本地声明和下面的 cast。
type SettingsWithUiLocale = { readonly uiLocale?: UiLocaleSetting };

function makeUiLocaleAtom(input: {
  readonly configsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, ServerConfig>>;
  readonly systemLocale: string | null;
}): Atom.Atom<ResolvedUiLocale> {
  return Atom.make((get) =>
    resolveActiveUiLocale(
      [...get(input.configsAtom).values()].map((config) => config.settings as SettingsWithUiLocale),
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
