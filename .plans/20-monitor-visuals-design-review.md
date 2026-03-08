# Design Review: Port Visual Patterns from `~/wf/monitor`

## Summary

T3 Code’s current UI is strong for chat, diffs, and thread lists, but it is still relatively weak at rendering structured logs and JSON-rich state. `~/wf/monitor` already contains useful patterns that are a better fit for recap, diagnostics, and attention surfaces than plain markdown or raw `<pre>` blocks.

Most useful source inspirations:

- `~/wf/monitor/ui/src/components/file-viewer/JsonSmartView.tsx`
- `~/wf/monitor/ui/src/core/logs/LogStreamView.tsx`
- `~/wf/monitor/ui/src/core/logs/components/LogEntryCard.tsx`
- `~/wf/monitor/ui/src/core/logs/JsonlViewer.tsx`
- `~/wf/monitor/ui/src/core/widgets/ChatWidgetBlock.tsx`

## What Looks Worth Reusing

### `JsonSmartView`

Best idea: render structured payloads as cards, grids, badges, progress bars, and collapsible sections rather than always as monospaced JSON.

Why it fits T3 Code:

- provider runtime payloads are often structured
- recap evidence packets will be structured
- attention items, canon, and open loops want semantic display rather than raw JSON

### `LogStreamView`

Best idea: treat logs as a navigable stream with compact cards, level coloring, and source-aware scanning, rather than raw terminal scroll only.

Why it fits T3 Code:

- orchestration activities already resemble a timeline log
- provider runtime diagnostics need more visual hierarchy
- recap drill-down wants rich “why did this happen?” views

### `ChatWidgetBlock`

Best idea: allow certain structured payloads to become inline visual blocks.

Why it fits T3 Code:

- recap cards inside chat become feasible
- open loop tables and KPI summaries become glanceable
- model-generated review artifacts can stay structured

## Recommended Adoption Strategy

### 1. Port semantics, not styles verbatim

T3 Code already has its own component primitives and visual language. Port the rendering ideas and interaction model, but adapt them to the existing `apps/web/src/components/ui/*` system.

### 2. Start with three new renderers

- `StructuredValueView` for JSON-like payloads
- `EventLogPanel` for provider/orchestration activity streams
- `WidgetBlockView` for safe, typed mini-widgets

When porting these patterns, preserve monitor’s lazy-loading approach for diff/markdown/JSON-heavy surfaces. That is one of the cleaner aspects of the source design and helps keep the default T3 Code path light.

### 3. Use progressive disclosure

Good defaults:

- compact summary first
- expand for details
- keep raw JSON available as fallback

That fits recap and debug workflows better than forcing a single visual mode.

## Proposed Landing Areas in T3 Code

### Chat and work log

- `apps/web/src/components/ChatView.tsx`
- new helper components under `apps/web/src/components/structured/`

### Diff / inspector side panels

- `apps/web/src/components/DiffPanel.tsx`
- future project recap or inbox panels

### Project reentry surfaces

The planned reentry inbox is the ideal place to adopt richer cards for:

- project gist
- open loop tables
- health KPIs
- external signal summaries

## Suggested Components to Add

- `apps/web/src/components/structured/StructuredValueView.tsx`
- `apps/web/src/components/structured/JsonSmartView.tsx`
- `apps/web/src/components/structured/EventLogCard.tsx`
- `apps/web/src/components/structured/EventLogPanel.tsx`
- `apps/web/src/components/widgets/WidgetBlockView.tsx`

## Risks

- importing large monitor ideas directly could overcomplicate T3’s currently fast and compact UI
- raw JSON and markdown fallbacks must remain available for reliability and debugging
- log surfaces can become noisy if every activity gets equal visual weight

## Recommendation

Port the structured rendering concepts in small slices:

1. smart JSON rendering
2. compact event log cards
3. typed widget blocks

The fastest high-value port is `JsonSmartView` + the log stream/card stack + JSONL auto-upgrade behavior, not the full monitor shell.

That gives the planned recap and attention features a much better visual vocabulary without destabilizing the existing app.
