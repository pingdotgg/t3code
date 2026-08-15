# Provider Usage Page Integration Design

## Goal

Make provider quota remaining feel like part of the existing Usage experience instead of a separate sidebar popup. The Usage page will lead with live provider limits and retain the existing historical token and cost reporting underneath.

## Interaction

- The sidebar keeps the compact, settings-ordered `logo percentage` indicators.
- Clicking an indicator navigates to `/usage`, selects that provider instance, and focuses the live limits section.
- Opening Usage normally selects the first enabled provider instance in Settings order.
- A settings-ordered selector row at the top of Usage shows each enabled provider logo, headline percentage remaining, and a thin progress bar.
- Selecting a provider updates the detailed limits shown directly below the selector row without opening an overlay.
- The selected provider detail includes all normalized limit bars, reset times, credits, status/error messaging, and eligible Codex banked-reset controls.
- The existing historical cost, token, chart, and breakdown content remains below the live limits section.

## Visual Design

The limits section follows the existing Usage page's restrained dashboard language: neutral surfaces, border-based grouping, compact typography, tabular numbers, and provider brand marks. It avoids a second modal/card system.

The selector row uses one consistent footprint per provider: logo and percentage on the first line, then a thin bar. Selection is conveyed with foreground contrast and a single border/accent treatment rather than glow or continuous animation. Detailed metrics use stacked horizontal bars with aligned labels, remaining percentages, and reset timestamps. Loading uses static shape-matched skeletons; unavailable and stale states remain inline and readable.

On narrow screens the selector row scrolls horizontally and detail content becomes a single column. Controls retain keyboard focus styling, semantic buttons, accessible names, and an always-mounted polite live region for reset feedback.

## Component Boundaries

- `ProviderUsageStrip` becomes navigation-only. It owns no popover, sheet, reset state, or detail rendering.
- Shared provider quota projection stays in `ProviderUsageStrip.logic.ts` so the sidebar and Usage page use identical ordering and percentages.
- A Usage-page quota section owns provider selection, detailed rendering, reset confirmation, and reset attempt state.
- Reusable quota presentation primitives move out of the sidebar-specific location into the Usage feature directory (or a neutral shared location if imports require it).
- The `/usage` route accepts an optional bounded provider-instance search value. Invalid or unavailable selections fall back to the first visible instance.
- Selection is URL-backed so sidebar navigation, refresh, back/forward navigation, and shareable URLs behave consistently.

## Data Flow

Both surfaces read the primary environment configuration and `usePrimaryProviderQuota`. Visible rows are derived from the enabled provider settings in their configured order and joined with the live quota summary.

The sidebar passes the clicked instance identifier through typed route search. The Usage page validates that identifier against the current visible items, derives a selected item, and updates the URL when a selector is clicked. Quota refresh remains event-driven plus the existing bounded live-refresh cadence. Reset consumption uses the existing authenticated quota command and refreshes the snapshot after every outcome.

## States and Errors

- No configured quota-capable providers: omit the live limits section and leave historical Usage unchanged.
- Loading without a snapshot: render stable selector/detail skeleton shapes.
- Unsupported, signed-out, stale, or failed provider reads: show the normalized status and last successful read information inline.
- Provider removed or disabled while selected: replace the URL selection with the first remaining visible provider.
- Reset pending: disable reset choices and confirmation dismissal that could duplicate the request.
- Reset success/failure: retain existing toast feedback and expose the same message through the section's live region.

## Verification

- Logic tests cover settings order, URL selection fallback, and provider switching.
- Render tests cover the top-of-page limits placement, logo/percentage selectors, selected detail, loading/unavailable states, and absence of popup/sheet markup from the sidebar.
- Interaction tests cover sidebar deep-link navigation, Usage selector URL updates, reset confirmation, and narrow-screen overflow behavior where practical.
- Focused web tests, web and client-runtime typechecks, targeted lint/format, and diff checks must pass.
- One integrated T3 web-app verification should confirm the desktop and narrow responsive flows before merge, subject to the repository's browser-use permission rule.
