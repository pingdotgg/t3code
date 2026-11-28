// Generates src/internal/emojiData.ts from a pinned copy of iamcal/emoji-data.
//
// Usage (from packages/chat/slack): node scripts/generate-emoji.mjs
//
// The source is pinned by commit, byte size and SHA-256 digest. Any mismatch
// aborts the run without touching the output. The output is deterministic, so
// a second run produces no diff.
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"

const PROJECT = "iamcal/emoji-data"
const TAG = "v16.0.0"
const COMMIT = "2771d0b1b3af25c069086e68e38f901c3dda8bdf"
const SOURCE_URL = "https://raw.githubusercontent.com/iamcal/emoji-data/" + COMMIT + "/emoji.json"
const SIZE = 1313457
const SHA256 = "1d602e65be88772bf8cc368ce16b855d719eeddbafe128d471b80203f494d29f"
const COUNTS = { emoji: 1911, names: 1972, variations: 1875 }

// Copied verbatim from https://github.com/iamcal/emoji-data/blob/<COMMIT>/LICENSE
const LICENSE = [
  "The MIT License (MIT)",
  "",
  "Copyright (c) 2013 Cal Henderson",
  "",
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  "of this software and associated documentation files (the \"Software\"), to deal",
  "in the Software without restriction, including without limitation the rights",
  "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
  "copies of the Software, and to permit persons to whom the Software is",
  "furnished to do so, subject to the following conditions:",
  "",
  "The above copyright notice and this permission notice shall be included in all",
  "copies or substantial portions of the Software.",
  "",
  "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR",
  "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
  "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
  "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
  "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
  "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
  "SOFTWARE."
]

// Skin tone modifier code point -> Slack "skin-tone-N" digit.
const TONES = { "1F3FB": "2", "1F3FC": "3", "1F3FD": "4", "1F3FE": "5", "1F3FF": "6" }

const OUTPUT = new URL("../src/internal/emojiData.ts", import.meta.url)

const fail = (message) => {
  throw new Error("generate-emoji: " + message)
}

const response = await fetch(SOURCE_URL)
if (!response.ok) fail("GET " + SOURCE_URL + " returned " + response.status)
const bytes = new Uint8Array(await response.arrayBuffer())
if (bytes.byteLength !== SIZE) fail("expected " + SIZE + " bytes, got " + bytes.byteLength)
const digest = createHash("sha256").update(bytes).digest("hex")
if (digest !== SHA256) fail("expected sha256 " + SHA256 + ", got " + digest)

const emoji = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))

const SEQUENCE = /^[0-9A-F]{4,6}(-[0-9A-F]{4,6})*$/
const NAME = /^[a-z0-9_+-]+$/

const sequence = (value) => {
  if (typeof value !== "string" || !SEQUENCE.test(value)) fail("bad code point sequence " + JSON.stringify(value))
  return value.toLowerCase()
}

const withoutVariationSelector = (unified) =>
  unified.split("-").filter((codePoint) => codePoint !== "fe0f").join("-")

// "" = none, "!" = the unified sequence without U+FE0F, otherwise the sequence.
const nonQualified = (unified, value) => {
  if (value === null || value === undefined) return ""
  const encoded = sequence(value)
  if (encoded === unified) fail("non_qualified equals unified: " + value)
  return encoded === withoutVariationSelector(unified) ? "!" : encoded
}

const names = new Set()
const sequences = new Set()
const claim = (set, value, what) => {
  if (set.has(value)) fail("duplicate " + what + " " + value)
  set.add(value)
}

let nameCount = 0
let variationCount = 0
const lines = []
const sorted = [...emoji].sort((a, b) => (a.unified < b.unified ? -1 : a.unified > b.unified ? 1 : 0))

for (const entry of sorted) {
  if (!Array.isArray(entry.short_names) || entry.short_names[0] !== entry.short_name) {
    fail("short_name is not the first short_names entry for " + entry.unified)
  }
  for (const name of entry.short_names) {
    if (typeof name !== "string" || !NAME.test(name)) fail("bad short name " + JSON.stringify(name))
    claim(names, name, "short name")
    nameCount++
  }
  const unified = sequence(entry.unified)
  claim(sequences, unified, "sequence")
  const nq = nonQualified(unified, entry.non_qualified)
  if (nq !== "") claim(sequences, nq === "!" ? withoutVariationSelector(unified) : nq, "sequence")

  const fields = [entry.short_names.join(","), unified, nq]
  if (entry.skin_variations !== undefined) {
    // Variations sharing a template (the variation's unified sequence with each
    // skin tone modifier replaced by "*") are stored as one group.
    const groups = new Map()
    for (const key of Object.keys(entry.skin_variations).sort()) {
      const modifiers = key.split("-")
      const tones = modifiers.map((codePoint) => TONES[codePoint] ?? fail("unknown skin tone key " + key))
      const variation = entry.skin_variations[key]
      const variationUnified = sequence(variation.unified)
      claim(sequences, variationUnified, "sequence")
      const variationNq = nonQualified(variationUnified, variation.non_qualified)
      if (variationNq !== "") {
        if (variationNq !== "!") fail("unsupported skin variation non_qualified " + variation.non_qualified)
        claim(sequences, withoutVariationSelector(variationUnified), "sequence")
      }
      let index = 0
      const template = variationUnified.split("-").map((codePoint) => {
        if (TONES[codePoint.toUpperCase()] === undefined) return codePoint
        if (codePoint.toUpperCase() !== modifiers[index++]) fail("skin tone order mismatch in " + variation.unified)
        return "*"
      }).join("-")
      if (index !== modifiers.length) fail("skin tone count mismatch in " + variation.unified)
      const group = template + (variationNq === "" ? "" : ":" + variationNq)
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group).push(tones.join(""))
      variationCount++
      // Round trip: the stored form must reproduce the upstream sequence.
      let fill = 0
      const expanded = template.split("-").map((codePoint) => (codePoint === "*" ? modifiers[fill++].toLowerCase() : codePoint))
        .join("-")
      if (expanded !== variationUnified) fail("template round trip failed for " + variation.unified)
    }
    fields.push([...groups].map(([group, keys]) => keys.join(",") + ":" + group).join(";"))
  }
  lines.push(fields.join("|"))
}

const counts = { emoji: lines.length, names: nameCount, variations: variationCount }
for (const key of Object.keys(COUNTS)) {
  if (counts[key] !== COUNTS[key]) fail("expected " + COUNTS[key] + " " + key + ", got " + counts[key])
}

const output = [
  "/**",
  " * Slack emoji short names and code point sequences.",
  " *",
  " * Generated by scripts/generate-emoji.mjs. Do not edit.",
  " *",
  " * Source:",
  " * - Project: " + PROJECT,
  " * - Tag: " + TAG,
  " * - Commit: " + COMMIT,
  " * - URL: " + SOURCE_URL,
  " * - SHA-256: " + SHA256,
  " * - Size: " + SIZE + " bytes",
  " * - License: MIT (reproduced below)",
  " *",
  " * Format: one emoji per line (" + counts.emoji + " emoji, " + counts.names + " short names, " + counts.variations +
  " skin tone variations), sorted by unified:",
  " *",
  " *   short_names|unified|non_qualified[|variations]",
  " *",
  " * - short_names: comma separated, the first one is short_name",
  " * - unified: lowercase hex code points joined by \"-\"",
  " * - non_qualified: empty for none, \"!\" for unified without U+FE0F, otherwise",
  " *   a code point sequence",
  " * - variations: \";\" separated groups of skin_variations entries, each",
  " *   keys:template[:non_qualified]. keys is a comma separated list of upstream",
  " *   skin_variations keys, written as one Slack skin-tone-N digit (2-6) per",
  " *   modifier. template is the variation's unified sequence with each modifier",
  " *   replaced by \"*\", filled in key order. non_qualified is empty or \"!\"",
  " *",
  ...LICENSE.map((line) => (line === "" ? " *" : " * " + line)),
  " *",
  " * @internal",
  " */",
  "",
  "/** @internal */",
  "export const emojiData = `" + lines.join("\n") + "`",
  ""
].join("\n")

writeFileSync(OUTPUT, output)
console.log("wrote " + OUTPUT.pathname + " (" + Buffer.byteLength(output) + " bytes)")
