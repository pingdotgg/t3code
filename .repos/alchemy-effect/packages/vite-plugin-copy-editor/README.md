# @alchemy.run/vite-plugin-copy-editor

Edit hardcoded copy in the browser while `vite dev` runs, and have each edit
written back to the source file.

```ts
// vite.config.ts (or `vite.plugins` in astro.config.ts)
import { copyEditor } from "@alchemy.run/vite-plugin-copy-editor";

export default defineConfig({
  // Register before framework plugins so it sees the raw source.
  plugins: [copyEditor(), react()],
});
```

Mark any piece of hardcoded copy with a bare `data-copy` attribute:

```html
<h1 data-copy>Reach for the better primitives.</h1>
<p data-copy>Snap together cloud resources with <code>Alchemy</code>.</p>
```

- **Dev** (`vite serve`): every `data-copy` element is editable. Click and type;
  leaving the element or pressing Enter saves, Escape reverts. Only the changed
  words are rewritten, so tags, entities, and line wrapping are preserved.
  Ctrl/Cmd+click still follows links inside editable copy.
- **Build**: the attribute is stripped and none of the editor ships.

Works with `.astro`, `.html`, `.jsx`, `.tsx`, `.vue`, and `.svelte` files
(configure with `copyEditor({ include: /\.(tsx|html)$/ })`). An editable
element may contain only text and plain HTML tags; elements containing
`{expressions}` or components are rejected with an explanation in the browser.

## Markdown sections

Content that comes from markdown (docs pages, a CMS, generated reference) can
be edited as markdown instead of rendered text. Mark the section's container
and supply a handler for its id scheme:

```html
<div data-copy="docs:intro" data-copy-format="markdown" data-copy-style="docs">
  …rendered markdown…
</div>
```

```ts
copyEditor({
  handlers: {
    docs: {
      readSource: async (id) => loadMarkdown(id),
      writeSource: async ({ id, source, base }) => saveMarkdown(id, source, base),
    },
  },
  markdownStyles: {
    docs: {
      elements: {
        code: { class: "inline-code" }, // inline code
        pre: { class: "code-block" }, // code blocks
        a: { class: "link" },
        ul: { class: "bullets" },
      },
      css: `[data-copy-style="docs"] .code-block { background: #111; }`,
    },
  },
});
```

Focusing the section swaps in its markdown source (Enter adds a line,
Ctrl/Cmd+Enter or leaving the section saves, Escape cancels). One-line
template copy is edited as inline markdown: Enter saves, and Shift+Enter
adds a line break (`<br>`). After saving,
the section shows a preview rendered with its `data-copy-style` preset.
Once the handler's follow-up work (for example regenerating pages) finishes,
the page's own rendering replaces the preview. If the handler reports a
structural change (`reload: true`), the page reloads instead.

Content that isn't rendered through Vite (markdown files) can mark a single
element with a trailing `<!--copy:<scheme>:<id>-->` comment for inline
editing; handlers implement `edit` for those.
