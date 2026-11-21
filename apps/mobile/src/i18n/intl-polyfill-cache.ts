// Memoizes immutable Intl polyfill lookups (@formatjs + Hermes) that GT invokes per formatted message.

const INSTALLED_FLAG = Symbol.for("t3code.mobile.intlPolyfillCacheInstalled");
const MAX_CONSTRUCTOR_CACHE = 128;
const MAX_LOCALE_CACHE = 256;
const MAX_LOOKUP_CACHE = 512;

type GenericConstructor = new (...args: unknown[]) => object;

function serializeLocalesArg(
  locales: Intl.LocalesArgument,
  OrigLocale: typeof Intl.Locale | undefined,
): string | null {
  if (locales === undefined) return "__def__";
  if (typeof locales === "string") return `s:${locales}`;
  if (OrigLocale && locales instanceof OrigLocale) return `l:${locales.toString()}`;
  if (Array.isArray(locales)) {
    if (locales.length === 0) return "a:";
    const parts: string[] = [];
    for (let i = 0; i < locales.length; i++) {
      const item = locales[i];
      if (typeof item === "string") {
        parts.push(item);
      } else if (OrigLocale && item instanceof OrigLocale) {
        parts.push(item.toString());
      } else {
        return null;
      }
    }
    return `a:${parts.join("\u0000")}`;
  }
  return null;
}

function serializePlainOptions(options: unknown): string | null {
  if (options === undefined) return "";
  if (typeof options !== "object" || options === null) return null;
  const proto = Object.getPrototypeOf(options);
  if (proto !== Object.prototype && proto !== null) return null;
  const keys = Object.keys(options as Record<string, unknown>);
  if (keys.length === 0) return "";
  if (keys.length > 16) return null;
  if (keys.length > 1) keys.sort();
  const parts: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const value = (options as Record<string, unknown>)[key];
    const type = typeof value;
    if (value === undefined) continue;
    if (type !== "string" && type !== "number" && type !== "boolean") {
      return null;
    }
    parts.push(`${key}=${type[0]}:${String(value)}`);
  }
  return parts.join("|");
}

function wrapSupportedLocalesOf(
  origFn:
    | ((locales: Intl.LocalesArgument, options?: { localeMatcher?: string }) => string[])
    | undefined,
  OrigLocale: typeof Intl.Locale | undefined,
) {
  if (typeof origFn !== "function") return origFn;
  const cache = new Map<string, readonly string[]>();
  return function supportedLocalesOf(
    this: unknown,
    locales: Intl.LocalesArgument,
    options?: { localeMatcher?: string },
  ): string[] {
    const locKey = serializeLocalesArg(locales, OrigLocale);
    const optKey = serializePlainOptions(options);
    if (locKey !== null && optKey !== null) {
      const key = `${locKey}\u0001${optKey}`;
      const cached = cache.get(key);
      if (cached !== undefined) return cached.slice();
      const result = origFn.call(this, locales, options);
      if (cache.size >= MAX_LOCALE_CACHE) cache.clear();
      cache.set(key, result.slice());
      return result;
    }
    return origFn.call(this, locales, options);
  };
}

export function installIntlPolyfillCache(): void {
  const intlObj = globalThis.Intl as unknown as Record<string | symbol, unknown> | undefined;
  if (!intlObj || intlObj[INSTALLED_FLAG]) return;
  intlObj[INSTALLED_FLAG] = true;

  const OrigLocale = intlObj.Locale as typeof Intl.Locale | undefined;

  const origGetCanonicalLocales = intlObj.getCanonicalLocales as
    | ((locales?: Intl.LocalesArgument) => string[])
    | undefined;
  if (typeof origGetCanonicalLocales === "function") {
    const canonicalCache = new Map<string, readonly string[]>();
    intlObj.getCanonicalLocales = function getCanonicalLocales(
      locales?: Intl.LocalesArgument,
    ): string[] {
      const key = serializeLocalesArg(locales, OrigLocale);
      if (key !== null) {
        const cached = canonicalCache.get(key);
        if (cached !== undefined) return cached.slice();
        const result = origGetCanonicalLocales(locales);
        if (canonicalCache.size >= MAX_LOCALE_CACHE) canonicalCache.clear();
        canonicalCache.set(key, result.slice());
        return result;
      }
      return origGetCanonicalLocales(locales);
    };
  }

  if (typeof OrigLocale === "function") {
    const TargetLocale = OrigLocale;
    const localePropCache = new WeakMap<object, Record<string, unknown>>();
    // @formatjs/intl-locale re-runs parseUnicodeLanguageId on every getter access.
    const memoizedLocaleProps = [
      "language",
      "script",
      "region",
      "baseName",
      "calendar",
      "collation",
      "caseFirst",
      "numeric",
      "numberingSystem",
      "hourCycle",
      "firstDayOfWeek",
    ] as const;

    for (const prop of memoizedLocaleProps) {
      const desc = Object.getOwnPropertyDescriptor(TargetLocale.prototype, prop);
      const origGet = desc?.get;
      if (desc && typeof origGet === "function" && desc.configurable !== false) {
        Object.defineProperty(TargetLocale.prototype, prop, {
          enumerable: desc.enumerable,
          configurable: true,
          get(this: unknown) {
            if (typeof this !== "object" || this === null) {
              return origGet.call(this);
            }
            let bag = localePropCache.get(this);
            if (bag !== undefined && prop in bag) {
              return bag[prop];
            }
            const value = origGet.call(this);
            if (bag === undefined) {
              bag = Object.create(null) as Record<string, unknown>;
              localePropCache.set(this, bag);
            }
            bag[prop] = value;
            return value;
          },
        });
      }
    }

    const origLocaleToString = TargetLocale.prototype.toString;
    if (typeof origLocaleToString === "function") {
      TargetLocale.prototype.toString = function toString(this: unknown): string {
        if (typeof this !== "object" || this === null) {
          return origLocaleToString.call(this as Intl.Locale);
        }
        let bag = localePropCache.get(this);
        if (bag !== undefined && "$toString" in bag) {
          return bag.$toString as string;
        }
        const value = origLocaleToString.call(this as Intl.Locale);
        if (bag === undefined) {
          bag = Object.create(null) as Record<string, unknown>;
          localePropCache.set(this, bag);
        }
        bag.$toString = value;
        return value;
      };
    }

    const localeCache = new Map<string, Intl.Locale>();
    function CachedLocale(
      this: unknown,
      tag: Intl.UnicodeBCP47LocaleIdentifier | Intl.Locale,
      options?: Intl.LocaleOptions,
    ) {
      if (!new.target) {
        return (TargetLocale as unknown as (...args: unknown[]) => unknown)(tag, options);
      }
      if (new.target !== CachedLocale) {
        return Reflect.construct(
          TargetLocale as unknown as GenericConstructor,
          [tag, options],
          new.target as unknown as GenericConstructor,
        );
      }
      if (options === undefined) {
        const key =
          typeof tag === "string" ? tag : tag instanceof TargetLocale ? tag.toString() : null;
        if (key !== null) {
          const cached = localeCache.get(key);
          if (cached !== undefined) return cached;
          const created = new TargetLocale(tag);
          if (localeCache.size >= MAX_LOCALE_CACHE) localeCache.clear();
          localeCache.set(key, created);
          return created;
        }
      }
      return new TargetLocale(tag, options);
    }
    CachedLocale.prototype = TargetLocale.prototype;
    Object.setPrototypeOf(CachedLocale, TargetLocale);
    intlObj.Locale = CachedLocale;
  }

  const OrigPluralRules = intlObj.PluralRules as typeof Intl.PluralRules | undefined;
  if (typeof OrigPluralRules === "function") {
    const TargetPluralRules = OrigPluralRules;
    const origSelect = TargetPluralRules.prototype.select;
    if (typeof origSelect === "function") {
      const selectCaches = new WeakMap<object, Map<number, Intl.LDMLPluralRule>>();
      TargetPluralRules.prototype.select = function select(n: number): Intl.LDMLPluralRule {
        if (typeof n === "number" && Number.isFinite(n)) {
          let map = selectCaches.get(this);
          if (map === undefined) {
            map = new Map();
            selectCaches.set(this, map);
          }
          const key = n === 0 ? 0 : n;
          const cached = map.get(key);
          if (cached !== undefined) return cached;
          const result = origSelect.call(this, n);
          if (map.size >= MAX_LOOKUP_CACHE) map.clear();
          map.set(key, result);
          return result;
        }
        return origSelect.call(this, n);
      };
    }

    const pluralRulesCache = new Map<string, Intl.PluralRules>();
    function CachedPluralRules(
      this: unknown,
      locales?: Intl.LocalesArgument,
      options?: Intl.PluralRulesOptions,
    ) {
      if (!new.target) {
        return (TargetPluralRules as unknown as (...args: unknown[]) => unknown)(locales, options);
      }
      if (new.target !== CachedPluralRules) {
        return Reflect.construct(
          TargetPluralRules as unknown as GenericConstructor,
          [locales, options],
          new.target as unknown as GenericConstructor,
        );
      }
      const locKey = serializeLocalesArg(locales, OrigLocale);
      const optKey = serializePlainOptions(options);
      if (locKey !== null && optKey !== null) {
        const key = `${locKey}\u0001${optKey}`;
        const cached = pluralRulesCache.get(key);
        if (cached !== undefined) return cached;
        const created = new TargetPluralRules(locales, options);
        if (pluralRulesCache.size >= MAX_CONSTRUCTOR_CACHE) pluralRulesCache.clear();
        pluralRulesCache.set(key, created);
        return created;
      }
      return new TargetPluralRules(locales, options);
    }
    CachedPluralRules.prototype = TargetPluralRules.prototype;
    Object.setPrototypeOf(CachedPluralRules, TargetPluralRules);
    CachedPluralRules.supportedLocalesOf = wrapSupportedLocalesOf(
      TargetPluralRules.supportedLocalesOf as (
        locales: Intl.LocalesArgument,
        options?: { localeMatcher?: string },
      ) => string[],
      OrigLocale,
    );
    intlObj.PluralRules = CachedPluralRules;
  }

  const OrigDisplayNames = intlObj.DisplayNames as typeof Intl.DisplayNames | undefined;
  if (typeof OrigDisplayNames === "function") {
    const TargetDisplayNames = OrigDisplayNames;
    if (typeof TargetDisplayNames.prototype?.of === "function") {
      const origOf = TargetDisplayNames.prototype.of;
      const ofCaches = new WeakMap<object, Map<string, string | undefined>>();
      TargetDisplayNames.prototype.of = function of(code: string): string | undefined {
        if (typeof code === "string") {
          let map = ofCaches.get(this);
          if (map === undefined) {
            map = new Map();
            ofCaches.set(this, map);
          }
          if (map.has(code)) return map.get(code);
          const result = origOf.call(this, code);
          if (map.size >= MAX_LOOKUP_CACHE) map.clear();
          map.set(code, result);
          return result;
        }
        return origOf.call(this, code);
      };
    }

    const displayNamesCache = new Map<string, Intl.DisplayNames>();
    function CachedDisplayNames(
      this: unknown,
      locales: Intl.LocalesArgument,
      options: Intl.DisplayNamesOptions,
    ) {
      if (!new.target) {
        return (TargetDisplayNames as unknown as (...args: unknown[]) => unknown)(locales, options);
      }
      if (new.target !== CachedDisplayNames) {
        return Reflect.construct(
          TargetDisplayNames as unknown as GenericConstructor,
          [locales, options],
          new.target as unknown as GenericConstructor,
        );
      }
      const locKey = serializeLocalesArg(locales, OrigLocale);
      const optKey = serializePlainOptions(options);
      if (locKey !== null && optKey !== null) {
        const key = `${locKey}\u0001${optKey}`;
        const cached = displayNamesCache.get(key);
        if (cached !== undefined) return cached;
        const created = new TargetDisplayNames(locales, options);
        if (displayNamesCache.size >= MAX_CONSTRUCTOR_CACHE) displayNamesCache.clear();
        displayNamesCache.set(key, created);
        return created;
      }
      return new TargetDisplayNames(locales, options);
    }
    CachedDisplayNames.prototype = TargetDisplayNames.prototype;
    Object.setPrototypeOf(CachedDisplayNames, TargetDisplayNames);
    CachedDisplayNames.supportedLocalesOf = wrapSupportedLocalesOf(
      TargetDisplayNames.supportedLocalesOf as (
        locales: Intl.LocalesArgument,
        options?: { localeMatcher?: string },
      ) => string[],
      OrigLocale,
    );
    intlObj.DisplayNames = CachedDisplayNames;
  }

  const OrigNumberFormat = intlObj.NumberFormat as typeof Intl.NumberFormat | undefined;
  if (typeof OrigNumberFormat === "function") {
    const TargetNumberFormat = OrigNumberFormat;
    const numberFormatCache = new Map<string, Intl.NumberFormat>();
    const cachedSupported = wrapSupportedLocalesOf(
      TargetNumberFormat.supportedLocalesOf as (
        locales: Intl.LocalesArgument,
        options?: { localeMatcher?: string },
      ) => string[],
      OrigLocale,
    );
    function CachedNumberFormat(
      this: unknown,
      locales?: Intl.LocalesArgument,
      options?: Intl.NumberFormatOptions,
    ) {
      if (new.target && new.target !== CachedNumberFormat) {
        return Reflect.construct(
          TargetNumberFormat as unknown as GenericConstructor,
          [locales, options],
          new.target as unknown as GenericConstructor,
        );
      }
      const locKey = serializeLocalesArg(locales, OrigLocale);
      const optKey = serializePlainOptions(options);
      if (locKey !== null && optKey !== null) {
        const key = `${locKey}\u0001${optKey}`;
        const cached = numberFormatCache.get(key);
        if (cached !== undefined) return cached;
        const created = new TargetNumberFormat(locales, options);
        if (numberFormatCache.size >= MAX_CONSTRUCTOR_CACHE) numberFormatCache.clear();
        numberFormatCache.set(key, created);
        return created;
      }
      return new TargetNumberFormat(locales, options);
    }
    CachedNumberFormat.prototype = TargetNumberFormat.prototype;
    Object.setPrototypeOf(CachedNumberFormat, TargetNumberFormat);
    CachedNumberFormat.supportedLocalesOf = cachedSupported;
    intlObj.NumberFormat = CachedNumberFormat;
  }

  const OrigDateTimeFormat = intlObj.DateTimeFormat as typeof Intl.DateTimeFormat | undefined;
  if (typeof OrigDateTimeFormat === "function") {
    const TargetDateTimeFormat = OrigDateTimeFormat;
    const dateTimeFormatCache = new Map<string, Intl.DateTimeFormat>();
    const cachedSupported = wrapSupportedLocalesOf(
      TargetDateTimeFormat.supportedLocalesOf as (
        locales: Intl.LocalesArgument,
        options?: { localeMatcher?: string },
      ) => string[],
      OrigLocale,
    );
    function CachedDateTimeFormat(
      this: unknown,
      locales?: Intl.LocalesArgument,
      options?: Intl.DateTimeFormatOptions,
    ) {
      if (new.target && new.target !== CachedDateTimeFormat) {
        return Reflect.construct(
          TargetDateTimeFormat as unknown as GenericConstructor,
          [locales, options],
          new.target as unknown as GenericConstructor,
        );
      }
      const locKey = serializeLocalesArg(locales, OrigLocale);
      const optKey = serializePlainOptions(options);
      if (locKey !== null && optKey !== null) {
        const key = `${locKey}\u0001${optKey}`;
        const cached = dateTimeFormatCache.get(key);
        if (cached !== undefined) return cached;
        const created = new TargetDateTimeFormat(locales, options);
        if (dateTimeFormatCache.size >= MAX_CONSTRUCTOR_CACHE) dateTimeFormatCache.clear();
        dateTimeFormatCache.set(key, created);
        return created;
      }
      return new TargetDateTimeFormat(locales, options);
    }
    CachedDateTimeFormat.prototype = TargetDateTimeFormat.prototype;
    Object.setPrototypeOf(CachedDateTimeFormat, TargetDateTimeFormat);
    CachedDateTimeFormat.supportedLocalesOf = cachedSupported;
    intlObj.DateTimeFormat = CachedDateTimeFormat;
  }
}
