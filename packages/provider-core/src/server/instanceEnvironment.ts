import type {
  ProviderInstanceEnvironment,
  ResolvedProviderInstanceEnvironment,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { expandHomeVariable } from "./pathExpansion.ts";
import type { ProviderAdapterV2 } from "./ProviderAdapter.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const windows = (yield* HostProcess.Platform) === "win32";
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    // An unresolved secret reference carries no value; the registry resolves it for the provider.
    if (typeof variable.value !== "string") continue;
    // Windows reads names without regard to case, and a child gets the first spelling in sort
    // order. Upper case sorts first, so the configured value wins even where a spawn merges the
    // parent environment back in.
    const name = windows ? variable.name.toUpperCase() : variable.name;
    if (windows) {
      for (const inherited of Object.keys(next)) {
        if (inherited.toUpperCase() === name) delete next[inherited];
      }
    }
    next[name] = expandHomeVariable(name, variable.value, home);
  }
  return next;
});

export interface InjectedSecret {
  readonly name: string;
  readonly value: string;
}

const redactionMarker = (name: string) => `[redacted ${name}]`;

// Shorter values ("1", "true", a region) are config, not credentials, and would rewrite ordinary output.
const MIN_SECRET_LENGTH = 8;

interface Needle {
  readonly value: string;
  readonly marker: string;
  /** KMP failure table: longest proper prefix of value[0..i] that is also its suffix. */
  readonly failure: ReadonlyArray<number>;
}

const makeNeedle = (value: string, name: string): Needle => {
  const failure = [0];
  for (let i = 1, k = 0; i < value.length; i++) {
    while (k > 0 && value[i] !== value[k]) k = failure[k - 1]!;
    if (value[i] === value[k]) k++;
    failure.push(k);
  }
  return { value, marker: redactionMarker(name), failure };
};

/** Start of the longest tail of text[from..] that is a proper prefix of needle.value, or -1. */
const partialStart = (needle: Needle, text: string, from: number) => {
  const { value, failure } = needle;
  let k = 0;
  for (let i = Math.max(from, text.length - value.length + 1); i < text.length; i++) {
    while (k > 0 && text[i] !== value[k]) k = failure[k - 1]!;
    if (text[i] === value[k]) k++;
  }
  return k === 0 ? -1 : text.length - k;
};

const earliestPartial = (needles: ReadonlyArray<Needle>, text: string, from: number) => {
  let earliest = text.length;
  for (const needle of needles) {
    const start = partialStart(needle, text, from);
    if (start !== -1 && start < earliest) earliest = start;
  }
  return earliest;
};

/**
 * Leftmost-longest literal replacement in one pass, so markers are never rescanned.
 * With `holdPartial`, stops before the first tail that could still grow into a longer match.
 */
const scan = (needles: ReadonlyArray<Needle>, text: string, holdPartial: boolean) => {
  let partial = holdPartial ? earliestPartial(needles, text, 0) : text.length;
  // Needles are longest first, so ties at one position pick the longest.
  const hits = needles.map((needle) => text.indexOf(needle.value));
  let out = "";
  let position = 0;
  for (;;) {
    let best = -1;
    for (let i = 0; i < needles.length; i++) {
      const hit = hits[i]!;
      if (hit !== -1 && (best === -1 || hit < hits[best]!)) best = i;
    }
    if (best === -1 || hits[best]! >= partial) break;
    const start = hits[best]!;
    out += text.slice(position, start) + needles[best]!.marker;
    position = start + needles[best]!.value.length;
    for (let i = 0; i < needles.length; i++) {
      if (hits[i] !== -1 && hits[i]! < position)
        hits[i] = text.indexOf(needles[i]!.value, position);
    }
    if (partial < position) partial = earliestPartial(needles, text, position);
  }
  const hold = Math.max(position, partial);
  return { emit: out + text.slice(position, hold), pending: text.slice(hold) };
};

const isPlainContainer = (value: unknown): value is object => {
  if (Array.isArray(value)) return true;
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

interface Frame {
  readonly source: object;
  readonly keys: ReadonlyArray<string> | undefined;
  readonly values: Array<unknown>;
  changed: boolean;
}

/** Exact values T3 injects into provider processes, replaced by named markers in tool output and logs. */
export class InjectedSecrets extends Context.Reference<{
  readonly put: (key: unknown, secrets: ReadonlyArray<InjectedSecret>) => void;
  readonly remove: (key: unknown) => void;
  readonly redactText: (text: string) => string;
  /** Rebuilds plain objects and arrays only where a string or key changed. */
  readonly redact: <A>(value: A) => A;
  /** Holds back a raw tail that could begin a secret, so a value split across chunks is still replaced. */
  readonly redactChunk: (
    pending: string,
    chunk: string,
  ) => { readonly emit: string; readonly pending: string };
}>("@t3tools/provider-core/server/InjectedSecrets", {
  // Without the layer nothing is registered, so there is nothing to redact.
  defaultValue: () => ({
    put: () => {},
    remove: () => {},
    redactText: (text) => text,
    redact: (value) => value,
    redactChunk: (pending, chunk) => ({ emit: pending + chunk, pending: "" }),
  }),
}) {
  static readonly layer = Layer.sync(InjectedSecrets, () => makeInjectedSecrets());
}

export function makeInjectedSecrets(): (typeof InjectedSecrets)["Service"] {
  const byKey = new Map<unknown, ReadonlyArray<InjectedSecret>>();
  let needles: ReadonlyArray<Needle> = [];
  const rebuild = () => {
    const names = new Map<string, string>();
    for (const secrets of byKey.values()) {
      for (const secret of secrets) {
        if (secret.value.length >= MIN_SECRET_LENGTH) names.set(secret.value, secret.name);
      }
    }
    needles = [...names]
      .sort(([a], [b]) => b.length - a.length)
      .map(([value, name]) => makeNeedle(value, name));
  };
  const redactText = (text: string) =>
    needles.length === 0 ? text : scan(needles, text, false).emit;
  const leaf = (value: unknown) => (typeof value === "string" ? redactText(value) : value);
  // Iterative, because tool output JSON can nest deeper than the call stack.
  const redactUnknown = (root: unknown): unknown => {
    if (!isPlainContainer(root)) return leaf(root);
    const open = (source: object): Frame => ({
      source,
      keys: Array.isArray(source) ? undefined : Object.keys(source),
      values: [],
      changed: false,
    });
    const close = (frame: Frame): unknown => {
      if (frame.keys === undefined) return frame.changed ? frame.values : frame.source;
      const keys = frame.keys.map(redactText);
      if (!frame.changed && keys.every((key, index) => key === frame.keys![index])) {
        return frame.source;
      }
      // fromEntries defines own data properties, so a "__proto__" key stays a key.
      return Object.fromEntries(keys.map((key, index) => [key, frame.values[index]]));
    };
    const stack = [open(root)];
    for (;;) {
      const frame = stack.at(-1)!;
      const source = frame.source as Record<string, unknown>;
      const length =
        frame.keys === undefined ? (frame.source as Array<unknown>).length : frame.keys.length;
      if (frame.values.length === length) {
        stack.pop();
        const result = close(frame);
        const parent = stack.at(-1);
        if (parent === undefined) return result;
        parent.values.push(result);
        if (result !== frame.source) parent.changed = true;
        continue;
      }
      const index = frame.values.length;
      const entry = source[frame.keys === undefined ? index : frame.keys[index]!];
      if (isPlainContainer(entry)) {
        stack.push(open(entry));
        continue;
      }
      const redacted = leaf(entry);
      frame.values.push(redacted);
      if (redacted !== entry) frame.changed = true;
    }
  };
  return {
    put: (key, secrets) => {
      byKey.set(key, secrets);
      rebuild();
    },
    remove: (key) => {
      if (byKey.delete(key)) rebuild();
    },
    redactText,
    redact: <A>(value: A): A => (needles.length === 0 ? value : (redactUnknown(value) as A)),
    redactChunk: (pending, chunk) =>
      needles.length === 0
        ? { emit: pending + chunk, pending: "" }
        : scan(needles, pending + chunk, true),
  };
}

/** Sessions keep redacting the values they launched with, even after the instance is reconfigured. */
export const withSensitiveEnvironment = Effect.fn("instanceEnvironment.withSensitiveEnvironment")(
  function* (
    adapter: ProviderAdapterV2["Service"],
    environment: ResolvedProviderInstanceEnvironment,
  ) {
    // Like the merge, the last entry for a name wins.
    const effective = [
      ...new Map(environment.map((variable) => [variable.name, variable])).values(),
    ];
    const sensitive = effective.filter((variable) => variable.sensitive);
    if (sensitive.length === 0) return adapter;
    // The value the process receives, with a leading ~ expanded for the config-dir paths.
    const injectedEnv = yield* mergeProviderInstanceEnvironment(sensitive, {});
    const secrets = sensitive.map(({ name }) => ({ name, value: injectedEnv[name] ?? "" }));
    const injected = yield* InjectedSecrets;
    return {
      ...adapter,
      openSession: (input) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const key = {};
            injected.put(key, secrets);
            return key;
          }),
          (key) => Effect.sync(() => injected.remove(key)),
        ).pipe(Effect.andThen(adapter.openSession(input))),
    } satisfies ProviderAdapterV2["Service"];
  },
);
