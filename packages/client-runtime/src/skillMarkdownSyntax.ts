import { collectComposerSkillTokens } from "@t3tools/shared/composerInlineTokens";
import { markdownLineEnding, markdownSpace } from "micromark-util-character";
import type { Extension, Tokenizer } from "micromark-util-types";
import type { Processor } from "unified";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    quotedSkill: "quotedSkill";
  }
}

const tokenize: Tokenizer = function (effects, ok, nok) {
  let token: ReturnType<typeof effects.enter>;
  let escaped = false;
  let prefix = "";

  const start = (code: number | null) => {
    if (code === null || (this.previous !== null && !isWhitespace(this.previous))) {
      return nok(code);
    }
    token = effects.enter("quotedSkill");
    effects.consume(code);
    prefix = String.fromCharCode(code);
    return openingQuote;
  };

  const openingQuote = (code: number | null) => {
    if (
      code !== null &&
      prefix.length === 1 &&
      /[\uD800-\uDBFF]/u.test(prefix) &&
      code >= 0xdc00 &&
      code <= 0xdfff
    ) {
      prefix += String.fromCharCode(code);
      effects.consume(code);
      return openingQuote;
    }
    if (code !== 34 || !/^\p{Sc}$/u.test(prefix)) return nok(code);
    effects.consume(code);
    return content;
  };

  const content = (code: number | null) => {
    if (code === null || markdownLineEnding(code)) return nok(code);
    effects.consume(code);
    if (escaped) {
      escaped = false;
    } else if (code === 92) {
      escaped = true;
    } else if (code === 34) {
      effects.exit("quotedSkill");
      return afterQuote;
    }
    return content;
  };

  const afterQuote = (code: number | null) => {
    if (code !== null && !isWhitespace(code)) return nok(code);
    return collectComposerSkillTokens(this.sliceSerialize(token)).length === 1
      ? ok(code)
      : nok(code);
  };
  return start;
};

function isWhitespace(code: number): boolean {
  return (
    markdownLineEnding(code) ||
    markdownSpace(code) ||
    (code >= 0 && /\s/u.test(String.fromCharCode(code)))
  );
}

// Micromark dispatches by the first UTF-16 unit, including for supplementary currency symbols.
const CURRENCY_SYMBOLS = "$¢£¤¥֏؋߾߿৲৳৻૱௹฿៛₠₡₢₣₤₥₦₧₨₩₪₫€₭₮₯₰₱₲₳₴₵₶₷₸₹₺₻₼₽₾₿⃀⃁꠸﷼﹩＄￠￡￥￦𑿝𑿞𑿟𑿠𞋿𞲰";
const syntax: Extension = {
  text: Object.fromEntries(
    Array.from(CURRENCY_SYMBOLS, (symbol) => [symbol.charCodeAt(0), { tokenize }]),
  ),
};

/** Preserve quoted skill source before Markdown consumes escapes or emphasis. */
function attachSkillTokens(this: Processor) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(syntax);
  (data.fromMarkdownExtensions ??= []).push({
    enter: {
      quotedSkill(token) {
        this.enter({ type: "text", value: this.sliceSerialize(token) }, token);
      },
    },
    exit: {
      quotedSkill(token) {
        this.exit(token);
      },
    },
  });
}

export const remarkSkillTokens = attachSkillTokens;
