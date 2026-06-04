import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/unstable/reactivity";
import { createElement } from "react";

export let appAtomRegistry = AtomRegistry.make();

export function AppAtomRegistryProvider({ children }: React.PropsWithChildren) {
  return createElement(RegistryContext.Provider, { value: appAtomRegistry }, children);
}

export function resetAppAtomRegistryForTests() {
  appAtomRegistry.dispose();
  appAtomRegistry = AtomRegistry.make();
}
