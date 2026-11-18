import { expect, it } from "vite-plus/test";

import { nativeSpeechLanguage } from "./nativeLanguage.ts";

const nemotron = ["en-US", "en-GB", "es-US", "es-ES", "de-DE"];

it.each([
  ["auto omits the hint", nemotron, "auto", undefined],
  ["exact entry", ["en", "de"], "de", "de"],
  ["exact entry before a regional one", ["de-DE", "de"], "de", "de"],
  ["case and underscore normalize to the advertised spelling", nemotron, "DE_de", "de-DE"],
  ["bare code takes the first regional entry", nemotron, "en", "en-US"],
  ["regional request with another region passes through", nemotron, "de-AT", "de-AT"],
  ["unadvertised language passes through", nemotron, "fr", "fr"],
  ["model without an advertised list passes through", [], "de", "de"],
])("%s", (_name, advertised, language, expected) => {
  expect(nativeSpeechLanguage(advertised, language)).toBe(expected);
});
