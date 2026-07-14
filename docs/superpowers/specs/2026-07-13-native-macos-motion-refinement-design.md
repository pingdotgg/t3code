# Native macOS Motion Refinement Design

## Context

SurgeCode's native macOS app already centralizes most SwiftUI animation in
`Theme/Motion.swift`, but the current vocabulary is too broad. Long structural
animations are applied to frequent actions such as typing, thread selection,
and collection updates. Several ongoing symbol and scale effects also create
more activity than the product's calm alpine voice warrants.

This design refines the complete native motion system. Daily interactions must
feel immediate, crisp, and smooth. Personality is reserved for rare moments
such as a first successful connection or a successful task completion.

## Goals

- Make frequent actions feel immediate and responsive.
- Give occasional structural changes clear, compact spatial continuity.
- Reserve restrained delight for rare, meaningful state changes.
- Keep motion cohesive across the native app through shared semantic tokens.
- Honor macOS Reduce Motion for every movement and decorative symbol effect.
- Avoid animation-driven layout churn in typing, streaming, scrolling, and
  frequently updated collections.

## Non-goals

- Redesigning layouts, colors, typography, or the Liquid Glass treatment.
- Adding celebratory motion to routine message completion.
- Changing provider, session, networking, or persistence behavior.
- Modifying the web or mobile apps.
- Building a generic animation framework outside the needs of the macOS app.

## Motion Architecture

`Motion.swift` remains the single source of truth, but its vocabulary becomes
purpose-specific instead of relying on the broad `snap`, `settle`, `enter`, and
`ambient` categories everywhere.

The semantic categories are:

- **Immediate feedback:** 100-160 ms for direct pointer feedback, button state,
  and small icon changes. Keyboard-initiated actions do not animate.
- **Short reveal:** 150-220 ms ease-out for suggestions, compact banners,
  errors, chips, and newly appended timeline blocks.
- **Structural change:** 200-260 ms, with no overshoot, for disclosures, pane
  mode changes, and occasional size changes.
- **Ambient state:** restrained color and opacity interpolation for asynchronous
  status changes. Ambient motion must not run perpetually unless it communicates
  genuinely active work and remains visually quiet.
- **Rare delight:** a restrained one-shot spring, no longer than 420 ms,
  for first successful connection and successful task or subagent completion.

Movement-bearing tokens provide reduced-motion alternatives. Reduced Motion
keeps brief opacity or color transitions while removing offset, scale, bounce,
rotation, and pulse effects.

Animation is attached to the smallest view that owns the changing state.
Whole-screen, whole-composer, and whole-collection animation domains are
removed where they cause unrelated siblings or layout to animate.

## Component Behavior

### Composer

- Draft typing and keyboard submission are immediate.
- Editor height follows content without a broad animation on every keystroke.
- Suggestion lists scale and fade from the composer-side anchor with a short,
  interruptible reveal.
- Attachments, queued messages, and errors use compact asymmetric transitions.
- Send/stop changes use a crisp symbol replacement and subtle pointer press
  response. The transition never delays sending or cancellation.
- Dictation may retain an active-state cue, but it must stop immediately and
  honor Reduce Motion.

### Sidebar and navigation

- Thread selection and keyboard navigation are immediate.
- Inserting or removing a session row may use a 160-200 ms transition scoped to
  that row. Reordering or refreshing the complete list does not animate.
- Selection, connection, and thread status changes favor color and opacity over
  positional movement.
- Background work indicators acknowledge a state change once, then remain calm;
  multiple rows must not produce competing perpetual scale pulses.

### Chat timeline and scrolling

- Restored or initially hydrated history renders without entrance animation.
- A newly appended, user-visible block may rise by a few points while fading in.
- Streaming token deltas and in-place tool updates remain unanimated.
- Pinned-to-bottom scrolling stays short, interruptible, and disabled for thread
  switches or initial positioning.

### Panels, sheets, and disclosures

- Review mode, plan details, tool details, VCS details, and settings sections use
  compact structural motion with faster exits than entrances.
- Popover-like content uses an origin matching its trigger or container edge.
- Native sheets and popovers retain system presentation motion; custom content
  does not layer a redundant full-pane animation on top.

### Status and progress

- Connection, agent, and background-work indicators avoid loud perpetual scale
  pulses. Prefer a quiet opacity halo, a one-shot acknowledgement, or a static
  active treatment.
- Numeric changes may keep `numericText` transitions when they aid comprehension.
- Routine task states use crisp symbol replacement. A successful terminal task
  state may receive one restrained completion accent.

### Rare delight

- The first transition to a successful connection during an app lifecycle may
  receive a single restrained acknowledgement.
- Successful task or subagent completion may receive a one-shot completion
  accent. Rehydrated completed tasks do not replay it.
- Empty-state arrival may retain a calm materialization because it is an
  occasional scene, but it must not replay during routine navigation.
- Rare motion remains consistent with the brand voice: concise, calm, alpine;
  no elastic overshoot, confetti, or repeated celebration.

## Accessibility

- Every movement, pulse, bounce, and SF Symbol effect checks the current macOS
  Reduce Motion preference.
- Reduced Motion preserves state comprehension through quick opacity and color
  changes rather than eliminating all feedback.
- Hover-only motion is triggered only by pointer hover and never becomes part of
  keyboard focus or touch-compatible behavior.
- Animation is decorative or explanatory only; no state or control availability
  depends on completion of an animation.

## Performance and Reliability

- Typing, streaming deltas, initial timeline hydration, thread selection, and
  complete collection refreshes do not animate layout.
- Transitions use opacity and SwiftUI transforms where practical. Necessary
  structural changes are narrowly scoped to their owning component.
- Ongoing effects are minimized to reduce compositor work when many sessions or
  agents are active.
- Rapidly changing state uses interruptible SwiftUI transitions or springs; an
  effect must retarget cleanly instead of replaying from an obsolete state.
- Motion never delays network state, cancellation, error display, navigation,
  or persistence updates.

## Verification

Automated verification:

- Add focused tests for motion policy expressed as pure values, particularly
  reduced-motion selection and replay eligibility for rare one-shot effects.
- Run `swift build --package-path apps/mac`.
- Run native tests with the Swift Testing plugin and required runtime rpaths
  documented in `apps/mac/CLAUDE.md`.
- Run repository-required `vp check` and `vp run typecheck`.
- Run `vp run lint:mobile` only if the implementation unexpectedly touches
  shared native-mobile code.

Manual verification:

- Launch the native app and inspect composer typing, suggestion appearance,
  send/stop, thread navigation, timeline append/streaming, disclosures, review
  mode, connection state, background work, and task completion.
- Repeat the pass with macOS Reduce Motion enabled.
- Rapidly reverse disclosures and state toggles to verify interruptibility.
- Treat typing lag, scroll instability, stale repeated effects, layout jumps, or
  motion that outlasts its state change as failures.

## Acceptance Criteria

- Typing, keyboard submission, and thread navigation have no transition latency.
- Routine UI motion completes in 260 ms or less.
- No broad animation is keyed to draft text, selected thread identity, or an
  entire frequently refreshed collection.
- Initial history and streaming token deltas do not animate.
- Decorative movement and symbol effects honor Reduce Motion.
- Perpetual scale pulses are removed from routine status indicators.
- Rare delight is one-shot, does not replay during hydration, and remains
  restrained.
- Native build/tests, `vp check`, and `vp run typecheck` pass.
