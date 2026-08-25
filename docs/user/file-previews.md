# File previews

Markdown files can switch between source and rendered views on web and desktop. Mobile opens
Markdown files in the rendered view.

## YAML frontmatter

Rendered Markdown recognizes YAML frontmatter when the file starts with a `---` line, ends the
frontmatter with another `---` line, and contains a YAML mapping. T3 Code displays the mapping as a
metadata table above the Markdown body.

Scalar values appear as text. Arrays containing only scalar values appear as pills. Nested objects
and arrays remain formatted as YAML.

Invalid YAML, an unclosed frontmatter block, or a frontmatter value that is not a mapping remains in
the Markdown body unchanged.
