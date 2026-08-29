import * as Layer from "effect/Layer";
import { Atom, AtomRegistry, Reactivity } from "effect/unstable/reactivity";

export interface AcceptingHotModule {
  readonly accept: (callback?: () => void) => void;
}

interface HotAtomRuntimeEntry {
  readonly layerAtom: Atom.Writable<
    Layer.Layer<unknown, unknown, AtomRegistry.AtomRegistry | Reactivity.Reactivity>
  >;
  readonly runtime: Atom.AtomRuntime<unknown, unknown>;
}

const hotAtomRuntimesKey = Symbol.for("t3.mobile.hot-atom-runtimes");

type HotAtomRuntimeGlobal = typeof globalThis & {
  [hotAtomRuntimesKey]?: Map<string, HotAtomRuntimeEntry>;
};

function hotAtomRuntimes(): Map<string, HotAtomRuntimeEntry> {
  const runtimeGlobal = globalThis as HotAtomRuntimeGlobal;
  return (runtimeGlobal[hotAtomRuntimesKey] ??= new Map());
}

export function hotSwappableAtomRuntime<R, E>(options: {
  readonly id: string;
  readonly hotModule: AcceptingHotModule | undefined;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly layer: Layer.Layer<R, E, AtomRegistry.AtomRegistry | Reactivity.Reactivity>;
}): Atom.AtomRuntime<R, E> {
  if (options.hotModule === undefined || typeof __DEV__ === "undefined" || !__DEV__) {
    return Atom.runtime(options.layer);
  }

  const runtimes = hotAtomRuntimes();
  const existing = runtimes.get(options.id);
  let entry: HotAtomRuntimeEntry;

  if (existing === undefined) {
    const layerAtom = Atom.make(options.layer);
    entry = {
      layerAtom: layerAtom as HotAtomRuntimeEntry["layerAtom"],
      runtime: Atom.runtime((get) => get(layerAtom)) as HotAtomRuntimeEntry["runtime"],
    };
    runtimes.set(options.id, entry);
  } else {
    entry = existing;
    options.registry.set(
      entry.layerAtom,
      options.layer as Layer.Layer<
        unknown,
        unknown,
        AtomRegistry.AtomRegistry | Reactivity.Reactivity
      >,
    );
  }

  // This is a real HMR boundary: importers retain the stable AtomRuntime while
  // this module evaluation installs the freshly constructed Layer above.
  options.hotModule.accept();
  return entry.runtime as Atom.AtomRuntime<R, E>;
}
