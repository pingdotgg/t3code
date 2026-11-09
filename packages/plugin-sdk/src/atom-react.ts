import type { Context } from "react";

import type { Atom, Writable } from "./atom.ts";

// T3's own atom hooks, which read atoms from `@t3tools/plugin-sdk/atom` in T3's registry. Build
// with `@t3tools/plugin-sdk/vite`, which points this module at the app's copies.

/** T3's atom registry, for reading and writing atoms outside a component. */
export interface Registry {
  get<A>(atom: Atom<A>): A;
  set<R, W>(atom: Writable<R, W>, value: W): void;
  /** Keeps the atom alive until the returned function runs. */
  mount<A>(atom: Atom<A>): () => void;
  refresh<A>(atom: Atom<A>): void;
  subscribe<A>(
    atom: Atom<A>,
    onValue: (value: A) => void,
    options?: { readonly immediate?: boolean },
  ): () => void;
}

/** Holds T3's registry. Read it with `useContext` to reach atoms from an event handler. */
export declare const RegistryContext: Context<Registry>;
/** Returns the atom's value, or the part `select` picks, and renders again when it changes. */
export declare const useAtomValue: {
  <A>(atom: Atom<A>): A;
  <A, B>(atom: Atom<A>, select: (value: A) => B): B;
};
/** Returns a setter for the atom without rendering again when its value changes. */
export declare const useAtomSet: <R, W>(
  atom: Writable<R, W>,
) => (value: W | ((value: R) => W)) => void;
/** Keeps the atom alive while the component is mounted. */
export declare const useAtomMount: <A>(atom: Atom<A>) => void;
/** Returns a function that computes the atom again. */
export declare const useAtomRefresh: <A>(atom: Atom<A>) => () => void;
/** Calls `onValue` with each new value while the component is mounted. */
export declare const useAtomSubscribe: <A>(
  atom: Atom<A>,
  onValue: (value: A) => void,
  options?: { readonly immediate?: boolean },
) => void;
