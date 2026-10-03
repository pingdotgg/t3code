# Best-effort PPTX export

`visual-explainer-pptx` converts a generated visual-explainer HTML slide deck into a static `.pptx` file.

The HTML deck remains the source of truth. This exporter is intentionally best-effort and supports simple decks with `<section class="slide">` elements. It extracts slide titles, short text, bullets, simple tables, code blocks, and Mermaid source placeholders.

It does not preserve:

- animations or transitions;
- reader rail, outline, help, deep links, or resume state;
- responsive layout;
- custom web fonts;
- live Mermaid rendering, Chart.js, SVG, canvas, or JavaScript behavior.

## Usage

From a package install:

```bash
visual-explainer-pptx ~/.agent/diagrams/my-deck.html ~/.agent/diagrams/my-deck.pptx
```

From a checkout, install dependencies first:

```bash
npm install --no-package-lock
node plugins/visual-explainer/pptx/export.mjs ~/.agent/diagrams/my-deck.html ~/.agent/diagrams/my-deck.pptx
```

If you omit the output path, the exporter writes beside the input with a `.pptx` suffix.

Use the HTML output for final fidelity. Use the `.pptx` as a portable static handoff when a presentation file is required.
