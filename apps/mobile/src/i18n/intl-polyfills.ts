// GT validates every locale with Intl.Locale and English Intl.DisplayNames, and selects every plural
// branch with Intl.PluralRules; Hermes has none of them, so plural messages would render as raw ICU.
// gt-react-native's Babel plugin would inject these; plain imports keep the Metro and Babel config unchanged.
import "@formatjs/intl-getcanonicallocales/polyfill";
import "@formatjs/intl-locale/polyfill";
import "@formatjs/intl-displaynames/polyfill";
import "@formatjs/intl-displaynames/locale-data/en";
import "@formatjs/intl-pluralrules/polyfill";
import "@formatjs/intl-pluralrules/locale-data/en";
import "@formatjs/intl-pluralrules/locale-data/de";
import "@formatjs/intl-pluralrules/locale-data/es";
import "@formatjs/intl-pluralrules/locale-data/fr";
import "@formatjs/intl-pluralrules/locale-data/ja";
import "@formatjs/intl-pluralrules/locale-data/ko";
import "@formatjs/intl-pluralrules/locale-data/pl";
import "@formatjs/intl-pluralrules/locale-data/pt";
import "@formatjs/intl-pluralrules/locale-data/ru";
import "@formatjs/intl-pluralrules/locale-data/sv";
import "@formatjs/intl-pluralrules/locale-data/zh";

// GT builds a new Intl.PluralRules for every plural message it formats, and the polyfill's
// constructor compares the locale with every locale it knows. One launch formats over a hundred
// plural messages, so equal arguments share one instance. An instance holds no state that changes.
const PolyfilledPluralRules = Intl.PluralRules;
const sharedPluralRules = new Map<string, Intl.PluralRules>();

/**
 * The key for arguments a string describes in full: locale tags, and options that are a plain
 * record of primitive values. Null for anything else, such as an Intl.Locale, inherited options
 * or an option getter.
 */
function sharedPluralRulesKey(args: ReadonlyArray<unknown>): string | null {
  const [locales, options] = args;
  const tags = typeof locales === "string" ? [locales] : locales;
  if (args.length > 2 || !Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) {
    return null;
  }
  if (options === undefined) return JSON.stringify([tags]);
  if (
    typeof options !== "object" ||
    options === null ||
    Object.getPrototypeOf(options) !== Object.prototype
  ) {
    return null;
  }
  const entries = Object.entries(Object.getOwnPropertyDescriptors(options))
    .map(([name, property]) => [name, property.value] as const)
    .sort(([left], [right]) => (left < right ? -1 : 1));
  return entries.every(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    ? JSON.stringify([tags, entries])
    : null;
}

const SharedPluralRules: typeof Intl.PluralRules = new Proxy(PolyfilledPluralRules, {
  construct(target, args, newTarget) {
    // A subclass must get its own instance.
    const key = newTarget === SharedPluralRules ? sharedPluralRulesKey(args) : null;
    const shared = key === null ? undefined : sharedPluralRules.get(key);
    if (shared !== undefined) return shared;
    const rules: Intl.PluralRules = Reflect.construct(target, args, newTarget);
    if (key !== null) sharedPluralRules.set(key, rules);
    return rules;
  },
});
// The property is read-only in the lib types; the polyfill defines it the same way.
Object.defineProperty(Intl, "PluralRules", {
  configurable: true,
  writable: true,
  value: SharedPluralRules,
});
