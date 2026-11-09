// T3's own `Atom` functions, so a plugin's atoms live in T3's atom registry and work with the hooks
// in `@t3tools/plugin-sdk/atom-react`. Import as `import * as Atom from "@t3tools/plugin-sdk/atom"`
// and build with `@t3tools/plugin-sdk/vite`. The SDK owns these types, a small part of effect's
// `effect/reactivity`, so a plugin needs no `effect` and an effect upgrade in T3 doesn't change them.

declare const AtomType: unique symbol;
declare const WritableType: unique symbol;

/** A value T3's atom registry computes and caches. Read it in a component with `useAtomValue`. */
export interface Atom<A> {
  readonly [AtomType]: () => A;
}

/** An atom that also takes writes of `W`, through `useAtomSet` or `get.set`. */
export interface Writable<R, W = R> extends Atom<R> {
  readonly [WritableType]: (value: W) => void;
}

/** What an atom's read function gets. Call it, as in `get(other)`, to read another atom. */
export interface AtomContext {
  <A>(atom: Atom<A>): A;
  /** Reads another atom and runs this read again when it changes. */
  get<A>(this: AtomContext, atom: Atom<A>): A;
  /** Reads another atom without following its changes. */
  once<A>(this: AtomContext, atom: Atom<A>): A;
  /** Replaces this atom's value, for a value that arrives after the read returned. */
  setSelf<A>(this: AtomContext, value: A): void;
  set<R, W>(this: AtomContext, atom: Writable<R, W>, value: W): void;
  refresh<A>(this: AtomContext, atom: Atom<A>): void;
  refreshSelf(this: AtomContext): void;
  /** Keeps another atom alive while this one is. */
  mount<A>(this: AtomContext, atom: Atom<A>): void;
  subscribe<A>(
    this: AtomContext,
    atom: Atom<A>,
    onValue: (value: A) => void,
    options?: { readonly immediate?: boolean },
  ): void;
  /** Runs before the read runs again and when the atom is disposed. */
  addFinalizer(this: AtomContext, cleanup: () => void): void;
}

export interface WriteContext<A> {
  get<T>(this: WriteContext<A>, atom: Atom<T>): T;
  setSelf(this: WriteContext<A>, value: A): void;
  set<R, W>(this: WriteContext<A>, atom: Writable<R, W>, value: W): void;
  refreshSelf(this: WriteContext<A>): void;
}

/**
 * Makes an atom. From a function, its value is what the function returns, computed again when an
 * atom it reads with `get` changes. From any other value, it is a writable atom holding it.
 */
export declare const make: {
  <A>(read: (get: AtomContext) => A): Atom<A>;
  <A>(initialValue: A): Writable<A>;
};
export declare const readable: <A>(read: (get: AtomContext) => A) => Atom<A>;
export declare const writable: <R, W>(
  read: (get: AtomContext) => R,
  write: (ctx: WriteContext<R>, value: W) => void,
) => Writable<R, W>;
/** Returns a function that makes one atom per argument and returns it again for that argument. */
export declare const family: <Arg, T extends object>(create: (arg: Arg) => T) => (arg: Arg) => T;
/** An atom computed from another one's value. Writes to a writable atom pass through to it. */
export declare const map: {
  <R, W, B>(atom: Writable<R, W>, f: (value: R) => B): Writable<B, W>;
  <A, B>(atom: Atom<A>, f: (value: A) => B): Atom<B>;
};
/** Like `map`, but `read` gets the context too, to read other atoms. */
export declare const transform: {
  <R, W, B>(
    atom: Writable<R, W>,
    read: (get: AtomContext, atom: Writable<R, W>) => B,
  ): Writable<B, W>;
  <A, B>(atom: Atom<A>, read: (get: AtomContext, atom: Atom<A>) => B): Atom<B>;
};
/** A copy of the atom that keeps its value when nothing reads it. */
export declare const keepAlive: <T extends Atom<unknown>>(atom: T) => T;
/** A copy of the atom that keeps its value for `milliseconds` after the last reader leaves. */
export declare const setIdleTTL: <T extends Atom<unknown>>(atom: T, milliseconds: number) => T;
export declare const withLabel: <T extends Atom<unknown>>(atom: T, name: string) => T;
