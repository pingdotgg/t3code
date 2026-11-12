// GT validates every locale with Intl.Locale and English Intl.DisplayNames, which Hermes lacks.
// gt-react-native's Babel plugin would inject these; plain imports keep the Metro and Babel config unchanged.
import "@formatjs/intl-getcanonicallocales/polyfill";
import "@formatjs/intl-locale/polyfill";
import "@formatjs/intl-displaynames/polyfill";
import "@formatjs/intl-displaynames/locale-data/en";
