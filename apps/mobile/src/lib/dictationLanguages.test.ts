import { describe, expect, it } from "vite-plus/test";

import { dictationLanguageLabel } from "./dictationLanguages";

const languages = [{ id: "pt-BR", label: "Português (Brasil)" }];

describe("dictationLanguageLabel", () => {
  it("names the chosen language from the loaded list", () => {
    expect(dictationLanguageLabel(languages, "pt-BR")).toBe("Português (Brasil)");
  });

  it("shows the raw tag until the list loads or when the list lacks it", () => {
    expect(dictationLanguageLabel(undefined, "pt-BR")).toBe("pt-BR");
    expect(dictationLanguageLabel(languages, "sv-SE")).toBe("sv-SE");
  });

  it("names the device language when nothing is chosen", () => {
    expect(dictationLanguageLabel(languages, null)).toBe("Device language");
    expect(dictationLanguageLabel(undefined, undefined)).toBe("Device language");
  });
});
