# Codex source citations

> For maintainers. Using T3 Code? See [Source citations](../user/providers-codex.md#source-citations).

Codex can include source references in assistant Markdown using private-use Unicode delimiters.
These are provider-generated research citations, separate from T3's
[assistant quote citations](./assistant-citations.md) and Codex's `:codex-file-citation{...}`
file directives.

## Marker syntax

OpenAI's [citation formatting guide][format] defines these forms:

```text
citeturn0view0
citeturn0view0turn1search2
citeturn0view0L10-L20
```

The opening delimiter is `U+E200`, the closing delimiter is `U+E201`, and `U+E202` separates
the marker type, source references, and optional trailing line locator.
The locator can be one line such as `L10` or a range such as `L10-L20`. One marker can cite several
sources.

A reference such as `turn0view0` identifies a tool result in the provider's context. `turnN`
counts tool invocations, not T3 conversation turns; suffixes distinguish results. The reference
is not a URL or an app-server tool-call ID, and its spelling does not identify the source's
website. Line locators refer to the source's numbered content, not lines in the assistant reply.

## Source metadata and transport

The [Responses API web search guide][web-search] describes separate URL citation annotations
carrying source URLs, titles, and text offsets. The marker text alone does not carry those fields.

T3 uses [Codex app-server][app-server], whose [generated protocol schema][schema] exposes
`agentMessage.text` and optional `webSearch.results`. The results are opaque JSON for standalone
web search; their presence does not guarantee a reference-ID-to-URL mapping. `memoryCitation`
is separate metadata, not web citation annotations. Raw response `output_text` in the pinned
schema contains only `type` and `text`.

The report that prompted this renderer had a source marker in the saved assistant text, no
annotations, and `results: null` on the completed web search. The tool action contained a page
URL but no association between that URL and the marker's source ID. Reading the full stored
payload did not recover that association.

The [Codex adapter][adapter] retains full tool payloads, and [runtime ingestion][ingestion]
persists them on completion. [Activity payload projection][projection] removes unneeded tool
fields before sending activities to clients, including web search result data. Neither that
projection nor a database migration can recover metadata the provider never supplied.

Do not derive citation URLs from search order, nearby Markdown links, or a similar-looking tool
ID. Add source navigation only when the provider supplies an explicit mapping. Normalize that
metadata at the adapter boundary rather than shipping entire search outputs to every client.

## Rendering and copy

[`codexCitations.ts`][parser], exported as `@t3tools/client-runtime/codex-citations`, owns
parsing, source numbering, and the readable Markdown fallback. `remarkCodexCitations` transforms
valid citation markers into annotated Markdown nodes. `codexCitationFromHastProperties` reads
their citation payload for the web renderer. Source numbers follow first appearance within the
rendered document, and repeated source IDs keep their number.

GFM parsing and [list indentation recovery][list-recovery] run before citation rendering on both
paths. Recovered nodes retain their original source positions, so copying can replace just the
marker and streaming can recognize the actual end of the message. On web, citations render
before `remarkBreaks` and other transforms that can replace text nodes.

[`ChatMarkdown`][markdown] renders these nodes as [`CodexCitationChip`][chip] controls on web and
desktop. A chip shows the source numbers; its popover lists the original source IDs and any line
locator. It explains that the source URL is unavailable instead of offering an invented link.
`codexCitationMarkdown` supplies readable text for selection copy through `data-markdown-copy`.
Rich-text copy uses `codexCitationText` through `data-markdown-copy-text` before removing UI
controls, so the pasted reference retains its source IDs and locator.

`renderCodexCitationsAsMarkdown` uses the same parser for [whole-message copy][copy] and
[mobile assistant responses][mobile]. For example, a single source displays as
`[Source 1: turn0view0]`; grouped citations retain every source ID and any line locator.
The generated Markdown escapes the brackets so these references do not become links. Mobile
applies the conversion before splitting artifacts and passes the result to its native Markdown
renderers. Mobile rendering and whole-message copy leave user messages unchanged.

Only prose markers are transformed. Code examples, link and image labels or destinations, and
HTML code or anchor content stay literal. Unknown citation families and malformed complete
markers also stay literal. With `isStreaming`, an unfinished recognized citation at the end of
the document is hidden while its remaining text arrives. Once streaming ends, an incomplete
marker remains visible rather than disappearing from the answer.

This is a rendering change. Stored message text retains the original markers, and citations do
not create new server requests, database records, or provider configuration.

[format]: https://developers.openai.com/api/docs/guides/citation-formatting
[web-search]: https://developers.openai.com/api/docs/guides/tools-web-search
[app-server]: https://developers.openai.com/codex/app-server
[schema]: ../../packages/effect-codex-app-server/src/_generated/schema.gen.ts
[adapter]: ../../apps/server/src/provider/Layers/CodexAdapter.ts
[ingestion]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[projection]: ../../apps/server/src/orchestration/ActivityPayloadProjection.ts
[parser]: ../../packages/client-runtime/src/codexCitations.ts
[list-recovery]: ../../packages/client-runtime/src/markdownListIndentation.ts
[markdown]: ../../apps/web/src/components/ChatMarkdown.tsx
[chip]: ../../apps/web/src/components/chat/CodexCitationChip.tsx
[copy]: ../../apps/web/src/components/chat/MessagesTimeline.logic.ts
[mobile]: ../../apps/mobile/src/features/threads/ThreadFeed.tsx
