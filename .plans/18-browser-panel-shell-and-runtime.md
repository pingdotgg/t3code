# Plan: Rebuild Browser Panel Shell and Electron Runtime

## Summary

Recreate the in-app browser feature in two layers:

1. A reusable browser shell in the web app that lives in the existing right-side panel.
2. A desktop-only Electron runtime that renders real browser content behind that shell using `WebContentsView`.

This plan is intentionally reconstruction-oriented. A fresh session should be able to follow it and rebuild the same behavior, UI, ownership boundaries, and tradeoffs that exist in the current implementation.

## Goals

- Add a polished browser panel UI that shares the right panel with the diff viewer.
- Keep browser tabs and right-panel visibility scoped per thread and persisted.
- Support keyboard shortcuts for browser toggle/new tab/close tab.
- Render real browser content in Electron behind the shell.
- Keep the renderer as the owner of browser UI state.
- Keep Electron as the owner of live browser runtime state.
- Bound native resource usage with an LRU warm-tab budget.

## Non-Goals

- No browser runtime for plain web builds.
- No persistent page session restoration beyond shell metadata.
- No in-toolbar DevTools button.
- No attempt to preserve JS/history state for evicted tabs.

## Final User Experience

### Right Panel

- The right panel can show either:
  - diff
  - browser
- Only one can be shown at a time.
- Diff and browser are toggled from a joined segmented control in the chat header.
- The selected right panel is remembered per thread.
- Closing and reopening the panel restores the thread's last selected panel.

### Browser Shell

- The browser panel has three vertical sections:
  - top tab strip
  - compact navigation row
  - viewport area
- Tabs are horizontally scrollable and visually styled like a desktop in-app browser.
- The `+` button creates new tabs and remains visible when the strip overflows.
- The URL field is controlled and supports bare host input like `localhost:3000`.
- Invalid input shows a bottom error banner instead of corrupting tab state.
- Empty tabs show a centered empty state message.

### Desktop Runtime

- Real web content is rendered only in Electron.
- Only one native browser view is attached to the window at a time:
  - active thread
  - active browser tab
  - browser panel visible
- Hidden tabs are not all kept live forever.
- A small global warm-tab cache keeps recently used tabs alive.
- Older hidden tabs are evicted and later restored by reloading their URL.

## Architecture

## Renderer Ownership

The web app owns:

- per-thread browser tabs
- active tab id
- URL input value
- focus request id
- right-panel selected state
- last selected right-panel state
- browser shell rendering
- browser tab metadata projected from native runtime:
  - title
  - favicon
  - loading state
  - history affordances
  - last error

## Electron Ownership

The desktop app owns:

- native browser instances (`WebContentsView`)
- real navigation/runtime state
- browser tab lifecycle for live native views
- viewport attachment and bounds
- LRU live-tab eviction
- forwarding tab runtime updates back to the renderer

## Shared Boundary

`packages/contracts/src/ipc.ts` defines the browser IPC contract used by:

- Electron preload bridge
- Electron main process handlers
- web `NativeApi`

The browser IPC surface needs:

- `ensureTab`
- `navigate`
- `goBack`
- `goForward`
- `reload`
- `closeTab`
- `syncHost`
- `clearThread`
- `onEvent`

The main browser event shape is a tab-state event carrying:

- `threadId`
- `tabId`
- `url`
- `title`
- `faviconUrl`
- `isLoading`
- `canGoBack`
- `canGoForward`
- `lastError`

## Phase 1: Shared Browser Shell Utilities

Add `apps/web/src/browser.ts`.

It should export:

- `BrowserTab` type
- helper to create a new blank tab
- helper to normalize `about:blank` for the address bar
- helper to derive a tab label
- helper to parse submitted URLs into a success/error result

Required parsing behavior:

- blank input becomes `about:blank`
- exact `about:blank` stays unchanged
- already-schemed URLs are parsed as-is
- bare hosts like `localhost:3000`, `127.0.0.1:3000`, and `example.com` get `http://`
- malformed input returns `{ ok: false, error: "Enter a valid URL." }`

This module exists to prevent route-local duplication and to keep parsing/label logic reusable.

## Phase 2: Reusable Browser Panel Component

Add `apps/web/src/components/BrowserPanel.tsx`.

The component is presentation-focused and reusable. It accepts:

- browser tab state
- active tab
- controlled input value
- focus request id
- tab callbacks
- browser action callbacks
- optional viewport ref
- optional shortcut labels for new/close tab

### Layout

- full-height vertical panel
- `52px` tab row
- `44px` nav row
- remaining height is viewport

### Tab Strip Behavior

- horizontally scrollable
- hidden scrollbar
- overflow tracked with `ResizeObserver`
- `useLayoutEffect` scrolls the active tab fully into view when selection changes or tabs are created
- tabs use:
  - loading icon when loading
  - favicon when available
  - globe fallback otherwise
- close button and new-tab button have shortcut-aware tooltips
- active tab uses stronger foreground, filled surface, and visual connection to the row edge
- inactive tabs remain transparent
- inactive hover should not add a background fill
- divider slots between non-selected neighboring tabs must preserve layout and only toggle opacity

### Final Tab Styling Details

- remove real bottom border from the row container
- render a positioned bottom divider behind the tabs instead
- active tab should visually sit on top of that divider
- use `-mb-px` and a 1px downward translation so the active tab merges into the panel edge
- tab padding is `pl-3 pr-2`
- new-tab button is compact, square-ish, rounded, and slightly lifted
- sticky overflow new-tab container should not use a gradient background

### Nav Row

- buttons:
  - back
  - forward
  - reload
  - URL input
  - open externally
- no DevTools toolbar button
- URL input should be compact and fully controlled
- when `focusRequestId` changes, focus and select all text

### Viewport

- include an `absolute inset-0` host div via `viewportRef`
- empty state shown for no active tab or `about:blank`
- bottom floating error banner when `lastError` exists

### Electron Drag Regions

Because the desktop app uses a hidden inset titlebar:

- the top strip can remain inside a drag region
- interactive controls must be marked `no-drag`
- tabs and the `+` button must stay clickable in compact sidebar layouts

## Phase 3: Per-Thread Browser Store

Add `apps/web/src/browserStateStore.ts`.

Use Zustand `persist(createJSONStorage(() => localStorage))`.

State shape per thread:

- `activeTabId`
- `tabs`
- `inputValue`
- `focusRequestId`

Key requirements:

- browser state is keyed by `threadId`
- switching threads restores that thread's browser tabs and input state
- reloads restore browser state
- orphaned thread entries can be removed centrally

### Equality Requirement

No-op updates must preserve identity.

Do not always recreate the `tabs` array during normalization. If a caller updates a thread state with the same object, the store should not produce new references or unnecessary persisted writes.

Add a focused regression test for this behavior.

## Phase 4: Per-Thread Right Panel Store

Add `apps/web/src/rightPanelStateStore.ts`.

Also use persisted Zustand state keyed by `threadId`.

State per thread:

- `selectedPanel: "diff" | "browser" | null`
- `lastSelectedPanel: "diff" | "browser"`

Behavior:

- right-panel visibility is thread-owned
- browser visibility is restored when switching back to a thread
- diff visibility is also restored per thread
- reopening the panel from closed state restores the thread's last selected panel

Diff deep-link payload should remain URL-based. Normal panel visibility should not.

## Phase 5: Integrate Browser Shell Into Chat Route

Update `apps/web/src/routes/_chat.$threadId.tsx`.

The route should:

- use the persisted browser store instead of local browser state
- use the persisted right-panel store instead of relying on URL state for normal open/close
- render `BrowserPanel` in the same right-side panel container used by diff
- ensure only one of diff or browser is visible

### Diff Search Rules

Keep diff search params for explicit deep links:

- `diff`
- `diffTurnId`
- `diffFilePath`

If diff deep-link params are present:

- force diff open
- sync `"diff"` into the right-panel store

When switching away from diff or closing the panel:

- strip diff params from the URL

### Browser Shell Route Logic

The route should support:

- lazily creating the first blank tab when the browser panel opens
- creating tabs
- activating tabs
- closing tabs
- syncing the controlled URL input to the active tab
- parsing submitted URLs through the shared helper
- updating `lastError` on invalid input
- opening the current URL externally via native shell

For shell-only mode before native runtime exists:

- `back`
- `forward`
- `reload`

can remain no-ops.

## Phase 6: Header Toggle Group and Keyboard Shortcuts

Update `apps/web/src/components/ChatView.tsx`.

### Header Toggle Group

Add a globe toggle next to diff, but render both as a joined segmented control, not two visually separate buttons.

Behavior:

- only one of diff/browser can be active
- clicking the inactive segment switches panels
- clicking the active segment closes the panel
- shortcut-aware tooltip on both controls

### Keyboard Commands

Add commands across contracts, server defaults, and frontend keybinding resolution:

- `browser.toggle`
- `browser.newTab`
- `browser.closeTab`

Default bindings:

- `mod+b` => browser toggle
- `mod+t` => new tab
- `mod+w` => close active browser tab

Existing `mod+d` still toggles diff.

`mod+t` should open the browser panel if it is currently hidden.

## Phase 7: Browser IPC Contract and Bridges

Update `packages/contracts/src/ipc.ts`, `apps/desktop/src/preload.ts`, `apps/desktop/src/main.ts`, and `apps/web/src/wsNativeApi.ts`.

### Contract

Add browser-specific IPC input and event types.

### Preload

Expose browser methods from Electron preload.

### Web Native API

Expose the browser API through the existing `NativeApi`.

Plain web builds should remain safe no-ops.

## Phase 8: Electron Browser Runtime

Add `apps/desktop/src/browserManager.ts`.

This module is the core runtime for native browser content.

### Record Model

Keep one record per `threadId + tabId`.

Each record stores:

- thread id
- tab id
- current runtime state
- optional live `WebContentsView`
- last-access timestamp

### Core Behavior

- `ensureTab` creates missing records only
- existing records must not be overwritten from stale renderer state
- `navigate` updates the live runtime and loads the requested URL
- `goBack`, `goForward`, `reload`, `closeTab`, `clearThread` operate on the matching record(s)

### Event Wiring

Each live `WebContentsView` should listen for navigation/runtime changes and emit browser tab-state events back to the renderer.

Key projected fields:

- URL
- title
- favicon
- loading
- history affordances
- last error

### Host Attachment

The manager should attach exactly one native view to the BrowserWindow at a time:

- only when browser panel is selected
- only for the active thread
- only for the active tab
- only when viewport bounds are known

Everything else stays detached.

## Phase 9: Viewport Host Sync

Use the `viewportRef` already present in the browser panel.

From the chat route:

- measure the viewport host with `getBoundingClientRect()`
- send bounds to `api.browser.syncHost(...)`
- send `visible: false` or `bounds: null` when browser should be hidden

### Important Animation Behavior

When the right panel opens with an animation, bounds are not stable immediately.

Use a short `requestAnimationFrame` sync burst after the browser panel becomes visible so the native view tracks the animated position until it stabilizes.

### Immediate Activation Sync

When the user activates a tab:

- immediately update the controlled address bar value
- immediately sync the host to the selected tab

Do not wait only for follow-up effects, or the shell will visibly lag behind the tab selection.

## Phase 10: Hide Native Browser Under Blocking Dialogs

The native `WebContentsView` can visually sit above DOM overlays, so z-index is not sufficient.

When blocking dialogs are visible:

- temporarily hide the browser host
- restore it when dialogs close

Use actual visible dialog detection instead of counting mounted dialog components, because some dialogs stay mounted while closed.

The implemented approach should:

- inspect dialog visibility markers in the DOM
- watch dialog open/close changes with a `MutationObserver`
- resync the native host whenever dialog visibility changes

Do not globally count sheets, because the browser panel itself can be hosted inside a sheet on compact layouts.

## Phase 11: Warm-Tab LRU Resource Budget

Do not keep every tab across every thread as a live `WebContentsView`.

Introduce a global warm-tab budget in `browserManager.ts`.

The implementation target is:

- keep at most 3 live native tabs globally
- always keep the active tab live
- allow recently used hidden tabs to remain warm
- evict the least recently used hidden live tab when over budget

### Eviction Behavior

When a tab is evicted:

- destroy its live `WebContentsView`
- keep lightweight metadata
- reset `canGoBack` and `canGoForward` to `false`

This is an intentional tradeoff:

- memory stays bounded
- hidden tabs do not keep unlimited Chromium resources alive
- evicted tabs lose in-page JS/history state
- revisiting a cold tab recreates the native view and reloads the URL

## Phase 12: Cold-Tab Restore Correctness

Be careful when reviving an evicted tab.

Do not emit blank runtime state from a freshly created empty view before reloading the saved URL. That can overwrite the renderer's tab back to `about:blank`.

Correct restore behavior:

- recreate the live view
- keep stored metadata until real navigation events arrive
- load the stored URL
- let post-load runtime events update the projected state

## Phase 13: Redirect and Address-Bar Correctness

Avoid renderer/native URL ownership fights.

Specifically:

- `ensureTab` should not keep pushing renderer tab URLs into an already existing native tab
- explicit navigation should be the only path that changes runtime URL from renderer intent

This prevents `http -> https` redirect loops where the address bar oscillates between the stale submitted URL and the real runtime URL.

## Phase 14: Root Route Event Subscription and Cleanup

Update `apps/web/src/routes/__root.tsx`.

Responsibilities:

- subscribe once to browser native events
- merge incoming tab-state events into the per-thread browser store
- clear orphaned native browser threads when thread state is cleaned up
- clear orphaned persisted browser state
- clear orphaned persisted right-panel state

Renderer store remains the source of truth for tab existence and ordering. Native events should update matching tabs, not invent new renderer tabs.

## Phase 15: CSS

Update `apps/web/src/index.css`.

Add browser tab-strip scrollbar hiding rules.

The final implementation hides the horizontal scrollbar entirely rather than using a thin visible scrollbar.

## Files To Add

- `apps/web/src/browser.ts`
- `apps/web/src/browserStateStore.ts`
- `apps/web/src/browserStateStore.test.ts`
- `apps/web/src/components/BrowserPanel.tsx`
- `apps/web/src/rightPanelStateStore.ts`
- `apps/desktop/src/browserManager.ts`

## Files To Modify

- `apps/server/src/keybindings.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/diffRouteSearch.ts`
- `apps/web/src/index.css`
- `apps/web/src/keybindings.ts`
- `apps/web/src/keybindings.test.ts`
- `apps/web/src/routes/__root.tsx`
- `apps/web/src/routes/_chat.$threadId.tsx`
- `apps/web/src/wsNativeApi.ts`
- `apps/desktop/src/main.ts`
- `apps/desktop/src/preload.ts`
- `packages/contracts/src/ipc.ts`
- `packages/contracts/src/keybindings.ts`
- `packages/contracts/src/keybindings.test.ts`

## Testing and Validation

Required checks:

- `bun fmt`
- `bun lint`
- `bun typecheck`

Recommended targeted tests:

- browser store no-op identity regression
- keybinding contract/default coverage for browser commands
- web native API browser bridge tests

Recommended manual desktop smoke checks:

- browser panel open/close
- diff/browser toggle switching
- `cmd+d`, `cmd+b`, `cmd+t`, `cmd+w`
- opening more than 3 tabs and returning to older tabs
- `http -> https` redirect behavior
- thread switching with browser tabs in multiple threads
- blocking dialog open/close over visible browser content
- right-panel open animation while browser content is visible
- external-open action

## Done Criteria

- Browser shell exists and matches the tuned desktop-style UI.
- Diff and browser share the same right-side panel and behave as a joined toggle group.
- Browser tab state is persisted per thread.
- Right-panel visibility is persisted per thread.
- Diff deep links still work through URL params.
- Electron renders real browser content behind the shell.
- Only one native browser host is attached at a time.
- Native browser resource usage is bounded by a global warm-tab budget.
- Cold-tab restore works correctly.
- Redirected URLs do not fight the address bar.
- Dialogs correctly hide native browser content.
- `bun fmt`, `bun lint`, and `bun typecheck` pass.
