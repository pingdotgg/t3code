# Design Review: Add Widgets in Chat

## Summary

T3 Code should support safe, typed widgets embedded in chat and work-log surfaces. This would let recap and attention features render compact, glanceable UI blocks instead of long markdown lists.

Good widget targets:

- KPI card
- status card
- open-loop table
- simple chart
- structured JSON summary
- “next actions” list

## Why Widgets Matter Here

The recap system wants layered information density:

- 10-second skim
- 1-minute recap
- deep drill-down

Widgets are a good fit for the top two layers because they are scan-friendly and can link into existing thread, diff, and file views.

## Recommended Protocol

Keep widgets explicit and typed.

### Do

- define a schema-backed widget protocol
- validate widgets before rendering
- support a small set of widget types first
- fall back to plain markdown or code blocks if validation fails

### Do not

- allow arbitrary HTML
- let provider text implicitly become UI without validation
- tie widget rendering to one provider only

## Proposed Widget Types

### Initial set

- `kpi`
- `table`
- `status-list`
- `chart` (simple bar or line)
- `structured-json`

### Optional later

- timeline widget
- branch / PR summary widget
- recap card widget
- approval queue widget

## Transport Options

### Option A — explicit widget payloads in canonical events

Best long-term option.

Add a canonical event or message attachment shape for widgets so the UI does not need to scrape markdown for JSON.

This also fits T3 Code’s existing architecture better: durable widgets can become dedicated timeline rows or typed attachments instead of being hidden inside `ChatMarkdown`.

### Option B — markdown fenced JSON widget blocks

Good bootstrap option.

Example idea:

~~~text
```widget
{ ...schema validated payload... }
```
~~~

The web app parses, validates, and upgrades known blocks into widgets.

Even as a bootstrap path, this should be treated as transitional. The better long-term fit is a typed row or attachment model because `ChatView` already merges structured timeline kinds and because markdown parsing is not the natural home for rich widgets.

## Suggested Contract Additions

- `packages/contracts/src/widgets.ts`
- widget attachment or event schema additions in canonical protocol types

## Suggested Web Changes

- `apps/web/src/components/widgets/WidgetBlockView.tsx`
- `apps/web/src/components/widgets/KpiWidget.tsx`
- `apps/web/src/components/widgets/TableWidget.tsx`
- `apps/web/src/components/widgets/StatusListWidget.tsx`
- widget parsing and validation integrated into `ChatView.tsx`

Recommended UI placement order:

- compact widgets attached to assistant replies
- dedicated typed timeline rows for durable recap artifacts
- heavy diff/log/json exploration in side panels or drawers rather than inline transcript expansion

## Suggested Server Changes

For the reentry engine:

- let recap generation output typed widgets as a secondary view over recap data
- let `AttentionInbox` cards reuse the same rendering primitives
- keep raw structured state persisted separately from widget presentation

## Provider Strategy

Widgets should be provider-agnostic.

- Codex can generate them first
- Gemini API can generate them as an alternative writer
- Claude Code can generate them once provider support exists

The server should normalize and validate widget payloads before the UI renders them.

## Risks

- widget sprawl if too many widget types land at once
- degraded readability if widgets interrupt normal conversation flow too often
- brittle parsing if markdown scraping is used for too long

## Recommendation

Start with a tiny widget protocol and render only high-signal structured artifacts:

- recap cards
- open-loop tables
- simple KPI / status widgets

Make widgets an enhancement layer over canonical stored recap data, not the source of truth.
