# Native Markdown rendering

Chat responses and Markdown file previews share `T3Markdown`, built on Multiplatform Markdown Renderer 0.43.0 and Material 3 Compose. The previous Markwon `TextView` bridge has been removed.

The renderer owns T3 typography, spacing, colors, tables, task lists, blockquotes, links, and code blocks. Code blocks remain horizontally scrollable and expose a copy action. Text remains selectable. Syntax highlighting and remote Markdown images are intentionally not enabled.

Active assistant output uses the library's append-only streaming parser. If a provider rewrites already-received text, rendering falls back to the retained asynchronous parser. Completed messages and file previews use retained asynchronous state so updates do not replace rendered content with a loading frame. Renderer-owned size animation is disabled to avoid moving chat content while scrolling.

The dependency requires the Android build baseline used here: compile SDK 37, Kotlin 2.4.0, Compose BOM 2026.06.01, AGP 9.2.1, and Gradle 9.4.1. The runtime target remains SDK 35. AGP's built-in Kotlin and new DSL are temporarily disabled because this build consumes Kotlin 2.4 metadata through the external Kotlin plugin and compiles shared terminal/review sources; remove those compatibility flags when that toolchain is migrated together.

Manual acceptance should cover a long completed response, a live streaming response, rewritten output fallback, headings and nested lists, blockquotes, inline and fenced code, code copy, links, tables, task lists, selection, and Markdown file scrolling.
