import { ExpressiveCodeTheme } from "@astrojs/starlight/expressive-code";

/**
 * Alchemy "walnut sunrise" Expressive Code theme.
 *
 * Dark walnut bg (#2a2620) + sunrise syntax tokens that match the design
 * system's `--alc-code-*` variables. Designed for legibility on cream
 * parchment pages where every other surface is light.
 */
const walnutSunrise = {
  name: "alchemy-walnut-sunrise",
  type: "dark",
  semanticHighlighting: true,
  colors: {
    "editor.background": "#2a2620",
    "editor.foreground": "#faf5e3",
    "editor.lineHighlightBackground": "#36302280",
    "editor.selectionBackground": "#5c7a3e66",
    "editorLineNumber.foreground": "#85714f",
    "editorLineNumber.activeForeground": "#faf5e3",
    "editorIndentGuide.background": "#4e402c",
    "editorIndentGuide.activeBackground": "#68573c",
    "editorBracketMatch.background": "#5c7a3e33",
    "editorBracketMatch.border": "#5c7a3e",
    "editorWidget.background": "#363022",
    "editorWidget.border": "#4e402c",
    "editorHoverWidget.background": "#363022",
    "editorHoverWidget.border": "#4e402c",
    "editorGroupHeader.tabsBackground": "#1a1813",
    "tab.activeBackground": "#2a2620",
    "tab.inactiveBackground": "#1a1813",
    "tab.activeForeground": "#faf5e3",
    "tab.inactiveForeground": "#a89572",
    "tab.border": "#4e402c",
    focusBorder: "#5c7a3e",
    "scrollbarSlider.background": "#4e402c80",
    "scrollbarSlider.hoverBackground": "#68573c80",
    "scrollbarSlider.activeBackground": "#85714f80",
    "diffEditor.insertedTextBackground": "#5c7a3e26",
    "diffEditor.removedTextBackground": "#b3462e26",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment", "string.comment"],
      settings: { foreground: "#b3a27a", fontStyle: "italic" },
    },
    {
      scope: [
        "keyword",
        "storage",
        "storage.type",
        "storage.modifier",
        "keyword.control",
        "keyword.operator.new",
        "keyword.operator.expression",
        "keyword.other",
      ],
      settings: { foreground: "#d4f26a" },
    },
    {
      scope: [
        "keyword.operator",
        "punctuation.separator",
        "punctuation.terminator",
      ],
      settings: { foreground: "#c7b795" },
    },
    {
      scope: ["string", "string.quoted", "punctuation.definition.string"],
      settings: { foreground: "#ffe38a" },
    },
    {
      scope: ["string.template", "punctuation.definition.template-expression"],
      settings: { foreground: "#ffe38a" },
    },
    {
      scope: ["constant.numeric", "constant.language", "constant.character"],
      settings: { foreground: "#ff9a6b" },
    },
    {
      scope: [
        "constant.language.boolean",
        "constant.language.null",
        "constant.language.undefined",
      ],
      settings: { foreground: "#ff9a6b" },
    },
    {
      scope: [
        "entity.name.function",
        "support.function",
        "meta.function-call entity.name.function",
        "meta.function-call.method entity.name.function",
        "variable.function",
        "meta.definition.method entity.name.function",
      ],
      settings: { foreground: "#7ddfff" },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "entity.name.interface",
        "entity.name.namespace",
        "support.type",
        "support.class",
        "support.other.namespace",
        "support.module",
        "meta.type",
      ],
      settings: { foreground: "#7ddfff" },
    },
    {
      scope: [
        "variable.other.object",
        "variable.other.readwrite.alias",
        "meta.import variable.other.readwrite",
        "meta.export variable.other.readwrite",
        "meta.object-literal.key support.type.object",
      ],
      settings: { foreground: "#7ddfff" },
    },
    {
      scope: ["entity.name.tag", "meta.tag entity.name.tag"],
      settings: { foreground: "#ffb968" },
    },
    {
      scope: ["entity.other.attribute-name"],
      settings: { foreground: "#d4f26a", fontStyle: "italic" },
    },
    {
      scope: [
        "variable",
        "variable.other",
        "variable.parameter",
        "meta.definition.variable variable.other",
      ],
      settings: { foreground: "#faf5e3" },
    },
    {
      scope: ["variable.other.constant"],
      settings: { foreground: "#7ddfff" },
    },
    {
      scope: ["variable.other.enummember"],
      settings: { foreground: "#ff9a6b" },
    },
    {
      scope: ["variable.other.property", "meta.object.member"],
      settings: { foreground: "#faf5e3" },
    },
    {
      scope: ["support.variable", "support.constant"],
      settings: { foreground: "#7ddfff" },
    },
    {
      scope: ["punctuation.section.embedded", "meta.embedded"],
      settings: { foreground: "#faf5e3" },
    },
    {
      scope: ["markup.heading", "markup.bold"],
      settings: { foreground: "#faf5e3", fontStyle: "bold" },
    },
    {
      scope: ["markup.italic"],
      settings: { foreground: "#faf5e3", fontStyle: "italic" },
    },
    {
      scope: ["markup.inserted", "markup.inserted.diff"],
      settings: { foreground: "#8fb15e" },
    },
    {
      scope: ["markup.deleted", "markup.deleted.diff"],
      settings: { foreground: "#e07a5f" },
    },
    {
      scope: ["invalid", "invalid.illegal"],
      settings: { foreground: "#e07a5f" },
    },
  ],
};

export const alchemyWalnutTheme = ExpressiveCodeTheme.fromJSONString(
  JSON.stringify(walnutSunrise),
);
