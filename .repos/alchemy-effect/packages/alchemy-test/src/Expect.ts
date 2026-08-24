/**
 * A from-scratch, dependency-free `expect` covering the matcher surface used
 * by the alchemy test suite. Vitest-compatible semantics for:
 *
 * - equality: toBe, toEqual, toStrictEqual
 * - presence: toBeDefined, toBeUndefined, toBeNull, toBeTruthy, toBeFalsy, toBeNaN
 * - containers: toContain, toContainEqual, toHaveLength, toHaveProperty
 * - strings: toMatch
 * - objects: toMatchObject, toBeInstanceOf, toBeTypeOf
 * - numbers: toBeGreaterThan(OrEqual), toBeLessThan(OrEqual), toBeCloseTo
 * - misc: toSatisfy, toBeOneOf, toThrow / toThrowError
 * - modifiers: .not, .resolves, .rejects
 * - asymmetric: expect.any, expect.anything, expect.arrayContaining,
 *   expect.objectContaining, expect.stringContaining, expect.stringMatching
 * - expect.fail
 *
 * Assertion failures throw {@link AssertionError} (a plain Error subclass) so
 * they propagate through Effect as defects and render with a clean message.
 */

// ---------------------------------------------------------------------------
// AssertionError
// ---------------------------------------------------------------------------

export class AssertionError extends Error {
  override readonly name = "AssertionError";
  constructor(
    message: string,
    readonly actual?: unknown,
    readonly expected?: unknown,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// stringify — small, cycle-safe inspector for failure messages
// ---------------------------------------------------------------------------

const MAX_DEPTH = 4;
const MAX_ITEMS = 25;
const MAX_STRING = 2000;

export const stringify = (value: unknown): string => {
  try {
    const out = inspect(value, 0, new Set());
    return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out;
  } catch {
    // Coercion-hostile values (e.g. alchemy Output proxies throw on string
    // coercion) must never break assertion-message rendering.
    return "[unprintable]";
  }
};

const inspect = (value: unknown, depth: number, seen: Set<unknown>): string => {
  try {
    return inspectUnsafe(value, depth, seen);
  } catch {
    return "[unprintable]";
  }
};

const inspectUnsafe = (
  value: unknown,
  depth: number,
  seen: Set<unknown>,
): string => {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
    case "boolean":
      return String(value);
    case "bigint":
      return `${value}n`;
    case "symbol":
      return value.toString();
    case "function":
      return `[Function ${value.name || "anonymous"}]`;
  }
  if (isAsymmetric(value)) return value.toString();
  if (value instanceof Date) return `Date(${value.toISOString()})`;
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Error)
    return `${value.name}(${JSON.stringify(value.message)})`;
  if (seen.has(value)) return "[Circular]";
  if (depth > MAX_DEPTH) return Array.isArray(value) ? "[…]" : "{…}";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_ITEMS)
        .map((v) => inspect(v, depth + 1, seen));
      if (value.length > MAX_ITEMS)
        items.push(`… ${value.length - MAX_ITEMS} more`);
      return `[ ${items.join(", ")} ]`;
    }
    if (value instanceof Map) {
      const items = [...value.entries()]
        .slice(0, MAX_ITEMS)
        .map(
          ([k, v]) =>
            `${inspect(k, depth + 1, seen)} => ${inspect(v, depth + 1, seen)}`,
        );
      return `Map { ${items.join(", ")} }`;
    }
    if (value instanceof Set) {
      const items = [...value.values()]
        .slice(0, MAX_ITEMS)
        .map((v) => inspect(v, depth + 1, seen));
      return `Set { ${items.join(", ")} }`;
    }
    const proto = Object.getPrototypeOf(value);
    const ctor =
      proto !== null &&
      proto !== Object.prototype &&
      proto.constructor?.name !== "Object"
        ? `${proto.constructor?.name ?? ""} `
        : "";
    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      MAX_ITEMS,
    );
    const body = entries
      .map(([k, v]) => `${k}: ${inspect(v, depth + 1, seen)}`)
      .join(", ");
    return `${ctor}{ ${body} }`;
  } finally {
    seen.delete(value);
  }
};

// ---------------------------------------------------------------------------
// Asymmetric matchers
// ---------------------------------------------------------------------------

interface AsymmetricMatcher {
  matches(actual: unknown): boolean;
  toString(): string;
}

/**
 * Identity-based registry. A `Symbol in value` check would be unreliable:
 * alchemy's `Output`/`PropExpr` proxies answer `true` for arbitrary `has`
 * probes, which would misclassify them as matchers.
 */
const asymmetricRegistry = new WeakSet<object>();

const isAsymmetric = (value: unknown): value is AsymmetricMatcher =>
  typeof value === "object" && value !== null && asymmetricRegistry.has(value);

const asymmetric = (
  label: string,
  matches: (actual: unknown) => boolean,
): AsymmetricMatcher => {
  const matcher: AsymmetricMatcher = {
    matches,
    toString: () => label,
  };
  asymmetricRegistry.add(matcher);
  return matcher;
};

const anyMatcher = (ctor: any): AsymmetricMatcher =>
  asymmetric(`Any<${ctor?.name ?? "?"}>`, (actual) => {
    if (ctor === String)
      return typeof actual === "string" || actual instanceof String;
    if (ctor === Number)
      return typeof actual === "number" || actual instanceof Number;
    if (ctor === Boolean)
      return typeof actual === "boolean" || actual instanceof Boolean;
    if (ctor === BigInt) return typeof actual === "bigint";
    if (ctor === Symbol) return typeof actual === "symbol";
    if (ctor === Function) return typeof actual === "function";
    if (ctor === Object) return typeof actual === "object" && actual !== null;
    if (ctor === Array) return Array.isArray(actual);
    return actual instanceof ctor;
  });

// ---------------------------------------------------------------------------
// Deep equality (jest `toEqual` semantics: undefined-valued keys are ignored,
// asymmetric matchers are honored on the expected side)
// ---------------------------------------------------------------------------

export const equals = (
  actual: unknown,
  expected: unknown,
  strict = false,
): boolean => eq(actual, expected, strict, new Map());

const definedKeys = (obj: Record<PropertyKey, unknown>): Array<PropertyKey> =>
  (Reflect.ownKeys(obj) as Array<PropertyKey>).filter(
    (k) => obj[k as any] !== undefined,
  );

const eq = (
  a: unknown,
  b: unknown,
  strict: boolean,
  seen: Map<unknown, unknown>,
): boolean => {
  if (isAsymmetric(b)) return b.matches(a);
  if (isAsymmetric(a)) return a.matches(b);
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a === null || b === null) return false;
  const objA = a as Record<PropertyKey, unknown>;
  const objB = b as Record<PropertyKey, unknown>;

  if (seen.get(a) === b) return true;
  seen.set(a, b);
  try {
    if (a instanceof Date || b instanceof Date) {
      return (
        a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
      );
    }
    if (a instanceof Error || b instanceof Error) {
      // Vitest semantics: errors match on class, message and own enumerable
      // fields (e.g. Data.TaggedError payloads) — never on `stack`.
      if (!(a instanceof Error) || !(b instanceof Error)) return false;
      if (a.name !== b.name || a.message !== b.message) return false;
      const fieldsOf = (error: Error): Record<string, unknown> => {
        const fields: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(error)) {
          if (key === "stack" || key === "message" || key === "name") continue;
          if (value !== undefined) fields[key] = value;
        }
        return fields;
      };
      return eq(fieldsOf(a), fieldsOf(b), false, seen);
    }
    if (a instanceof RegExp || b instanceof RegExp) {
      return (
        a instanceof RegExp &&
        b instanceof RegExp &&
        a.source === b.source &&
        a.flags === b.flags
      );
    }
    if (a instanceof URL || b instanceof URL) {
      return a instanceof URL && b instanceof URL && a.href === b.href;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
        return false;
      }
      for (let i = 0; i < a.length; i++) {
        if (!eq(a[i], b[i], strict, seen)) return false;
      }
      return true;
    }
    if (a instanceof Map || b instanceof Map) {
      if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) {
        return false;
      }
      for (const [k, v] of a) {
        if (!b.has(k) || !eq(v, b.get(k), strict, seen)) return false;
      }
      return true;
    }
    if (a instanceof Set || b instanceof Set) {
      if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) {
        return false;
      }
      outer: for (const v of a) {
        if (b.has(v)) continue;
        for (const w of b) {
          if (eq(v, w, strict, seen)) continue outer;
        }
        return false;
      }
      return true;
    }
    if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
      if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return false;
      const ta = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      const tb = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      if (ta.length !== tb.length) return false;
      for (let i = 0; i < ta.length; i++) if (ta[i] !== tb[i]) return false;
      return true;
    }
    if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) {
      return false;
    }
    const keysA = strict ? Reflect.ownKeys(objA) : definedKeys(objA);
    const keysB = strict ? Reflect.ownKeys(objB) : definedKeys(objB);
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
      if (!(k in objB) && objB[k as any] === undefined && !strict) return false;
      if (!eq(objA[k as any], objB[k as any], strict, seen)) return false;
    }
    return true;
  } finally {
    seen.delete(a);
  }
};

/**
 * Object-like values for structural matching. Includes functions because
 * alchemy's `Output` proxies wrap a function target (so they're callable)
 * while still exposing data properties.
 */
const isObjectLike = (value: unknown): value is Record<PropertyKey, unknown> =>
  value !== null && (typeof value === "object" || typeof value === "function");

/** Subset match for toMatchObject: every key in `expected` must match. */
const matchesObject = (
  actual: unknown,
  expected: unknown,
  seen: Map<unknown, unknown>,
): boolean => {
  if (isAsymmetric(expected)) return expected.matches(actual);
  if (typeof expected !== "object" || expected === null) {
    return eq(actual, expected, false, seen);
  }
  if (!isObjectLike(actual)) return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length)
      return false;
    return expected.every((e, i) => matchesObject(actual[i], e, seen));
  }
  if (
    expected instanceof Date ||
    expected instanceof RegExp ||
    expected instanceof Map ||
    expected instanceof Set
  ) {
    return eq(actual, expected, false, seen);
  }
  if (seen.get(actual) === expected) return true;
  seen.set(actual, expected);
  try {
    for (const k of Reflect.ownKeys(expected as Record<PropertyKey, unknown>)) {
      const e = (expected as any)[k];
      if (e === undefined && !(k in (actual as any))) continue;
      if (!matchesObject((actual as any)[k], e, seen)) return false;
    }
    return true;
  } finally {
    seen.delete(actual);
  }
};

// ---------------------------------------------------------------------------
// Matchers
// ---------------------------------------------------------------------------

export interface Matchers<A = unknown> {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toStrictEqual(expected: unknown): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toBeNull(): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeNaN(): void;
  toContain(item: unknown): void;
  toContainEqual(item: unknown): void;
  toHaveLength(length: number): void;
  toHaveProperty(path: string | Array<PropertyKey>, value?: unknown): void;
  toMatch(pattern: string | RegExp): void;
  toMatchObject(expected: object): void;
  toThrow(
    expected?: string | RegExp | Error | (new (...args: Array<any>) => Error),
  ): void;
  toThrowError(
    expected?: string | RegExp | Error | (new (...args: Array<any>) => Error),
  ): void;
  toBeGreaterThan(expected: number | bigint): void;
  toBeGreaterThanOrEqual(expected: number | bigint): void;
  toBeLessThan(expected: number | bigint): void;
  toBeLessThanOrEqual(expected: number | bigint): void;
  toBeCloseTo(expected: number, precision?: number): void;
  toBeInstanceOf(ctor: abstract new (...args: Array<any>) => unknown): void;
  toBeTypeOf(
    type:
      | "string"
      | "number"
      | "boolean"
      | "bigint"
      | "symbol"
      | "function"
      | "object"
      | "undefined",
  ): void;
  toSatisfy(predicate: (value: A) => boolean): void;
  toBeOneOf(values: ReadonlyArray<unknown>): void;
  readonly not: Matchers<A>;
  readonly resolves: PromiseMatchers<A>;
  readonly rejects: PromiseMatchers<A>;
}

export type PromiseMatchers<A> = {
  readonly [K in Exclude<keyof Matchers<A>, "not" | "resolves" | "rejects">]: (
    ...args: Parameters<Matchers<A>[K]>
  ) => Promise<void>;
} & { readonly not: PromiseMatchers<A> };

const fail = (message: string, actual?: unknown, expected?: unknown): never => {
  throw new AssertionError(message, actual, expected);
};

const check = (
  pass: boolean,
  negated: boolean,
  message: () => string,
  actual?: unknown,
  expected?: unknown,
): void => {
  if (pass === negated) {
    fail(negated ? `NOT: ${message()}` : message(), actual, expected);
  }
};

const resolveThrown = (actual: unknown): { threw: boolean; error: unknown } => {
  if (typeof actual !== "function") {
    // expect(error).toThrow — vitest allows passing an already-caught error
    return { threw: true, error: actual };
  }
  try {
    (actual as () => unknown)();
    return { threw: false, error: undefined };
  } catch (error) {
    return { threw: true, error };
  }
};

const throwMatches = (
  error: unknown,
  expected?: string | RegExp | Error | (new (...args: Array<any>) => Error),
): boolean => {
  if (expected === undefined) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof expected === "string") return message.includes(expected);
  if (expected instanceof RegExp) return expected.test(message);
  if (expected instanceof Error) return message === expected.message;
  return error instanceof expected;
};

const getPath = (
  target: unknown,
  path: string | Array<PropertyKey>,
): { found: boolean; value: unknown } => {
  const parts = Array.isArray(path)
    ? path
    : path.split(".").flatMap((segment) =>
        segment
          .split(/[[\]]/)
          .filter((s) => s !== "")
          .map((s) => (/^\d+$/.test(s) ? Number(s) : s)),
      );
  let current: any = target;
  for (const part of parts) {
    if (
      current === null ||
      current === undefined ||
      !(part in Object(current))
    ) {
      return { found: false, value: undefined };
    }
    current = current[part as any];
  }
  return { found: true, value: current };
};

const makeMatchers = <A>(actual: A, negated: boolean): Matchers<A> => {
  const str = (v: unknown) => stringify(v);
  const self: Matchers<A> = {
    toBe: (expected) =>
      check(
        Object.is(actual, expected),
        negated,
        () => `expected ${str(actual)} to be ${str(expected)}`,
        actual,
        expected,
      ),
    toEqual: (expected) =>
      check(
        equals(actual, expected),
        negated,
        () => `expected ${str(actual)} to equal ${str(expected)}`,
        actual,
        expected,
      ),
    toStrictEqual: (expected) =>
      check(
        equals(actual, expected, true),
        negated,
        () => `expected ${str(actual)} to strictly equal ${str(expected)}`,
        actual,
        expected,
      ),
    toBeDefined: () =>
      check(
        actual !== undefined,
        negated,
        () => `expected value to be defined`,
      ),
    toBeUndefined: () =>
      check(
        actual === undefined,
        negated,
        () => `expected ${str(actual)} to be undefined`,
      ),
    toBeNull: () =>
      check(
        actual === null,
        negated,
        () => `expected ${str(actual)} to be null`,
      ),
    toBeTruthy: () =>
      check(!!actual, negated, () => `expected ${str(actual)} to be truthy`),
    toBeFalsy: () =>
      check(!actual, negated, () => `expected ${str(actual)} to be falsy`),
    toBeNaN: () =>
      check(
        typeof actual === "number" && Number.isNaN(actual),
        negated,
        () => `expected ${str(actual)} to be NaN`,
      ),
    toContain: (item) => {
      let pass = false;
      if (typeof actual === "string") {
        pass = typeof item === "string" && actual.includes(item);
      } else if (Array.isArray(actual)) {
        pass = actual.includes(item);
      } else if (actual instanceof Set) {
        pass = actual.has(item);
      } else if (
        actual !== null &&
        typeof actual === "object" &&
        Symbol.iterator in (actual as object)
      ) {
        pass = [...(actual as unknown as Iterable<unknown>)].includes(item);
      }
      check(
        pass,
        negated,
        () => `expected ${str(actual)} to contain ${str(item)}`,
        actual,
        item,
      );
    },
    toContainEqual: (item) => {
      const values = Array.isArray(actual)
        ? actual
        : actual instanceof Set
          ? [...actual]
          : actual !== null &&
              typeof actual === "object" &&
              Symbol.iterator in (actual as object)
            ? [...(actual as unknown as Iterable<unknown>)]
            : undefined;
      check(
        values !== undefined && values.some((v) => equals(v, item)),
        negated,
        () =>
          `expected ${str(actual)} to contain an element equal to ${str(item)}`,
        actual,
        item,
      );
    },
    toHaveLength: (length) => {
      const actualLength =
        typeof actual === "string" || Array.isArray(actual)
          ? actual.length
          : ((actual as any)?.length ?? (actual as any)?.size);
      check(
        actualLength === length,
        negated,
        () =>
          `expected length ${str(actualLength)} to be ${length} (value: ${str(actual)})`,
        actualLength,
        length,
      );
    },
    toHaveProperty: (path, ...rest) => {
      const { found, value } = getPath(actual, path);
      const pass = found && (rest.length === 0 || equals(value, rest[0]));
      check(
        pass,
        negated,
        () =>
          rest.length === 0
            ? `expected ${str(actual)} to have property ${JSON.stringify(String(path))}`
            : `expected property ${JSON.stringify(String(path))} of ${str(actual)} to equal ${str(rest[0])}, got ${str(value)}`,
        value,
        rest[0],
      );
    },
    toMatch: (pattern) => {
      const text = typeof actual === "string" ? actual : undefined;
      const pass =
        text !== undefined &&
        (typeof pattern === "string"
          ? text.includes(pattern)
          : pattern.test(text));
      check(
        pass,
        negated,
        () => `expected ${str(actual)} to match ${str(pattern)}`,
        actual,
        pattern,
      );
    },
    toMatchObject: (expected) =>
      check(
        matchesObject(actual, expected, new Map()),
        negated,
        () => `expected ${str(actual)} to match object ${str(expected)}`,
        actual,
        expected,
      ),
    toThrow: (expected) => {
      const { threw, error } = resolveThrown(actual);
      check(
        threw && throwMatches(error, expected),
        negated,
        () =>
          threw
            ? `expected thrown error ${str(error)} to match ${str(expected)}`
            : `expected function to throw`,
        error,
        expected,
      );
    },
    toThrowError: (expected) => self.toThrow(expected),
    toBeGreaterThan: (expected) =>
      check(
        (actual as any) > expected,
        negated,
        () => `expected ${str(actual)} to be greater than ${str(expected)}`,
        actual,
        expected,
      ),
    toBeGreaterThanOrEqual: (expected) =>
      check(
        (actual as any) >= expected,
        negated,
        () => `expected ${str(actual)} to be >= ${str(expected)}`,
        actual,
        expected,
      ),
    toBeLessThan: (expected) =>
      check(
        (actual as any) < expected,
        negated,
        () => `expected ${str(actual)} to be less than ${str(expected)}`,
        actual,
        expected,
      ),
    toBeLessThanOrEqual: (expected) =>
      check(
        (actual as any) <= expected,
        negated,
        () => `expected ${str(actual)} to be <= ${str(expected)}`,
        actual,
        expected,
      ),
    toBeCloseTo: (expected, precision = 2) =>
      check(
        typeof actual === "number" &&
          Math.abs(actual - expected) < 10 ** -precision / 2,
        negated,
        () =>
          `expected ${str(actual)} to be close to ${expected} (precision ${precision})`,
        actual,
        expected,
      ),
    toBeInstanceOf: (ctor) =>
      check(
        actual instanceof ctor,
        negated,
        () => `expected ${str(actual)} to be an instance of ${ctor.name}`,
        actual,
        ctor,
      ),
    toBeTypeOf: (type) =>
      check(
        typeof actual === type,
        negated,
        () =>
          `expected ${str(actual)} (${typeof actual}) to be of type ${type}`,
        typeof actual,
        type,
      ),
    toSatisfy: (predicate) =>
      check(
        predicate(actual),
        negated,
        () =>
          `expected ${str(actual)} to satisfy ${predicate.name || "predicate"}`,
        actual,
      ),
    toBeOneOf: (values) =>
      check(
        values.some((v) => equals(actual, v)),
        negated,
        () => `expected ${str(actual)} to be one of ${str(values)}`,
        actual,
        values,
      ),
    get not() {
      return makeMatchers(actual, !negated);
    },
    get resolves() {
      return makePromiseMatchers(actual, negated, "resolves");
    },
    get rejects() {
      return makePromiseMatchers(actual, negated, "rejects");
    },
  };
  return self;
};

const makePromiseMatchers = <A>(
  actual: A,
  negated: boolean,
  kind: "resolves" | "rejects",
): PromiseMatchers<A> => {
  const settle = async (): Promise<unknown> => {
    const promise = typeof actual === "function" ? (actual as any)() : actual;
    if (kind === "resolves") return await promise;
    try {
      const value = await promise;
      fail(
        `expected promise to reject, but it resolved with ${stringify(value)}`,
      );
    } catch (error) {
      if (error instanceof AssertionError) throw error;
      return error;
    }
  };
  return new Proxy({} as PromiseMatchers<A>, {
    get(_target, prop) {
      if (prop === "not") return makePromiseMatchers(actual, !negated, kind);
      if (prop === "then") return undefined;
      return (...args: Array<unknown>) =>
        settle().then((value) => {
          const matchers = makeMatchers(value, negated) as any;
          return matchers[prop](...args);
        });
    },
  });
};

// ---------------------------------------------------------------------------
// expect
// ---------------------------------------------------------------------------

export interface Expect {
  <A>(actual: A, message?: string): Matchers<A>;
  any(ctor: any): any;
  anything(): any;
  arrayContaining(items: ReadonlyArray<unknown>): any;
  objectContaining(subset: Record<string, unknown>): any;
  stringContaining(substring: string): any;
  stringMatching(pattern: string | RegExp): any;
  toSatisfy(predicate: (value: any) => boolean, description?: string): any;
  fail(message?: string): never;
}

export const expect: Expect = Object.assign(
  <A>(actual: A, _message?: string): Matchers<A> => makeMatchers(actual, false),
  {
    any: anyMatcher,
    anything: () =>
      asymmetric(
        "Anything",
        (actual) => actual !== null && actual !== undefined,
      ),
    arrayContaining: (items: ReadonlyArray<unknown>) =>
      asymmetric(
        `ArrayContaining ${stringify(items)}`,
        (actual) =>
          Array.isArray(actual) &&
          items.every((item) => actual.some((v) => equals(v, item))),
      ),
    objectContaining: (subset: Record<string, unknown>) =>
      asymmetric(`ObjectContaining ${stringify(subset)}`, (actual) =>
        matchesObject(actual, subset, new Map()),
      ),
    stringContaining: (substring: string) =>
      asymmetric(
        `StringContaining ${JSON.stringify(substring)}`,
        (actual) => typeof actual === "string" && actual.includes(substring),
      ),
    stringMatching: (pattern: string | RegExp) =>
      asymmetric(`StringMatching ${String(pattern)}`, (actual) => {
        if (typeof actual !== "string") return false;
        return typeof pattern === "string"
          ? actual.includes(pattern)
          : pattern.test(actual);
      }),
    toSatisfy: (predicate: (value: any) => boolean, description?: string) =>
      asymmetric(
        `Satisfies ${description ?? predicate.name ?? "predicate"}`,
        (actual) => predicate(actual),
      ),
    fail: (message?: string): never => {
      throw new AssertionError(message ?? "expect.fail()");
    },
  },
);

// ---------------------------------------------------------------------------
// assert
// ---------------------------------------------------------------------------

export interface Assert {
  (condition: unknown, message?: string): asserts condition;
  strictEqual(actual: unknown, expected: unknown, message?: string): void;
  deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  isDefined<A>(value: A): asserts value is NonNullable<A>;
  fail(message?: string): never;
}

const assertFn = (condition: unknown, message?: string): asserts condition => {
  if (!condition) {
    throw new AssertionError(message ?? "assertion failed");
  }
};

export const assert: Assert = Object.assign(assertFn, {
  strictEqual: (actual: unknown, expected: unknown, message?: string) => {
    if (!Object.is(actual, expected)) {
      throw new AssertionError(
        message ?? `expected ${stringify(actual)} to be ${stringify(expected)}`,
        actual,
        expected,
      );
    }
  },
  deepStrictEqual: (actual: unknown, expected: unknown, message?: string) => {
    if (!equals(actual, expected, true)) {
      throw new AssertionError(
        message ??
          `expected ${stringify(actual)} to deep equal ${stringify(expected)}`,
        actual,
        expected,
      );
    }
  },
  isDefined: <A>(value: A): asserts value is NonNullable<A> => {
    if (value === null || value === undefined) {
      throw new AssertionError(`expected value to be defined`);
    }
  },
  fail: (message?: string): never => {
    throw new AssertionError(message ?? "assert.fail()");
  },
}) as Assert;
