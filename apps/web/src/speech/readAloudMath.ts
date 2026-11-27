import { markdownMathRanges } from "@t3tools/shared/markdownMath";
import { speakTex, type SpeakMath } from "@t3tools/shared/read-aloud";
import baseRules from "speech-rule-engine/lib/mathmaps/base.json?url";
import deRules from "speech-rule-engine/lib/mathmaps/de.json?url";
import enRules from "speech-rule-engine/lib/mathmaps/en.json?url";
import esRules from "speech-rule-engine/lib/mathmaps/es.json?url";
import frRules from "speech-rule-engine/lib/mathmaps/fr.json?url";
import koRules from "speech-rule-engine/lib/mathmaps/ko.json?url";
import svRules from "speech-rule-engine/lib/mathmaps/sv.json?url";
import { getClientSettings } from "../hooks/useSettings";
import { getActiveLocale } from "../i18n/messages";

// Speech Rule Engine's rules for the app's languages it covers; the rest hear English. Bundled so
// the engine never fetches them from its CDN.
const RULES: Record<string, string> = {
  base: baseRules,
  de: deRules,
  en: enRules,
  es: esRules,
  fr: frRules,
  ko: koRules,
  sv: svRules,
};

let engine: Promise<typeof import("speech-rule-engine/mjs/common/system.js")> | null = null;
let engineLocale = "";

async function loadEngine(locale: string) {
  if (!engine || engineLocale !== locale) {
    engineLocale = locale;
    engine = (async () => {
      // The system module, not the package index, which loads the command line and its Node probes.
      const [sre, { Engine }] = await Promise.all([
        import("speech-rule-engine/mjs/common/system.js"),
        import("speech-rule-engine/mjs/common/engine.js"),
      ]);
      Engine.getInstance().setCustomLoader(async (name: string) => {
        const url = RULES[name];
        if (!url) throw new Error(`No math speech rules for ${name}.`);
        return (await fetch(url)).text();
      });
      await sre.setupEngine({ locale, domain: "clearspeak", modality: "speech" });
      await sre.engineReady();
      return sre;
    })();
    engine.catch(() => {
      engine = null;
    });
  }
  return engine;
}

/**
 * Words for the reply's formulas, the way screen readers say them (ClearSpeak), when replies
 * render math. Without math rendering, the reply shows TeX, so that is what is read. Replies
 * without formulas get an answer at once.
 */
export function prepareReadAloudMath(markdown: string): Promise<SpeakMath> | undefined {
  if (!getClientSettings().mathRenderingEnabled) return undefined;
  const formulas = markdownMathRanges(markdown);
  return formulas.length ? speakFormulas(formulas) : undefined;
}

async function speakFormulas(
  formulas: ReadonlyArray<{ readonly tex: string; readonly display: boolean }>,
): Promise<SpeakMath> {
  const language = getActiveLocale().split("-")[0] ?? "en";
  const [sre, katex] = await Promise.all([
    loadEngine(language in RULES ? language : "en"),
    import("katex"),
  ]);
  const spoken = new Map<string, string | undefined>();
  for (const { tex, display } of formulas)
    if (!spoken.has(tex)) spoken.set(tex, speakTex(katex.default, sre.toSpeech, tex, display));
  // A formula KaTeX cannot parse is read as its source.
  return (tex) => spoken.get(tex);
}
