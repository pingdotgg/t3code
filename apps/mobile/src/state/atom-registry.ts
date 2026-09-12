import { AtomRegistry } from "effect/unstable/reactivity";

import {
  disposeOnFoundationReplace,
  type FoundationHotModule,
} from "../lib/foundation-fast-refresh";

declare const module: { readonly hot?: FoundationHotModule } | undefined;

export const appAtomRegistry = AtomRegistry.make();

disposeOnFoundationReplace(typeof module === "undefined" ? undefined : module.hot, () =>
  appAtomRegistry.dispose(),
);
