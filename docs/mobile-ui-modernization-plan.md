# Mobile UI Modernization Plan

## Context

The mobile UI on `L0vU3000/mobile-one-qr-onboarding` reads as "an older iteration" because it's a retrofit, not a redesign:

- **Untracked WIP components.** `MobileActionBar.tsx`, `MobileBottomNav.tsx`, `useMobileSidebarSwipe.ts` are all untracked — recent work landed unfinished.
- **`mobile={true}` prop pattern.** `ProjectScriptsControl` and `GitActionsControl` were patched with a `mobile` flag that swaps `outline` → `ghost` variants, giving the mobile bar a "stripped-down desktop" feel rather than a native design.
- **Feature gaps.** `OpenInPicker` and Terminal toggle are missing from the mobile action bar — only Diff + Git + Scripts are present.
- **Breakpoint inconsistency.** `useIsMobile()` is `max-md` (768px), but the bottom nav, connection status, and composer collapse all use `sm:hidden` / `max-sm` (640px). Tablets in 640–768px get a mismatched experience.
- **Three parallel action bars** (desktop `ChatHeader`, mobile `ChatHeader`, `MobileActionBar`) drift over time.

**Intended outcome:** Mobile feels as intentional and polished as desktop. The `mobile` boolean prop is replaced with a cleaner `surface` variant, untracked components are committed and tested, missing features are added, breakpoints are unified, and the visual treatment matches /impeccable principles — distinctive, production-grade, native-feeling (Mimo, Linear Mobile, Meta AI as references).

## Approach

Five sequential phases. Each phase is independently mergeable.

### Phase 1 — Unify breakpoints (foundational)

Adopt `max-md` (768px) everywhere mobile UI applies, matching `useIsMobile()`.

- `apps/web/src/components/chat/ChatComposer.tsx:805` — replace `useMediaQuery("max-sm")` with `useIsMobile()` (already exported from `apps/web/src/hooks/useMediaQuery.ts:85`).
- `apps/web/src/components/chat/ChatComposer.tsx:2254` — `max-sm:pb-11` → `max-md:pb-11`.
- `apps/web/src/components/mobile/MobileBottomNav.tsx:41` — `sm:hidden` → `md:hidden`.
- `apps/web/src/components/mobile/ConnectionStatusBanner.tsx:19` — `sm:hidden` → `md:hidden`.
- `apps/web/src/components/mobile/ConnectionStatusPill.tsx:11` — `sm:hidden` → `md:hidden`.
- `apps/web/src/index.css:418` — `@media (max-width: 639px)` → `@media (max-width: 767px)` so sidebar-inset bottom clearance matches nav visibility.

**Decision:** Tablets at 700px now get the mobile experience. Matches `useIsMobile()` intent.

### Phase 2 — Track WIP + wire real state

Get untracked components onto a stable footing before refactoring them.

- **Fix `terminalOpen` wiring.** `apps/web/src/components/AppSidebarLayout.tsx:29` hardcodes `terminalOpen={false}` on `MobileBottomNav`. Lift it into the same store/context that `ChatView` already uses, then subscribe from `MobileControls`. Remove the `t3:mobile-toggle-terminal` custom event in `ChatView.tsx:1809-1811` once state is bidirectional.
- **Swipe-ignore zones.** Extend `useMobileSidebarSwipe.ts` to bail when `touchstart.target.closest('[data-swipe-ignore="true"]')`. Add `data-swipe-ignore="true"` to: ChatComposer chip strips, `MobileActionBar` overflow row, terminal drawer body. Prevents nav from triggering during horizontal scrolls.
- **Update tests.** Existing `MobileBottomNav.test.tsx` + `useMobileSidebarSwipe.test.ts` already exist (untracked) — update assertions for `md:hidden` and add swipe-ignore regression.

### Phase 3 — Unify action bars, kill the `mobile` boolean

Replace `mobile={true}` with a more honest `surface` prop. Two surfaces: `"header"` (default, freestanding) and `"segmented"` (inside `MobileActionBar`'s bordered card).

- `apps/web/src/components/ProjectScriptsControl.tsx:97,109,223,226,229,236,239,295` — rename `mobile?: boolean` → `surface?: "header" | "segmented"`. The `ghost` vs `outline` variant + `flex-1 h-full` layout becomes a function of `surface === "segmented"`.
- `apps/web/src/components/GitActionsControl.tsx:90` — same rename.
- `apps/web/src/components/chat/OpenInPicker.tsx` — accept the same `surface?` prop. When `segmented`, render full-height ghost trigger with `rounded-none flex-1`.
- `apps/web/src/components/mobile/MobileActionBar.tsx` — add `OpenInPicker` cell (reuse exported `shouldShowOpenInPicker` from `ChatHeader.tsx:48`) and Terminal toggle cell. Pass `surface="segmented"` to all children. New props it needs to accept: `availableEditors`, `openInCwd`, `terminalAvailable`, `terminalOpen`, `terminalToggleShortcutLabel`, `onToggleTerminal`.
- `apps/web/src/components/chat/ChatHeader.tsx:203` — pass the new props through. Desktop branch (line 126) unchanged; `surface` default is `"header"`.

**Net:** Three action bar implementations collapse into one shared set of controls rendered in two contexts. Feature parity restored.

### Phase 4 — Polish pass (/impeccable principles)

Apply distinctive, production-grade treatment. Reference: Mimo composer chip-row, Linear Mobile typography, Meta AI minimal tab bar, Vibecode segmented toolbar.

**4a. Bottom nav** (`apps/web/src/components/mobile/MobileBottomNav.tsx`):
- Touch targets ≥44px (current ~38px). Increase content to `min-h-12`, keep safe-area-inset-bottom.
- Active tab pill: `rounded-full bg-accent/60` sized to icon+label, `transition-colors duration-150`.
- Icons `size-[22px]`, labels `text-[10px] tracking-wide uppercase`, inactive fades to `text-foreground/55`.
- Backdrop: `bg-background/80 backdrop-blur-xl backdrop-saturate-150` (currently `/95 backdrop-blur-sm`).
- Replace top border with 6px gradient overlay `bg-gradient-to-b from-transparent to-background` for soft lift.
- "Chat" tab also focuses `data-chat-composer-form` textarea (already used in `ChatComposer.tsx`, `ChatView.browser.tsx`, route file).

**4b. Header** (`apps/web/src/components/chat/ChatHeader.tsx`, mobile branch ~line 93):
- `sticky top-0 z-20 bg-background/80 backdrop-blur-xl pt-safe border-b border-border/40`.
- Title `text-base font-semibold tracking-tight text-foreground/95` (currently `text-[15px]`).

**4c. Action bar** (`apps/web/src/components/mobile/MobileActionBar.tsx`):
- Height `h-10` → `h-11` for touch compliance.
- Container `bg-card border-border/60 shadow-xs` (currently `bg-muted/20`) — reads as polished card, not tinted block.
- Icons `size-3.5` → `size-4`.
- Cell-staggered fade-in on mount (`@starting-style` CSS or `--cell-delay` CSS var per child, 40ms between). Gated behind `prefers-reduced-motion: no-preference`.

**4d. Composer collapsed state** (`apps/web/src/components/chat/ChatComposer.tsx` ~lines 1996–2169):
- In collapsed mobile mode, render a chip-row (model picker + attach + send) instead of bare textarea — Mimo-style. Reuses existing `ComposerFooterModeControls` and `ComposerFooterPrimaryActions`.
- Send button: 250ms `scale-[1.02]` pulse when `hasSendableContent` flips true. Define keyframe `send-ready` in `index.css`. Reduced-motion guarded.
- Insert-newline button at line 2394: `variant="ghost"` → `variant="outline" size="icon-xs"` for visual parity with desktop affordances. Touch target preserved via existing `pointer-coarse:after:min-h-11` in `buttonVariants`.

**4e. Terminal drawer** (`apps/web/src/components/ThreadTerminalDrawer.tsx:1117`):
- Add `pb-safe` to inner content area so terminal text isn't hidden under home indicator.
- Resize handle: hide on mobile (`md:hidden`). Drag-to-close gesture is a follow-up.

**4f. Tokens** (`apps/web/src/index.css`):
- Add `@utility h-mobile-nav { height: calc(3.5rem + env(safe-area-inset-bottom)); }` to single-source nav height. Update sidebar-inset clearance at line 420 to reuse it.

### Phase 5 — Cleanup + regression sweep

- Grep for remaining `mobile={` and `max-sm` in `apps/web/src` — replace any stragglers.
- Visual diff desktop: ChatHeader, ChatComposer, ProjectScriptsControl, GitActionsControl, OpenInPicker should be unchanged.
- Storybook-style preview page under existing untracked `apps/web/src/components/dev/` rendering MobileActionBar + MobileBottomNav at 375/600/768 for visual review.

## Critical Files

- `apps/web/src/components/chat/ChatHeader.tsx` (lines 48, 86, 93, 126, 203)
- `apps/web/src/components/chat/ChatComposer.tsx` (lines 114, 805, 2254, 2394, 1996–2169)
- `apps/web/src/components/mobile/MobileActionBar.tsx` (untracked — significant additions)
- `apps/web/src/components/mobile/MobileBottomNav.tsx` (untracked — polish)
- `apps/web/src/components/mobile/useMobileSidebarSwipe.ts` (untracked — add ignore zones)
- `apps/web/src/components/ProjectScriptsControl.tsx` (lines 97, 223–297)
- `apps/web/src/components/GitActionsControl.tsx` (line 90)
- `apps/web/src/components/chat/OpenInPicker.tsx` (add surface prop)
- `apps/web/src/components/AppSidebarLayout.tsx` (line 29 — terminalOpen wiring)
- `apps/web/src/components/ChatView.tsx` (lines 1809–1811 — remove custom event)
- `apps/web/src/components/ThreadTerminalDrawer.tsx` (line 1117)
- `apps/web/src/index.css` (lines 64–75, 418–422 + new `h-mobile-nav` utility)

## Reused utilities (no new abstractions)

- `useIsMobile` / `useMediaQuery` — `apps/web/src/hooks/useMediaQuery.ts:85`
- `shouldShowOpenInPicker` — exported from `ChatHeader.tsx:48`
- `pb-safe` / `pt-safe` / `pl-safe` / `pr-safe` — `index.css:64–75`
- `data-chat-composer-form` selector — already wired through 4 files
- `Toggle`, `Button` with `outline`/`ghost` variants — `apps/web/src/components/ui/`
- `@container/header-actions` container queries — already on parent containers

## Verification

**Per-phase checks:**
- Phase 1: At 700px viewport, bottom nav appears, composer collapsed when unfocused, no overlap of send button + nav.
- Phase 2: `bun run test apps/web/src/components/mobile`. Terminal tab in bottom nav shows active state when drawer open. Horizontal scroll inside composer chip strip doesn't trigger sidebar.
- Phase 3: Desktop ChatHeader visually unchanged. Mobile action bar shows OpenInPicker + Terminal toggle. Each control fires identical events from both surfaces.
- Phase 4: iPhone SE (375px), iPhone 14 Pro (393px), iPad mini (744px) in Chrome devtools — dark + light. Reduced-motion ON disables entrance staggers and send-pulse.
- Phase 5: Grep `mobile={` returns zero TSX matches. Visual diff of desktop screenshots = 0 pixel changes.

**End-to-end (browser):**
1. `bun run dev` → open at 375px wide.
2. Open a thread. Verify sticky blurred header.
3. Tap each bottom nav tab: Sessions (sidebar opens), Chat (composer focuses + scrolls into view), Terminal (drawer opens, tab shows active pill).
4. Swipe from left edge → sidebar opens. Swipe inside composer chip row → no nav trigger.
5. Tap OpenInPicker from mobile action bar → menu opens, editor launches.
6. Resize to 1200px → desktop UI returns; verify no visual regression.

**Tests to add/update:**
- `apps/web/src/components/mobile/MobileBottomNav.test.tsx` — update breakpoint assertions, add `terminalOpen` active-state test.
- `apps/web/src/components/mobile/useMobileSidebarSwipe.test.ts` — add `data-swipe-ignore` ancestor case.
- New: `apps/web/src/components/mobile/MobileActionBar.test.tsx` — render variants with/without scripts + project, assert OpenInPicker + Terminal toggle present.

## Risks

- **Breakpoint shift to `max-md`** changes UX for 640–768px tablets. Intended; flag in PR.
- **`surface` rename** must touch every `mobile={` call site — grep before merge.
- **`backdrop-blur-xl` performance** on lower-end Android — fall back to `backdrop-blur-md` if jank observed.
- **Removing the `t3:mobile-toggle-terminal` custom event** changes a contract — confirm no external listeners.
