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
import "@formatjs/intl-pluralrules/locale-data/pt";
import "@formatjs/intl-pluralrules/locale-data/ru";
import "@formatjs/intl-pluralrules/locale-data/sv";
import "@formatjs/intl-pluralrules/locale-data/zh";

// GT builds a new Intl.PluralRules for every plural message it formats, and the polyfill's
// constructor compares the locale with every locale it knows. One launch formats over a hundred
// plural messages, so equal arguments share one instance. An instance holds no state that changes.
const PolyfilledPluralRules = Intl.PluralRules;
const sharedPluralRules = new Map<string, Intl.PluralRules>();
// The property is read-only in the lib types; the polyfill defines it the same way.
Object.defineProperty(Intl, "PluralRules", {
  configurable: true,
  writable: true,
  value: new Proxy(PolyfilledPluralRules, {
    construct(target, args: ConstructorParameters<typeof Intl.PluralRules>) {
      const key = JSON.stringify(args);
      let rules = sharedPluralRules.get(key);
      if (rules === undefined) {
        rules = new target(...args);
        sharedPluralRules.set(key, rules);
      }
      return rules;
    },
  }),
});
