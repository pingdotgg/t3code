---
name: generate-slides
description: Generate a slide deck as a self-contained HTML page
---

Load the visual-explainer skill and generate a slide deck for: $@

If `$@` contains the literal `--pptx` flag, remove that flag from the topic. Generate the HTML slide deck first, then run the best-effort static exporter with `visual-explainer-pptx <deck.html> <deck.pptx>` from package installs or `node ./pptx/export.mjs <deck.html> <deck.pptx>` from a checkout after dependencies are installed. If the exporter dependencies are not available, deliver the HTML deck and explain that PPTX export needs the package install or checkout dependencies. Tell the user that the HTML deck remains the source of truth and the PPTX will not preserve animations, reader navigation, responsive layout, custom fonts, live Mermaid/Chart.js/SVG/canvas rendering, or JavaScript behavior.

Before writing HTML, read `./templates/slide-deck.html`, `./references/slide-patterns.md`, and only the shared CSS/library sections needed for the source.

Plan the deck first: inventory the source, map every item to slides, choose a narrative arc, and assign a composition to each slide. Use the 10 slide types and nav chrome from `slide-patterns.md`/`slide-deck.html`, including carousel dots, prev/next, slide count, and keyboard controls. Treat `100dvh` as a hard content budget: split dense content across slides rather than scrolling or dropping content. Before delivery, enable `prefers-reduced-motion: reduce` at the target viewport and a short landscape height; fix every overflow or `autoFit()` warning before shipping.

Use visual-first slides: diagrams, charts, tables, SVG accents, and images from `surf` only when they clarify the story. Vary compositions; three centered slides in a row is a smell.

Write to `~/.agent/diagrams/` and open in the browser.
