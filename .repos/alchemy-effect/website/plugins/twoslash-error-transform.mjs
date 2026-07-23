/**
 * Expressive Code plugin that transforms twoslash error text per code block.
 *
 * Use `errorReplace` in the code block meta to specify regex replacements:
 *   errorReplace="pattern::replacement"
 *
 * Patterns are JavaScript regexes applied with the dotAll flag (. matches newlines).
 * Must be the last attribute in the meta string.
 * Use double quotes when the value contains single quotes, or vice versa.
 */
export function twoslashErrorTransform() {
  return {
    name: "twoslash-error-transform",
    hooks: {
      postprocessAnnotations({ codeBlock }) {
        const meta = codeBlock.meta;
        const match =
          meta.match(/errorReplace="(.*)"\s*$/) ||
          meta.match(/errorReplace='(.*)'\s*$/);
        if (!match) return;

        const raw = match[1];
        const sepIndex = raw.indexOf("::");
        if (sepIndex === -1) return;

        const pattern = new RegExp(raw.slice(0, sepIndex), "s");
        const replacement = raw.slice(sepIndex + 2);

        for (const line of codeBlock.getLines()) {
          for (const annotation of line.getAnnotations()) {
            if (annotation.name === "twoslash-error-box") {
              annotation.error.text = annotation.error.text.replace(
                pattern,
                replacement,
              );
            }
          }
        }
      },
    },
  };
}
