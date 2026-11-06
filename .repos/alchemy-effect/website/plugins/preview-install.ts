import type { ExpressiveCodePlugin } from "@astrojs/starlight/expressive-code";

/**
 * Install specs for alchemy's own packages (`alchemy`, `@alchemy.run/*`).
 *
 * On main.alchemy.run and PR previews, website.yml sets `PREVIEW_PACKAGE_TAG`
 * (`<sha>` on main, `pr:<N>:<short-sha>` on PRs) and installs come from the
 * preview registry. Everywhere else they install `@latest` from npm. A full
 * commit sha is shortened — the registry resolves short shas too.
 */
const tag = process.env.PREVIEW_PACKAGE_TAG?.replace(/^([0-9a-f]{7})[0-9a-f]{33}$/, "$1");

export const installSpec = (name: string) =>
  tag ? `https://pkg.alchemy.run/${name}/${tag}` : `${name}@latest`;

const INSTALL =
  /^\s*(?:npm (?:i|install|add)|pnpm (?:add|i|install)|bun (?:add|i|install)|yarn add)\b/;
// `alchemy` or `@alchemy.run/<name>`, with any `@<version>`, as a whole
// (optionally quoted) argument.
const PACKAGE = /(?<=^|\s)(["']?)(alchemy|@alchemy\.run\/[a-z0-9-]+)(?:@[\w.^~-]+)?\1(?=\s|$)/g;

/** Rewrites install commands in code blocks to {@link installSpec}. */
export function previewInstallUrls(): ExpressiveCodePlugin {
  return {
    name: "preview-install-urls",
    hooks: {
      preprocessCode({ codeBlock }) {
        for (const line of codeBlock.getLines()) {
          if (!INSTALL.test(line.text)) continue;
          // Edit right to left so earlier columns stay valid.
          for (const match of [...line.text.matchAll(PACKAGE)].reverse()) {
            const [whole, quote, name] = match;
            line.editText(
              match.index,
              match.index + whole.length,
              `${quote}${installSpec(name!)}${quote}`,
            );
          }
        }
      },
    },
  };
}
