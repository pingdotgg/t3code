# 1:1 Parity Audit: Composer & Context Bar

**Source of truth:** T3 Conn (`apps/web/src/components/chat/` & `apps/web/src/components/`)  
**Target:** `conn-gpui` (`crates/conn-app/src/chat/composer.rs`, `composer/menus.rs`, `composer/model_picker.rs`, `chat/mod.rs`, `app.rs`)  
**Scope contract:** [`docs/scope.md`](../scope.md) (Locked v1)  
**Audit date:** 2026-11-22

## Legend

- `[x]` **Exact parity** — matches Conn in behavior, states, labels, icons, tokens, and edge cases.
- `[~]` **Partial / drift** — present in `conn-gpui` but visually, structurally, or behaviorally drifted (exact diff listed).
- `[ ]` **Missing** — in scope per `docs/scope.md` and not yet implemented in `conn-gpui`.
- `[-]` **Intentionally out of scope** — excluded per `docs/scope.md` (rationale cited).

### Summary Counts

| Section | `[x]` | `[~]` | `[ ]` | `[-]` |
| --- | ---: | ---: | ---: | ---: |
| 1. Card & Editor | 3 | 4 | 13 | 2 |
| 2. Footer Controls | 2 | 5 | 4 | 2 |
| 3. Primary Action State Machine | 2 | 3 | 6 | 1 |
| 4. Model & Effort Picker | 2 | 4 | 10 | 2 |
| 5. Attachments & Paste/Drop | 2 | 2 | 12 | 2 |
| 6. Command, Mention, Skill, PR & Stash Menus | 1 | 4 | 4 | 2 |
| 7. Banners & Interactive Panels | 0 | 2 | 8 | 5 |
| 8. Branch & Permissions Context Strip | 0 | 4 | 4 | 3 |
| 9. Keyboard Shortcuts & Focus | 2 | 2 | 19 | 2 |
| **Total** | **14** | **30** | **80** | **21** |

---

## 1. Card & Editor

### Card Shell & Surface Chrome

- `[~]` **Composer card surface & border tokens** (`ComposerSurface.tsx:5-69`, `ChatComposer.tsx:3235-3251` -> `composer.rs:53,1741-1749,1988-1994`) — `conn-gpui` uses `rounded(16px)` (`rounded-2xl`), `tokens.card` (light) / `tokens.shell_field` (dark), and `1px` `tokens.shell_inner_border`. **Drift:** Conn uses frosted glass `--chat-composer-glass-surface` (`--card` light / `--surface-raised` dark) + `shadow-composer` (light) + dark `inset-shadow-2xs` top highlight (`--chat-composer-highlight`), and splits `ComposerSurface.Shell` / `Host` / `Main` so attached banners tuck seamlessly underneath the card seam (`--chat-composer-attachment-overlap: calc(1rem + 1px)`). `conn-gpui` has a flat single `div` without light drop-shadow or attached-banner seam styling.
- `[x]` **Centered content lane width & horizontal padding** (`ChatComposer.tsx:3190`, `ComposerSurface.tsx:15` -> `chat/mod.rs:35-37,2460-2474`) — `max_w(736px)` (`--chat-content-max-width: 46rem`) centered inside `48px` (`3rem`) horizontal lane padding.
- `[~]` **Bottom composer vertical spacing & safe inset** (`ChatView.tsx:3606,3994-4068`, `ComposerSurface.tsx:79` -> `composer.rs` `COMPOSER_BOTTOM_SPACER_PX` / `CONTEXT_STRIP_VERTICAL_MARGIN_PX`) — `conn-gpui` keeps `20px` (`h-[1.25rem]`) bottom breathing room below the composer card when the context strip is hidden, and symmetric `9px` top/bottom margins around the `22px` context strip on drafts and when `Settings › Appearance › Keep composer context visible` (`persistComposerContextStrip`) is enabled; `ui_tests::composer_keeps_bottom_breathing_room_and_context_strip_layout` asserts exact upper/lower bounds and symmetry for all three states. **Drift:** Conn floats the composer overlay (`absolute inset-x-0 bottom-0 z-20`) over the timeline with `24px` bottom padding on the timeline, whereas `conn-gpui` places the composer as a flex sibling below the timeline.
- `[ ]` **Ultrathink visual frame glow** (`composerProviderState.tsx:134-151`, `ChatComposer.tsx:3238,3249`) — When the active model supports prompt-injected effort (`promptInjectedValues`) and prompt triggers Ultrathink (`isClaudeUltrathinkPrompt`), apply `ultrathink-frame` border glow, subtle inset surface ring (`rgba(255,255,255,0.07)`), and chromatic shimmer on the model picker provider icon (`ultrathink-chroma`).
- `[ ]` **Drag-over composer highlight ring** (`ChatComposer.tsx:3246-3247`) — While dragging files, mentions, PRs, or threads over the composer, apply `bg-accent/45` + `1px` inset `primary/70` ring, clearing on `dragleave` outside form bounds or window `dragend`.
- `[ ]` **Project-selection-required dimmed & disabled state** (`ChatComposer.tsx:3248,3429-3430,3436`) — When composing a draft with no project selected, dim composer card (`opacity-75`), disable editor input, and show placeholder `"Choose a project above to start a thread"`.
- `[ ]` **Draft hero centered layout & `DraftHeroHeadline`** (`ChatView.tsx:3604-3605,3614-3631`, `DraftHeroHeadline.tsx:73-441` -> `chat/mod.rs:937-1125`) — `conn-gpui` renders a static `"New thread"` icon/title/pill centered in the timeline while keeping the composer pinned to the bottom. **Drift / Missing:** Conn centers the entire composer vertically on the canvas (`inset-0 flex items-center`) with `DraftHeroHeadline` directly above it (`<projectSelector>` combobox with search, project favicons, pin toggle, `"Add project"`, and `"or start without a project"` Scratch mode toggling `"What should we work on?"`), and renders notices detached below the composer (`top-full pt-4`) so notices never shift the centered card.
- `[ ]` **Provider subagent read-only bar (`ProviderSubagentBar`)** (`ChatView.tsx:3648-3671`, `ProviderSubagentBar.tsx:14-78`) — On provider-owned subagent threads (`isProviderSubagent`), unmount the editable composer and show a `min-h-12 rounded-2xl` bar displaying provider icon, model name, effort label, live ticking status (`formatProviderSubagentStatus`), muted `"Runs on its own"` text, and `"Open parent"` ghost button (`ArrowUpLeftIcon`).

### Editor Input & Rich Text

- `[x]` **Default placeholder text** (`composerPlaceholder.ts:1` -> `composer.rs:48`) — `"Ask anything. @ files, $ skills, / commands"`.
- `[~]` **Editor padding, typography & auto-grow bounds** (`ChatComposer.tsx:3312-3313`, `ComposerPromptEditorTiptap.tsx:1774,1825` -> `composer.rs:49-50,1839-1850`) — `conn-gpui` wraps `Textarea` (`Size::XSmall`, `14px` / `22px` line height, `min_lines: 2`, `max_lines: 8`) in `px(12) pt(14) pb(6)` (effective `16px` / `14px` inset). **Drift:** Conn uses `pt-4` (`16px` on desktop), `leading-relaxed` (`1.625` = `22.75px`), starts at 1 line (grows seamlessly with content up to scrollable max height), and hides placeholder if `contextRecords.size > 0`.
- `[~]` **Context-dependent dynamic placeholders & editor disable states** (`ChatComposer.tsx:3418-3439` -> `composer.rs:48,203`) — `conn-gpui` uses a single constant placeholder and never disables the editor. **Missing placeholder states:**
  1. Approval active + `supportsFeedback`: `"Send feedback to decline this request"`
  2. Approval active (no feedback): `"Send a message to decline and redirect the agent"`
  3. Pending question (choice-only `allowCustomAnswer === false`): `"Choose an option above"` + editor disabled
  4. Pending question (custom answer allowed): `"Type your own answer, or leave this blank to use the selected option"`
  5. Plan follow-up active: `"Add feedback to refine the plan, or leave this blank to implement it"`
  6. No project selected: `"Choose a project above to start a thread"` + editor disabled
  7. No provider available: `"Enable a provider in Settings to send a message"`
  8. Default: `"Ask anything. @ files, $ skills, / commands"`
- `[ ]` **Inline atomic chips inside editor** (`ComposerPromptEditorTiptap.tsx:238-260`, `composerContextPresentation.tsx:58-149`, `ComposerPendingTerminalContexts.tsx:14-32`) — Render interactive inline pill tokens inside the composer text (single-step cursor/backspace deletion, hover/click popovers) for:
  - `@path` workspace file/folder mentions (`FileTagChip`, click opens file in right panel)
  - `$skill` inline skill chips (`SkillChipPopover` with description)
  - Terminal context selections (`ComposerPendingTerminalContextChip`: `@terminal:lines`, expired state, preview popover)
  - Review comments & `#PR` references (`PullRequestChip` / `ReviewComment`, click opens PR/link)
  - Preview/Device annotations (`MousePointerClickIcon`, screenshot preview)
  - Thread references (`@thread`, `MessagesSquareIcon`)
  - Inline image & file attachment chips (clickable to preview/zoom)
  - Assistant citations (`AssistantCitationChip` + inline comment editor popover with Cmd+Enter submit-and-send)
- `[ ]` **Inline context undo/redo retention** (`ChatComposer.tsx:1594,1625-1728`, `composerContextUndo.ts`) — Deleting an inline context chip removes its backing draft record (terminal/review/annotation/file/thread) while retaining the payload in memory so `Cmd+Z` undo restores both chip and backing record.
- `[ ]` **Rich Markdown editing in composer** (`ComposerPromptEditorTiptap.tsx:67-99`, `ComposerCodeBlockNodeView.tsx:9-56`, `ComposerCodeBlockLanguagePicker.tsx:31-102`) — Bold, italic, strikethrough, inline code, bullet/ordered/task lists, fenced code blocks with syntax highlighting (`shiki`/`syntect`) and interactive searchable language picker (`ComposerCodeBlockLanguagePicker`), auto-closing surround characters (`()[]{}`''""``<>«»*_`), list continuation on Enter, list indent/outdent on Tab/Shift+Tab, and fenced code block entry/exit ergonomics.
- `[ ]` **Copy/Cut/Paste structured context fragments** (`ComposerPromptEditorTiptap.tsx:1740-1766`, `ChatComposer.tsx:1319-1371`) — Copying or cutting text containing inline context chips serializes a `COMPOSER_CONTEXT_CLIPBOARD_MIME` fragment so pasting into the same or another thread preserves the backing attachments/contexts.
- `[ ]` **Per-thread & per-draft persistent composer draft store** (`ChatComposer.tsx:638,801-824`) — Switching between threads or drafts must preserve each thread's unsent prompt text, cursor position, attachments, and model/options selection instead of sharing one global `TextareaState` across threads.
- `[ ]` **Prompt length validation (`ComposerPromptLengthValidation`)** (`ComposerPromptLengthValidation.tsx:1-13`, `composerSubmission.ts:12-31`, `ChatComposer.tsx:1415-1435,3474-3476`) — Block submission and render an inline destructive `role="alert"` message (`px-4 pb-2 text-xs text-destructive`): `"Prompt is N character(s) over the <limit>-character limit. Shorten or split it before sending."` Auto-updates/clears as the user edits.
- `[ ]` **Typing guard for incoming approvals & questions** (`composerTypingGuard.ts:1-58`, `ChatComposer.tsx:611-636`) — Hold newly-arrived approval/user-input requests for `1500ms` (`COMPOSER_TYPING_IDLE_MS`) while the editor is focused and the user is actively typing, releasing on idle/blur/send so typing or pressing Enter never accidentally answers or redirects an unseen prompt.
- `[ ]` **RTL / bidirectional text detection** (`ComposerPromptEditorTiptap.tsx:61`) — Automatic per-line text direction detection for RTL prompts.
- `[x]` **Multi-line newline entry (`Shift+Enter`)** (`composer-logic.ts:85` -> `composer.rs:205,214`) — `Shift+Enter` inserts a newline; bare `Enter` submits (when no menu is open).
- `[-]` **Mobile collapsed resting composer & software keyboard collapse/expand animation** (`ChatComposer.tsx:1035-1052,2181-2203,3252-3299,3565-3585`, `useComposerRestingTransition.ts`, `useSoftwareKeyboardOpen`) — Out of scope (`docs/scope.md` §1: `conn-gpui` is macOS desktop only; mobile is future pure SwiftUI iOS).
- `[-]` **Embedded side-chat pane isolation (`isInSideChatPane`)** (`ChatComposer.tsx:1074-1121`, `useChatShortcuts.ts:28-33`) — Out of scope (`docs/scope.md` `#29 Drop` Side Chats right-panel tab).

---

## 2. Footer Controls

> **Structural note:** In T3 Conn (`ComposerControlsBar.tsx`, `ComposerFooterControls.tsx`, `ChatComposer.tsx:3479-3563`), the composer footer row holds:
> - **Left:** Attach button (`PaperclipIcon`, `28px`)
> - **Right (left-to-right):** `[Model + Effort unified trigger]` · `[Conditional Permissions chip (only when mode != default & not in new-thread strip)]` · `[Plan/Build mode toggle]` (or `[...]` `CompactComposerControlsMenu` overflow) · `[ContextWindowMeter]` · `[Operator Mic (Conn-native)]` · `[Compact-before-send pill (conditional)]` · `[Primary Action button (32px)]`.
>
> In `conn-gpui` (`composer.rs:1851-1873`), Plan and Runtime permissions were placed in the bottom `BranchToolbar` context strip instead of the footer/model picker, and Effort is a separate trigger beside the model trigger instead of unified inside the model trigger.

- `[x]` **Attach files button (`ComposerAttachButton`)** (`ComposerAttachmentStrip.tsx:671-717`, `ChatComposer.tsx:3135-3140,3487` -> `composer.rs:1655-1669,1860`) — Left-aligned `28px` ghost icon button with `attach.svg` (`Paperclip`), tooltip `"Attach files"`, opens multi-file picker.
- `[~]` **Attach button visibility gating** (`ChatComposer.tsx:1204-1208` -> `composer.rs:545,1655`) — `conn-gpui` always shows the attach button even when disconnected or answering a choice-only question. Conn hides it when `fileStagingLimit === null` or when answering a question that disallows attachments/custom answers.
- `[x]` **Model + Effort trigger presentation** (`ComposerControlsBar.tsx:168,191-253`, `ComposerModelEffort.tsx:84-170`, `EffortGlyph.tsx:1-107`, `ProviderModelPicker.tsx:311-412` -> `composer.rs:1507-1653`) — `conn-gpui` renders two separate buttons (`[ProviderIcon ModelName]` and `[thinking.svg Medium]`) with a separate tiny popover for effort. **Drift:** Conn unifies Model + Effort into a **single** `ComposerControl` trigger (`size="sm"`, `h-7`, `rounded-(--control-radius)`) showing: **Wave 1B:** unified trigger with compact `modelShortName` label, effort word (`effortDisplay="label"` default), Fast bolt, and context-window suffix (`composer.rs`, `model_picker.rs`). Bars mode, instance badge, and `Unavailable` badge still missing.
  - Provider icon (`16px`) + optional instance badge (when multiple instances of same driver exist)
  - Model trigger short name (`max-w-56 truncate`)
  - Inline suffix (`text-muted-foreground`, brightening to `foreground` on trigger hover/open):
    - Effort **rising bar glyph** (`EffortGlyph`, 2px-wide sharp bars, filled opacity `1.0` vs unfilled `0.4`, `14px` height) OR effort **word label** (controlled by `effortDisplay` setting; special levels like `Max`, `Ultrathink`, `Ultracode` always show word)
    - `FastBolt` (`ZapIcon` filled for Fast; double-stroked echo bolt for Ultrafast)
    - Secondary context-window option label (e.g., `1M`, `text-xs`)
    - `"Unavailable"` outline badge if active model is unavailable
  - Tooltip combining `[Full model name] · [Effort detail] · [⌘⇧M]`
- `[x]` **Plan / Build interaction mode toggle (`ComposerFooterModeControls`)** (`ComposerFooterControls.tsx:55-97` -> `composer.rs:1311-1349`) — Currently rendered in `conn-gpui`'s bottom context strip (`h(22px)`, `checklist.svg`, label `"Plan"` always). **Drift:** In Conn this sits in the **composer footer** (`h-7` = `28px`, `ComposerControl`), toggles between: **Wave 1B:** moved into the footer (`footer.rs`) with `design`/`agent` icons, accent when Plan, exact tooltips, `Shift+Tab`.
  - Plan active (`aria-pressed="true"`, `bg-accent text-accent-foreground`): `PencilRulerIcon`, label `"Plan"`, tooltip `"Plan mode. Click to return to normal build mode"`
  - Build active (`aria-pressed="false"`): `BotIcon` (`opticalSize="large"`), label `"Build"`, tooltip `"Default mode. Click to enter plan mode"`
  - Hidden when provider does not support interaction mode toggle (`showInteractionModeToggle`) or `planModeEnabled` is off.
- `[x]` **Conditional Permissions chip in footer (`ComposerFooterModeControls` + `composerControlsOwnership.ts`)** (`ComposerFooterControls.tsx:99-156`, `composerControlsOwnership.ts:6-35` -> `composer.rs:1351-1436`) — Currently `conn-gpui` always shows a `shield.svg` + mode label dropdown in the bottom context strip. **Drift:** In Conn: **Wave 1B:** chip hidden while the mode matches the default; drafts show it at the strip's trailing end; picker footer always holds Permissions.
  - Permissions always live in the Model Picker footer (`ComposerPickerFooter`).
  - On new-thread drafts, Permissions appear at the trailing end of the bottom context strip (`ComposerContextPermissions`).
  - On started threads, the footer Permissions chip is **hidden when the thread matches the user's default runtime mode**, and **only surfaces in the footer** when overridden to a non-default mode (emphasized icon color, tooltip `"Permissions: <Label>. <Description>"`, clicking opens `ComposerPermissionsSection` segmented radio popover).
- `[~]` **`ComposerPermissionsSection` segmented horizontal radio menu** (`ComposerFooterControls.tsx:165-246`, `runtimeModeConfig.ts:4-43`) — `w-72` menu containing `"Permissions"` header, horizontal 4-segment icon-only radio bar (`bg-input/40 p-0.5 rounded-lg`, Left/Right arrow navigation, checked segment `bg-input/72 text-foreground`) with exact per-mode icons & copy: **Wave 1B:** segmented radio, hover preview, reserved 2-line description, provider-supported filtering (`footer.rs`). Left/Right keyboard navigation still missing.
  - `approval-required`: `LockIcon` — `"Supervised"` — `"Ask before commands and file changes."`
  - `auto-accept-edits`: `PenLineIcon` — `"Auto-accept edits"` — `"Auto-approve edits, ask before other actions."`
  - `auto`: `SparklesIcon` — `"Auto"` — `"Supported providers approve routine actions; others still ask."`
  - `full-access`: `ShieldOffIcon` — `"Full access"` — `"Allow commands and edits without prompts."`
  - Hovering or focusing any segment previews its label + 2-line reserved description (`min-h-8`) below without layout shift. Filters modes to `provider.supportedRuntimeModes` (`resolveCompatibleRuntimeMode`).
- `[ ]` **Responsive footer overflow (`CompactComposerControlsMenu` + icon-only compression)** (`ComposerControlsBar.tsx:274-317`, `CompactComposerControlsMenu.tsx:17-80`, `composerFooterLayout.ts:44-125`) — When the composer narrows (e.g., side panels open), first collapse mode block labels to icon-only, then move trailing mode/permissions controls into an `EllipsisIcon` (`More composer controls`) popover menu containing `Mode` (`Chat` / `Plan`) radio items + divider + `ComposerPermissionsSection`.
- `[x]` **`ContextWindowMeter` circular gauge & hover popover** (`ContextWindowMeter.tsx:21-179`, `ContextWindowMeter.logic.ts:16-134`, `ComposerFooterControls.tsx:290-300` -> `crates/conn-state/src/thread.rs` `ThreadState::context_window`, `crates/conn-app/src/chat/composer/context_meter.rs`, `crates/conn-app/src/chat/mod.rs`) — `28x28px` button (`size-7`) before the primary action button containing a `20x20px` ring (`r=9.75`, `strokeWidth=3`, track `muted-foreground/24`, arc `muted-foreground/72` or `error` when `> 90%`), hover popover with used/max tokens, percentage, progress bar, total processed, cost, auto-compaction notice, and `Compact context` action, fed live from `ThreadState::context_window()` (turn `tokenUsage`, active provider thread `contextUsage`, and compaction fallback). (`ContextWindowMeterPlaceholder` reserved slot while loading still optional.)
  - Header: `"Context Window"` + `"<pct>% · <used>/<max>"` (or `<used>` when max unknown, `tabular-nums`, `<10%` 1 decimal else rounded integer)
  - Progress bar (`h-1.5 rounded-full`)
  - Optional `"Total processed"` row (when `> 0`)
  - Optional `"Cost"` row (`<currency> <amount>`, 4 decimals if `< 0.01`, else 2)
  - Optional auto-compaction notice (`"Compacts automatically at about X tokens."` or `"Context for <Model> compacts automatically when needed."`)
  - Optional `"Compact context"` outline button (`Minimize2Icon`) when provider advertises `/compact` slash command, plus disabled reason string below when disabled.
  - `ContextWindowMeterPlaceholder` (`size-7`) reserves layout slot while thread details are loading so footer buttons don't jump.
- `[ ]` **Provider unavailable footer fallback button** (`ComposerControlsBar.tsx:254-269`) — When `showProviderUnavailable` is true (catalog loaded, no ready provider), replace the entire controls bar with a single `ComposerControl` showing `CircleAlertIcon` + `"Open provider settings"` (clicking opens Settings → Providers) or `"No provider available"` (disabled).
- `[x]` **Operator dictation microphone button** (`docs/scope.md` `#6 Operator`, `#10`; `FORK.md:316-325` -> `composer.rs:700-912,1671-1727,1997-2047`) — Conn-native Operator dictation button (`28px` round, `microphone.svg`, `Idle`/`Starting`/`Recording`/`Transcribing` states, status badge + red recording dot, `Esc` cancel, external Operator hotkey `/dictate/wait` auto-append, click-to-dismiss friendly error badge).
- `[~]` **Operator dictation status polish** (`composer.rs:1679-1727`) — Works end-to-end with local Operator, but lacks server-side Operator voice bridge fallback (`docs/scope.md` `#6`) when connected to a remote Node/Instance where local Operator isn't running or when transcription comes via server bridge.
- `[-]` **Upstream T3 Whisper / browser speech (`ComposerSpeechButton`)** (`docs/scope.md` `#6 Operator`) — Intentionally replaced by Operator dictation.
- `[-]` **Resting collapsed mobile footer controls bar** (`ChatComposer.tsx:3565-3585`, `ComposerControl.tsx:29-30`) — Out of scope (mobile viewport only).

---

## 3. Primary Action State Machine

Every branch in `ComposerPrimaryActions.tsx:154-391` (evaluated in exact priority order):

- `[ ]` **State 1 — Pending User Input Question Actions** (`ComposerPrimaryActions.tsx:154-202`) — When `pendingAction !== null`:
  - If `canInterrupt`, show `28px` (`sm:size-7`) red Stop button to the left.
  - If `questionIndex > 0`, show `"Previous"` outline button (or `ChevronLeftIcon` `icon-sm` when compact).
  - Primary pill (`rounded-full bg-message-action h-7 px-4`): label is `"Submitting..."` (when responding) -> `"Next question"` / `"Next"` (when `!isLastQuestion`) -> `"Submit answers"` (if multi-question) / `"Submit answer"` (if single question) / `"Submit"` (compact). Disabled until `canAdvance` / `isComplete`.
- `[~]` **State 2 — Plan Follow-Up Actions (`Refine` / `Implement` split button)** (`ComposerPrimaryActions.tsx:204-260`) — When `showPlanFollowUpPrompt && (promptHasText || !canResume)`: **Wave 1B:** `Refine` / split `Implement` + `Implement in a new thread` ported (`actions.rs`); `set_plan_follow_up` not yet fed by `conn-state`.
  - If `promptHasText`: pill button `"Refine"` (or `"Sending..."` while busy).
  - If empty prompt: split primary pill (`h-8`): left button `"Implement"` (`rounded-r-none px-4`), right menu trigger (`ChevronDownIcon`, `border-l`, `rounded-l-none px-2`, `aria-label="Implementation actions"`) opening a popover with `"Implement in a new thread"`.
- `[x]` **State 3 — Running + Empty Draft (`Stop generation`)** (`ComposerPrimaryActions.tsx:127-152,262-264` -> `composer.rs:2061-2080`) — `32px` round `destructive/90` button with `12px` rounded square icon, `aria-label="Stop generation"`, tooltip `"Interrupt"`, emits `Stop`.
- `[~]` **State 4 — Resume Interrupted Thread / Held Queue (`Resume thread`)** (`ComposerPrimaryActions.tsx:266,274-275,329-330`, `useComposerResume.ts:54-166`) — When `canResume && !hasSendableContent && !isEditingQueuedMessage`, render active primary `32px` round button with filled `PlayIcon`, `aria-label="Resume thread"`, tooltip `"Resume thread"`. Clicking sends `"Continue where you left off."` with `manualContinuationOfRunId` and/or releases held queued runs. **Wave 1B:** play button + `Continue where you left off.` ported; `set_can_resume` not yet fed (no interrupted-run state); `manualContinuationOfRunId` not sent.
- `[x]` **State 5 — Editing Queued Message (`Update queued message`)** (`ComposerPrimaryActions.tsx:276-277,331-332`, `useQueuedRunEdit.ts:304-347`) — When `isEditingQueuedMessage`, render `32px` round button with `CheckIcon`, label/tooltip `"Update queued message"` (or `"Updating queued message"` while busy). **Wave 1B:** check button + `Update queued message` / `Updating queued message`.
- `[x]` **State 6 — Running + Sendable Content (Queue vs. Steer dual dispatch)** (`ComposerPrimaryActions.tsx:114-123,280-284,299-301,333-334` -> `composer.rs:2081-2108`) — `conn-gpui` swaps `ARROW_UP` for `FORWARD` (`CornerUpRight`) with static tooltip `"Queue message"` and always calls `submit` with default send. **Drift:** Conn resolves `dispatchMode` (`"steer"` vs `"queue"`) from `settings.followUpBehavior` (`"steer"` forced when visible pending approvals exist), `canSteer` (`!isCompacting`), and live `⌘`/`Ctrl` modifier hold (`useShortcutModifierState`), dynamically morphing the icon between `CornerUpRight` (Steer) and `ListPlus` (Queue), with tooltip: `"Click to <steer|queue>, ⌘-click or <⌘Enter> to <queue|steer>"`. **Wave 1B:** dispatch resolved per `resolveComposerDispatchMode` (held `⌘`/`Ctrl`, `⌘`-click, `⌘Enter`), icon morphs `forward`/`list-add`, exact tooltip; sends `steer_active` with the active run id.
- `[ ]` **State 7 — Compact-Before-Send Toggle Pill** (`ComposerPrimaryActions.tsx:268-272,278-279,297-298,357-390`, `ChatView.tsx:2543-2577`, `ContextWindowMeter.logic.ts:64-85`) — For idle Claude threads past prompt-cache TTL (`>= 70m`) with high token count (`>= COMPACTION_SUGGESTION_MIN_TOKENS`), show a toggle button beside the send button: `Minimize2Icon` + `"Compact"` (or `"Keep"` when `keepFullHistory`) + formatted token count (`tabular-nums`, e.g. `142k`), tooltip explaining `"Next send compacts <N> tokens first. / Click to keep full history"`, and send tooltip `"Summarize <N> tokens of history, then send"`.
- `[x]` **State 8 — Idle Sendable (`Submit message`)** (`ComposerPrimaryActions.tsx:284,335-345` -> `composer.rs:2088-2108`) — `32px` round `primary` pill with `14px` `ARROW_UP`, tooltip `"Submit message"`, hover scale/darken.
- `[x]` **State 9 — Disabled State & Specific Status Tooltips** (`ComposerPrimaryActions.tsx:285-296,307-320` -> `composer.rs:2109-2126`) — `conn-gpui` renders `bg-foreground/12` + muted `ARROW_UP` with no tooltip explaining why send is disabled. **Drift:** Conn wraps the disabled button in a tooltip displaying exact `submitStatus` priority: `"Environment disconnected"` -> `sendDisabledReason` (`"Select at least one model."`, `"Preparing machine"`, `"Rewinding conversation"`, `"Messages loading"`, `"Preparing worktree"`, `"Attach the interrupted file again or remove it"`, upload-in-progress/failed reasons, Antigravity model block reason) -> `"Submitting message"` / `"Updating queued message"`. **Wave 1B:** Conn priority order incl. `Attachment(s) still uploading`.
- `[x]` **State 10 — Busy Spinner (`isSendBusy`)** (`ComposerPrimaryActions.tsx:327-328`) — While `isSendBusy` (or `isResuming` / `queuedRunEdit.isSaving`), replace button icon with `Spinner` (`size="sm"`) and disable button. **Wave 1B:** `TurningArc` spinner while submitting.
- `[~]` **Focus preservation & hover micro-motion** (`ComposerPrimaryActions.tsx:110-112,307`) — Conn preserves editor focus on pointer down when appropriate and applies `hover:scale-105` + inset highlight/pressed shadow on enabled primary pill.
- `[-]` **Sidebar stage backdrop art inside send button** (`ComposerPrimaryActions.tsx:9,125,308-310,322-326`) — Out of scope (upstream themed backdrop skinning not part of Conn shell design system).

---

## 4. Model & Effort Picker

- `[x]` **Docked 2-column popup geometry (`ProviderModelPicker` + `ComposerEffortColumn` + `ComposerPickerFooter`)** (`ProviderModelPicker.tsx:434-460`, `ComposerModelEffort.tsx:490-657` -> `composer/model_picker.rs:27-33,327-601`, `composer.rs:1549-1653`) — `conn-gpui` renders a single `360px` wide popup for models and a completely separate small dropdown (`164px`) for effort. **Drift:** Conn docks the Effort/Options column (`w-48` = `192px`, `border-l`, `bg-muted/40`) right beside the `max-w-90` (`360px`) model list (`h-86.5` = `346px` fixed height so switching tabs/models never resizes the popup), plus a full-width `ComposerPickerFooter` (`border-t bg-muted/40 px-3 py-2`) across the bottom! Picking a model keeps the docked popup open and moves focus into the effort column (`focusEffort("levels")`). **Wave 1B:** 360px list + 192px effort column at fixed 346px, full-width footer; picking keeps the popup open.
- `[~]` **Docked `ComposerEffortColumn` (reasoning levels + extra selects + boolean switches)** (`ComposerModelEffort.tsx:176-524`) — Right column of model picker: **Wave 1B:** header, reasoning radios, `Default` hints, description tooltips, option rows (select rows cycle instead of opening a side menu), switch rows, `No effort levels`. Ultrathink lock note still missing.
  - Header aligned with search input (`h-8.25 border-b`): dynamic label (`descriptor.label` or `"Options"` or `"Effort"`) + right-aligned truncated active model name.
  - Reasoning `radiogroup`: rows (`h-8`) with label, `"Default"` muted badge (when unselected default), `CheckIcon` (when selected), hover description tooltip (`side="right"`), and `"No effort levels"` fallback when model has no options.
  - Ultrathink body lock notice (`ULTRATHINK_IN_BODY_NOTE`): `'Your prompt contains "ultrathink" in the text. Remove it to change this option.'` disabling effort radios when `"ultrathink"` appears in prompt body.
  - Additional model option descriptors separated by `border-t`:
    - `OptionMenuRow`: secondary select descriptors (e.g., context window, agent session mode) displaying `label` over `current value` + `ChevronRightIcon`, opening a side `MenuPopup` (`ArrowRight` opens, `ArrowLeft` closes).
    - `OptionSwitchRow`: boolean descriptors (other than `fastMode`) rendered as inline `Switch` rows (`On`/`Off`).
  - Unavailable OpenCode model fallback: read-only display of saved option descriptors.
- `[x]` **Docked `ComposerPickerFooter` (Speed segmented toggle + Permissions menu)** (`ComposerModelEffort.tsx:526-657`) — Bottom bar of the docked model picker: **Wave 1B:** speed segments (Codex `serviceTier`, Claude `fastMode`) + Permissions menu, plus a Steer/Queue follow-up control (requested addition; Conn keeps this in Settings).
  - Left: `SpeedControl` horizontal segmented radio (`bg-input/40 p-0.5 rounded-lg`) for Codex `serviceTier` (e.g. `Standard` / `Fast` / `Ultrafast` with `FastBolt` + description tooltip) or Claude `fastMode` (`Standard` / `Fast` with `FastBolt`). Respects `withImplicitFastModeDefault` (`fastMode: false` unless explicitly chosen).
  - Right: `PermissionsMenu` trigger (`ms-auto`, current mode icon + label + `ChevronUpIcon`) opening `ComposerPermissionsSection` (`side="top" align="end"`).
- `[ ]` **Favorites tab in provider sidebar & per-row favorite star toggle** (`ModelPickerSidebar.tsx:94-124`, `ModelListRow.tsx:104-135`, `ModelPickerContent.tsx:389,442-445,661-676`) — Left rail starts with a `StarIcon` `"Favorites"` tab + divider above provider icons; opens to Favorites by default if user has favorites and provider is not locked. Each model row has a star toggle button (`text-warning fill-current` when favorited; hover-revealed otherwise; hover-only inside Favorites tab) with tooltip `"Add to favorites"` / `"Remove from favorites"`, persisted per environment. Favorites sort to top within each provider tab (`groupFavorites`).
- `[~]` **Provider sidebar rail details & disabled/locked states** (`ModelPickerSidebar.tsx:14-215`, `ModelPickerContent.tsx:586-640,857-873` -> `composer/model_picker.rs:358-411`) — `conn-gpui` renders `44px` rail with provider icons and a `3px x 20px` primary indicator pill, hidden when `providers.len() <= 1`. **Drift:** Conn shows the rail whenever `sidebarInstanceEntries.length > 0` (because of Favorites tab), animates the selection pill smoothly, shows hover tooltips on the left (`side="left" sideOffset={8}`) naming the provider or exact unavailable reason (`"<Name>: Disabled in settings."` / `"<Name>: Unavailable. <msg>"` / `"<Name>: Limited. <msg>"`), supports **locked provider** threads (moves incompatible providers to bottom, `opacity-50 cursor-not-allowed`, tooltip `"<Name> is unavailable in this thread. Start a new thread to switch providers."`), and supports multi-instance accent badge (`showInstanceBadge`).
- `[~]` **Model list search ranking & metadata** (`ModelPickerContent.tsx:643-658`, `ModelListRow.tsx:43-157` -> `composer/model_picker.rs:207-242,476-571`) — `conn-gpui` does simple substring `.contains()` across name/slug/provider/subProvider and shows icon + name + check + subProvider + `"New"` badge. **Drift:**
  - Conn uses ranked fuzzy search (`rankModelPickerSearch`) boosting favorites and exact/prefix matches.
  - Row check icon is **right-aligned** in a fixed column (last element, `invisible` when unselected) rather than inline after the model name.
  - Truncated model name shows full name tooltip on hover.
  - `"Unavailable"` outline badge when `model.isUnavailable`.
  - Per-model `disabledReason` disables the row (`cursor-not-allowed`) and wraps it in a tooltip (`side="left"`).
  - Virtualized list with top/bottom scroll fade masks.
  - Empty state distinguishes `"No favorites yet"` vs `"No models found"`.
- `[ ]` **Legacy models collapsible `"Show more"` / `"Show less"` row** (`ModelPickerContent.tsx:446-454,679-709,1016-1030`) — Non-favorited `isLegacy` models collapse behind a trailing `"Show more"` / `"Show less"` row per provider tab (auto-expanded if the active model is legacy; ignored while searching).
- `[ ]` **Multi-model selection on draft threads (`Shift+Click` / `Shift+Enter`)** (`ComposerFooterControls.tsx:338-405`, `ProviderModelPicker.tsx:207-236,349-376`, `ModelPickerContent.tsx:501-505,912,1001`) — On new-thread drafts when server supports `requiredWorktreeBootstrap`, `Shift+Click` or `Shift+Enter` toggles multiple models simultaneously (each spawns its own worktree thread on send). Trigger shows up to 3 overlapping circular provider icons (`+N` badge if >3) and `"Model A, Model B, N more"` label. Regular click resets to single model.
- `[ ]` **Model jump shortcuts (`⌘1`–`⌘9`) & `<Kbd>` badges** (`ModelPickerContent.tsx:175-193,736-766,813-833`, `ModelListRow.tsx:103`) — First 9 enabled visible models show their shortcut badge (`⌘1`..`⌘9`) in each row and select immediately on keypress.
- `[ ]` **Model picker full keyboard navigation** (`ModelPickerContent.tsx:780-834,931-1006`, `ModelPickerSidebar.tsx:76-83`, `ProviderModelPicker.tsx:444-450`) — `⌘⇧↑`/`⌘⇧↓` cycles provider tabs (clearing search); `ArrowLeft` (at empty search) or `Shift+Tab` moves focus to provider sidebar; `ArrowRight` from sidebar returns to search; `ArrowRight` at end of search text picks highlighted model (if different) and moves focus into the docked Effort column; `ArrowLeft` from Effort column returns focus to search input; `Up`/`Down` moves between effort/option rows.
- `[ ]` **Provider update-required & status notices in model picker** (`ModelPickerContent.tsx:195-251,713-734`) — Show `updateRequiredNotices` (e.g., provider CLI update needed for specific models with `"Provider settings"` link) and unavailable provider status message + `"Open provider setup"` link when selected provider isn't ready.
- `[x]` **Catalog fetch from `server.getConfig` + default model & alias resolution** (`composer/model_picker.rs:95-200`, `composer.rs:460-498`) — Loads `ServerConfig.providers`, picks first ready provider's `is_default` model, resolves short aliases (`haiku`, `sonnet`, etc.).
- `[x]` **Search across all providers when query non-empty** (`ModelPickerContent.tsx:646-657` -> `composer/model_picker.rs:213-230`) — Typing in search box hides the provider rail and searches models across all providers.
- `[~]` **Resetting model options vs preserving sticky options on model switch** (`composer.rs:982` vs `TraitsPicker.tsx:331-335`) — `conn-gpui` unconditionally wipes `selected_options = None` whenever a model is picked. Conn preserves compatible/sticky per-provider-model options across thread/model switches.
- `[ ]` **Antigravity default model placeholder (`"Choose model"`) & send-block check** (`ProviderModelPicker.tsx:147-149`, `ModelPickerContent.tsx:90-110`, `ChatComposer.tsx:936-939`) — Filters synthetic `ANTIGRAVITY_DEFAULT_MODEL` slug out of picker list, shows `"Choose model"` if unresolved, and surfaces `getAntigravitySendBlockReason`.
- `[ ]` **Reasoning effort step shortcuts (`composer.increaseEffort` / `composer.decreaseEffort`)** (`ChatComposer.tsx:2870-2899`, `composerProviderState.tsx:156-197`, `TraitsPicker.tsx:241-285`) — Step reasoning effort up/down without opening the picker (including cleanly stripping/adjusting `Ultrathink:` prefix while keeping caret position).
- `[-]` **ChatGPT subscription sharing control (`ChatGptSharingControl`)** (`ProviderModelPicker.tsx:14,289,461-463`) — Out of scope (`docs/scope.md` `#3 Drop` ChatGPT OAuth / multi-account sharing).
- `[-]` **Per-provider OAuth setup wizards** (`ModelPickerContent.tsx:211-229`) — Out of scope (`docs/scope.md` `#3/#4` — models route through `ai-router`/CLI, no OAuth wizards; keep simple Settings link only).

---

## 5. Attachments & Paste/Drop

- `[x]` **Multi-file picker, drag-and-drop files & `⌘V` clipboard image/file paste** (`ComposerAttachmentStrip.tsx:671-717`, `ChatComposer.tsx:2561-2578` -> `composer.rs:544-696,1880-1889`) — Native multi-file dialog, OS `ExternalPaths` drop onto composer, and `⌘V` intercept for copied files or standalone clipboard images (preserving plain text when clipboard has both text + image).
- `[x]` **Upload via `attachments.createUploadUrl` + send blocking while uploading** (`composer.rs:608-647,929-935`) — Uploads bytes asynchronously and blocks submission while any attachment is in `Uploading` state.
- `[~]` **Image attachment thumbnails (`64x64` visual tiles vs text pills)** (`ComposerAttachmentStrip.tsx:111-326`, `ComposerImageThumbnail.tsx:12-82` -> `composer.rs:1751-1833`) — `conn-gpui` renders **all** attachments (including images!) as `28px`-tall filename + size pill chips with file icons. **Drift:** Conn splits attachments into two distinct rows above the editor:
  1. **Media row (`ComposerAttachmentMediaRow`)**: `64x64px` (`h-16 w-16 rounded-lg border border-border/80`) image thumbnails with live local blob preview (`object-cover`, `cursor-zoom-in`), HEIC fallback, upload progress `%` bottom overlay bar, and corner `media-close` `X` button.
  2. **Non-media file list (`ComposerAttachmentFileList`)**: stacked rows (`gap-1 py-1 text-sm`) with `@pierre/trees` icon, clickable filename (`hover:underline`), right-aligned size / `%` / reattach status, retry button, and `X` button.
- `[ ]` **Video attachment thumbnails with first-frame poster & play icon** (`ComposerAttachmentStrip.tsx:50-67,327-401`) — Previewable videos render in the `64x64` media row with dark gradient scrim, first-frame poster, and centered filled `PlayIcon`; clicking opens video preview lightbox.
- `[ ]` **Attachment click-to-preview (image lightbox & file preview dialog)** (`ComposerAttachmentStrip.tsx:196-205,447-454,503-550`) — Clicking an image/video thumbnail opens the expanded media dialog (`ExpandedImagePreview` with gallery navigation across draft images); clicking a non-media file row opens `ComposerFilePreviewDialog` (`AttachmentFilePreview` with Remove/Close actions).
- `[ ]` **Upload progress percentage & failed-upload Retry button** (`ComposerAttachmentStrip.tsx:260-291,360-389,460-487` -> `composer.rs:1767-1772,1807-1812`) — `conn-gpui` only shows `"Uploading…"` or raw error string with no retry action. Conn shows live upload `%` (`formatAttachmentUploadProgress`), a `RefreshIcon` retry button (`Retry upload for <name>`) with failure reason tooltip on failed uploads, and blocks send until failed uploads are retried or removed.
- `[ ]` **Attachment count, size & image-type validation with user-facing errors** (`useComposerAttachmentIntake.ts:159-219`) — Enforce `PROVIDER_SEND_TURN_MAX_ATTACHMENTS` (`"You can attach up to N files per message."`), reject empty files (`"'<name>' is empty or could not be read."`), reject oversized files (`fileAttachmentTooLargeMessage`), reject unsupported image MIME types (`"'<name>' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images."`), and display errors in the thread error banner.
- `[ ]` **Client-side image compression + preparing placeholder tiles** (`useComposerAttachmentIntake.ts:246-328`, `preparingComposerImages.ts`, `ChatComposer.tsx:2086-2094`) — Compress oversized images to `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES` while showing a preparing thumbnail tile; block send with info toast `"Still compressing a pasted image. / Send again once its thumbnail appears."` if user submits mid-compression.
- `[ ]` **Large text paste auto-folding into `.txt` file attachment + `⌘⇧V` paste-as-text bypass** (`useComposerAttachmentIntake.ts:359-434`, `ChatComposer.tsx:1076-1121,2561-2587`) — Automatically fold very large pasted text into `pasted-text-N.txt` file attachment with info toast (`"Large paste attached as <name> · <size> · Use ⌘⇧V to keep a large paste inline."`). Pressing `⌘⇧V` arms a 1-second bypass keeping large pastes inline (and skipping image inline chips).
- `[ ]` **Inline image/file chip insertion & destructive confirm dialog on removing referenced image** (`useComposerAttachmentIntake.ts:140-145,224-228,313-316,331-357`) — Attaching files (or images when prompt already has text) inserts an inline chip at the caret; clicking `X` on a media tile that is referenced inline prompts confirmation: `"Remove <name> from the message?\nIt is referenced in your text; removing it also removes every reference."`
- `[ ]` **Folder drag-and-drop -> `@folder` link insertion** (`ChatComposer.tsx:2520-2558`) — Dropping a folder on a local server inserts `@<folder-path> ` inline instead of silently skipping `!path.is_file()` (`composer.rs:577`); on remote servers, shows toast `"Folders can only be referenced on a server running on this computer"`.
- `[ ]` **Thread drag-and-drop -> thread context chip or transcript import** (`ChatComposer.tsx:2631-2734`) — Dropping a thread from the sidebar onto the composer inserts an inline `@thread` chip (same server) or fetches its transcript as a file attachment (cross-server) with loading toast `"Loading thread context…"` and send-blocking guard (`pendingDraftWork`).
- `[ ]` **File/PR mention drag-and-drop from Files / PR panels onto composer** (`ChatComposer.tsx:2607-2629`, `composerMentionDrag.ts`) — Dropping a workspace file or PR reference onto the composer inserts its inline mention/chip at the end.
- `[ ]` **Interrupted draft file re-attach markers & non-persisted image warning** (`ComposerAttachmentStrip.tsx:242-259,439-463`, `ChatComposer.tsx:790-795`) — Show `"Attach again"` / `"Remove to send"` on draft files whose local blob was lost across reload (matching re-dropped files replaces the marker without consuming an attachment slot), and `CircleAlertIcon` badge when a draft image could not be persisted locally.
- `[ ]` **Queued message edit attachment row (`ComposerQueuedAttachmentRow`)** (`ComposerAttachmentStrip.tsx:632-669`, `ChatComposer.tsx:3363-3371`) — While editing a queued message, display its already-uploaded attachments in a `64x64` strip with local removal (`X`) that commits on save.
- `[~]` **Inline file icon parity (`@pierre/trees`)** (`ComposerAttachmentStrip.tsx:446` -> `composer.rs:1762`) — `conn-gpui` uses `crate::file_icons::file_icon(&att.name)` on attachment pills (good), but needs to carry over to `ComposerAttachmentFileList` rows when split from image thumbnails.
- `[-]` **SnapShot screen-capture tiles & arrival animation** (`ComposerAttachmentStrip.tsx:69-108,173-194,233-241,312-326`) — Out of scope (`docs/scope.md` `#26 Drop` SnapShot).
- `[-]` **Resting collapsed mobile 28px image thumbnail strip (`ComposerRestingImagePreviews`)** (`ComposerAttachmentStrip.tsx:553-629`) — Out of scope (mobile viewport only).

---

## 6. Command, Mention, Skill, PR & Stash Menus

- `[~]` **Trigger detection at caret (all 4 trigger prefixes)** (`composer-logic.ts:251-293` -> `composer/menus.rs:141-162`) — `conn-gpui` only inspects the **end** of the prompt text (`detect_trigger(&text)`) and only supports `/` and `@`. **Drift / Missing:** Conn detects triggers at the **active cursor position** (`detectComposerTrigger(text, cursor)`) and supports 4 triggers: **Wave 1B:** cursor-aware `/`, `@`, `$` with `isPathWord` and `isCurrencyAmountQuery` guards (`menus.rs`, unit-tested). `#` still missing.
  1. `/` — `slash-command` (ignoring path words like `foo/bar` via `isPathWord`)
  2. `@` — `path` (files/folders + threads)
  3. `$` (any Unicode currency symbol `\p{Sc}`) — `skill` (ignoring currency amounts like `$10`, `$3.50` via `isCurrencyAmountQuery`)
  4. `#` (`^#([\p{L}\p{N}][\p{L}\p{N}_-]*)?$`) — `pull-request`
- `[~]` **`/` Slash command menu items & dynamic server catalog** (`useComposerMenuItems.ts:218-299`, `composerSlashCommandSearch.ts:16-113`, `ChatComposer.tsx:1875-1933` -> `composer/menus.rs:63-99`, `composer.rs:1014-1039`, `app.rs:3646-3678`) — `conn-gpui` hardcodes 7 static commands (`clear`, `compact`, `model`, `plan`, `review`, `status`, `usage`) and uses flat substring filtering. **Drift / Missing:**
  - Built-ins in Conn: `/model` (clears token & opens model picker), `/plan` (switches to plan mode & clears token — `conn-gpui` leaves `"/plan "` in textarea AND toggles!), `/default` (switches back to build mode & clears token — missing in `conn-gpui`). Note: `conn-gpui` also accepts `"settle"` in `app.rs:3670` though it's not in `BUILTIN_SLASH_COMMANDS`.
  - **Dynamic provider slash commands**: read from `ServerProvider.slashCommands` resolved for active `gitCwd` (`resolveProviderSlashCommandsForCwd`), gating `/compact` on `compactSlashCommandAvailable` (only at start of empty prompt, no attachments, compactable conversation).
  - **Skills inside `/` menu**: when `showSkillsInSlashMenu` is enabled, include `/skill:<name>` items (`<span class="text-secondary-label">/skill:</span><displayName>`) with `SkillSourceBadge`.
  - **Position-aware filtering**: provider slash commands only appear when `trigger.rangeStart === 0` (message start).
  - **Ranked fuzzy search**: exact -> prefix -> word-boundary -> substring -> fuzzy across name & description (`searchSlashCommandItems`).
  - **Standalone `/plan` and `/default` on Enter**: submitting bare `/plan` or `/default` switches interaction mode without sending a turn (`parseStandaloneComposerSlashCommand`).
- `[~]` **`$` Skills completion menu** (`useComposerMenuItems.ts:300-312`, `ComposerCommandMenu.tsx:183-186,245-250,268-295`, `ChatComposer.tsx:1934-1948`) — Triggered by `$`, lists `ServerProvider.skills` for `gitCwd` (refreshing workspace snapshot on typing with `"Searching workspace skills..."` loading state), displays formatted skill display name + shortDescription/description + `SkillSourceBadge` (`App`=`BlocksIcon`, `Repo`/`Project`=`FolderIcon`, `Personal`=`UserRoundIcon`, `System`=`SettingsIcon`, `Provider`=`PackageIcon` + `" Skill"` suffix). Empty state: `"No skills found. Try / to browse provider commands."` Selecting replaces trigger with `$<skill.name> `. **Wave 1B:** provider skills from `server.getConfig`, ranked search (no fuzzy tier), source badges, empty state, inserts `$<name> `. Workspace snapshot refresh missing.
- `[~]` **`@` File mention menu (icons, stale rejection & thread mentions)** (`useComposerMenuItems.ts:189-217`, `ComposerCommandMenu.tsx:207-223`, `ChatComposer.tsx:1859-1874,1976-1997` -> `composer/menus.rs:265-327`, `composer.rs:1082-1129`) — `conn-gpui` queries `projects.searchEntries` (limit 25), shows generic `file.svg`/`folder.svg` icons, basename + parent path, and replaces with `@path `. **Drift / Missing:**
  - Use `@pierre/trees` file-type icons (`crate::file_icons::file_icon`) instead of generic `file.svg`.
  - Include **matching threads** (`matchComposerThreadItems`, ranked by recency + `useThreadSearch` for settled threads, `MessagesSquareIcon`, inserts inline thread context chip).
  - Reject stale path suggestion clicks if `environmentId`/`cwd`/`query` changed since fetch (`isPathSuggestionCurrent`).
  - Serialize file paths safely for spaces (`serializeComposerFileLink`).
- `[ ]` **`#` Pull Request mention menu** (`useComposerMenuItems.ts:129-186,313-373`, `ComposerCommandMenu.tsx:187-188,224-230`, `ChatComposer.tsx:1949-1975`) — Triggered by `#`, searches GitHub PRs in active project/repo (180ms debounce, linked PRs ranked first, exact `#number` detail lookup fallback, limit 12). Rows show PR state icon + semantic color (`open`/`draft`/`merged`/`closed`), `#number`, and title (or `repo · title`). Loading: `"Finding pull request..."`; empty states for no repo / error / no match (`"No pull request matches <q>."` / `"No pull requests found in this repository."`). Selecting inserts inline PR review-comment context chip.
- `[~]` **Command menu drawer visual attachment & interaction details** (`ComposerCommandMenu.tsx:93-172`, `ComposerCommandMenuLayer.tsx:21-95`, `composerCommandKey.ts:226-241` -> `composer/menus.rs:188-345`, `composer.rs:1890-1950`) — `conn-gpui` floats a detached `dropdown-glass` card `6px` above the composer (`w_full`), handles `Up`/`Down`/`Enter`/`Esc`. **Drift / Missing:**
  - Conn renders the menu as an **attached `ComposerBanner.Surface` drawer** inset by `1.375rem` (`22px`) on both sides and tucked behind the composer top edge (`overlap: 1rem + 1px`), visually unified with banners/stash.
  - **`Tab` key** must also accept the highlighted item (currently only `Enter` does).
  - Highlighted item must **scroll into view** (`scrollIntoView`) during keyboard Up/Down navigation.
  - **Hover updates highlight** (`onMouseMove` sets `menu_highlighted_index` so mouse + keyboard never show two highlights).
  - **Trailing-space dedup** (`extendReplacementRangeForTrailingSpace`): inserting `@file ` before an existing space swallows the duplicate space.
- `[~]` **Prompt Stash shoulder badge (`ComposerStashBadge`)** (`ComposerStashBadge.tsx:7-62`, `ChatComposer.tsx:3227-3232`) — Compact attached shoulder tab (`ml-auto`, right-aligned on top edge of composer) shown whenever `stashQueue.length > 0`: `BookmarkIcon` + `"Stash"` + tabular count (`ComposerBanner.Count`). Replays a subtle CSS pulse animation each time a prompt is stashed (`pulseKey`). Clicking toggles `ComposerStashMenu`. **Wave 1B:** badge with count (`stash.rs`); pulse animation and persistence across restarts missing.
- `[~]` **Prompt Stash drawer (`ComposerStashMenu` + `useComposerStash`)** (`ComposerStashMenu.tsx:32-238`, `useComposerStash.ts:71-720`) — Attached drawer above composer (`BookmarkIcon`, `"Stash"`, count, chevron toggle) listing stashed drafts (persisted across reloads, capped at `MAX_STASH_ENTRIES`): **Wave 1B:** drawer with snippet, attachment counts, relative time, delete, keyboard nav, swap-on-restore; thumbnails and persistence missing.
  - Each row: `FileTextIcon`, truncated 90-char snippet (or `(N images)` / `(N files)` / `(N attachments)` / `(empty)`), pending-save / dropped-images status, up to 3 tiny `16x16` image thumbnails, file count badge (`FileIcon` + count), relative timestamp, and `X` delete button.
  - Keyboard: `↑`/`↓` cycles entries, `Enter` restores highlighted entry (pushing current non-empty draft or swapping cleanly), `⌘Backspace` deletes highlighted entry, `Esc` / outside click closes.
  - Empty state: `"Nothing stashed yet. Press ⌘S with a prompt in the composer to stash it."`
- `[x]` **`Esc` dismisses active menu without re-opening until text changes** (`useComposerTriggerState.ts` -> `composer.rs:533-537,1060-1064`) — `dismissed_trigger_text` suppresses reopening on identical text.
- `[-]` **`/side` and `/btw` slash commands** (`useComposerMenuItems.ts:245-262`, `ChatComposer.tsx:1887-1897`) — Out of scope (`docs/scope.md` `#29 Drop` Side Chats).
- `[-]` **`@machine` linked-environment mentions in `@` menu** (`useComposerMenuItems.ts:200-206`, `ChatComposer.tsx:1998-2017`) — Out of scope (`docs/scope.md` `#1 Orbit` replaces manual peer-link environments).

---

## 7. Banners & Interactive Panels

- `[ ]` **`ComposerBanner` attached surface & `ComposerBannerStack` architecture** (`ComposerBanner.tsx:1-321`, `ComposerBannerStack.tsx:1-224`) — Reusable attached-drawer system tucked behind the composer (`mx-auto w-[calc(100%-44px)] -mb-[17px]`):
  - Variants: `default`, `info`, `success`, `warning` (`warning` tint 8% + border 28%), `error` (`error` tint 8% + border 32%).
  - Stacked consecutive banners join edge-to-edge (no inner border-radius or double borders); grouped deterministically (`environment` first, then `attention`) so banners never jump order.
  - `NoticeText`: detects truncated title/description overflow and automatically adds an `InfoIcon` hover popover showing the full scrollable message.
  - Detached mode (`detached={true}`) for draft hero layout (cards stand below composer so hero doesn't shift).
- `[ ]` **`ComposerPendingUserInputPanel` (interactive agent questions drawer)** (`ComposerPendingUserInputPanel.tsx:30-352`, `ChatComposer.tsx:3197-3225`) — Attached `info` drawer above composer for `ask_question` / `pendingUserInputs`:
  - Collapsible header row: question `header` (and truncated `question` preview when collapsed), `questionIndex+1 / total` counter badge when multi-question, expand/collapse chevron, optional `X` dismiss button (`"Dismiss question without answering"`).
  - Scrollable body (`max-h-[min(24rem,40dvh)]`): Markdown-rendered question text (`ChatMarkdown`).
  - Option list: single-select radio (`OptionRadio`, with optimistic select + **200ms auto-advance** to next question/submit) or multi-select checkbox (`CheckboxMark`), option label + muted description, right-aligned `<Kbd>1</Kbd>`–`<Kbd>9</Kbd>` shortcut badges.
  - Document-level `1`–`9` digit keydown shortcuts when panel is expanded and editor isn't focused.
  - Pairs with `ComposerPrimaryActions` State 1 (`Previous` / `Next question` / `Submit answer(s)`) and editor custom-answer input.
- `[ ]` **`ComposerPlanFollowUpBanner`** (`ComposerPlanFollowUpBanner.tsx:4-20`, `ChatComposer.tsx:3217-3222`) — Attached `info` drawer above composer when a proposed plan is ready: `"Plan ready"` muted label + truncated `planTitle` parsed from plan Markdown. Pairs with `ComposerPrimaryActions` State 2 (`Refine` / `Implement` split button).
- `[~]` **`ComposerPendingApprovalActions` (4 decisions + warnings + composer redirect)** (`ComposerPendingApprovalActions.tsx:13-141`, `ChatComposer.tsx:1187-1194,3419-3422` -> `chat/mod.rs:2013-2094`) — `conn-gpui` only renders inline `"Approve"` (`accept`) and `"Decline"` (`decline`) text links in the timeline row. **Missing:**
  - Dynamic `approval.options` support with `More` (`EllipsisIcon`) menu for `"Always allow this session"` (`acceptForSession`) and `"Cancel"` (`cancel`) (plus any provider-specific approval options).
  - Option warning icon (`TriangleAlertIcon`) + tooltip when an approval option carries `option.warning`.
  - Composer integration: when an approval is active, composer switches placeholder to `"Send feedback to decline this request"` / `"Send a message to decline and redirect the agent"`, forces `followUpBehavior = "steer"`, and submitting declines the approval with the user's redirect feedback.
- `[ ]` **`ChildThreadApprovals` (subagent approval cards above composer)** (`ChildThreadApprovals.tsx:15-95`, `ChatView.tsx:3641`) — Scrollable stack (`max-h-80 mb-2`) directly above `ComposerSurface.Shell` listing pending approvals from child/subagent threads: `"Approval needed from <child title>"`, monospace detail/requestKind, optional `appName`/`reason`/`fullAccessOverrideExplanation`, dead-process warning, inline `ComposerPendingApprovalActions`, and per-card error alert.
- `[ ]` **`QueuedRunsControl` & `useQueuedRunEdit` (queued message list + inline composer edit)** (`QueuedRunsControl.tsx:76-531`, `useQueuedRunEdit.ts:180-360`, `ChatView.tsx:3083-3107`) — Right-aligned dashed-border bubbles (`border-dashed rounded-2xl max-w-[80%]`) for queued turns above the composer:
  - Collapses queues `> 3` items behind `"Show all N queued"` / `"Show fewer"` toggle.
  - Per-item controls: `"Send now"` (`ArrowUpIcon`, tooltip notes `⌘⇧Enter` on first item and whether it starts/steers/skips compaction), `"Edit"` (`PencilIcon`, tooltip notes `⌥↑` on latest item; disabled with reason if a question is open), `"Remove"` (`XIcon`, `"Remove from queue"`), optimistic `"Saving"` (`Clock3Icon`) indicator.
  - Folded headers for Automation (`CalendarClockIcon` + task title + `"Open automation"` link) and Agent (`MessagesSquareIcon` + sender title + `"Open thread"` link) queued turns.
  - **Editing in composer**: clicking Edit loads queued text + existing attachments (`ComposerQueuedAttachmentRow`) into an isolated edit draft (preserving the thread's normal draft!), highlights the bubble (`border-primary/60`) with `"Editing in the composer"` + `"Cancel"` button, switches primary button to `CheckIcon` (`"Update queued message"`), and recovers unsaved edits into the thread draft with a toast if the queued run starts or cancels externally.
- `[ ]` **`WorktreeSetupCard` (worktree bootstrap progress & output)** (`WorktreeSetupCard.tsx:314-394`) — Displays staged worktree creation/setup-script progress (`Setting up worktree…` / `Worktree ready` / `Worktree ready, setup script failed` / `Worktree setup failed` / `Worktree setup cancelled`), per-stage status icon (`Check`/`Spinner`/`X`/`CircleAlert`/`Minus`/`Circle`) + checkout `%` + elapsed timer, 4-line monospace setup-script tail (`OutputTail`), collapsible `Details` (`Branch`, `Base`, `Path`, `Setup`), `"Open terminal"`, `"Work locally"`, and `"Cancel"` buttons.
- `[ ]` **Browser/Device Annotation Watch composer banner (`useAnnotationWatchBanner`)** (`useAnnotationWatchBanner.tsx:17-76`, `ChatView.tsx:2600`) — Attached banner above composer when annotations are active on the thread:
  - Watch active: pulsing green dot (`bg-success`), `"Watching annotations"`, description `"<N> working · <M> waiting · <K> questions"` (or `"Queue empty"` / error), `"Stop"` button.
  - Watch off + unsent waiting annotations: `MessageSquareTextIcon`, `"N annotation(s) waiting"`, `"Send"` button.
- `[ ]` **Local checkout branch mismatch banner (`branchMismatchBannerItem`)** (`ThreadActivityBanners.tsx:250-289`, `BranchToolbar.logic.ts:238-252`, `ChatView.tsx:2693-2703`) — When local checkout moved off the branch the thread last ran on: `GitBranchIcon`, `"Branch changed from <code><threadBranch></code>"` (tooltip: `"This thread last ran on <A>. Sending will continue on <B>."`), `"Restore branch"` / `"Restoring..."` button (confirming if working tree is dirty), and session-scoped dismiss.
- `[~]` **Thread error & offline/reconnecting banners** (`useSystemComposerBanners.tsx:157-215`, `ChatBannerLane.tsx:15-60` -> `chat/mod.rs:1127-1169,2465-2467`) — `conn-gpui` renders a single generic red `error_banner` box above the composer (`rounded(10px)`). **Drift / Missing:**
  - Dedicated offline/reconnecting composer banner (`WifiOffIcon`, `"<Server> is offline"` / `"<Server> is reconnecting"` with reconnect grace delay, diagnosis headline, `"Reconnect"` button).
  - Unify error/warning notices into the attached `ComposerBannerStack` visual system.
- `[-]` **`ComposerUsageLimits` & `modelFallbackBannerItem`** (`ComposerUsageLimits.tsx:47-169`) — Out of scope (`docs/scope.md` `#3 Drop` usage-limit scrapers & load-balancing fallback).
- `[-]` **`UsageLimitRecoveryBanner` (auto-resume at reset / snooze until reset)** (`UsageLimitRecoveryBanner.tsx:26-101`) — Out of scope (`docs/scope.md` `#3 Drop` usage limits & `#9 Drop` snooze).
- `[-]` **`ComposerFeedback` (Codex feedback upload banner)** (`ComposerFeedback.tsx:12-48`) — Out of scope (`docs/scope.md` `#28 Drop` telemetry/feedback export).
- `[-]` **Server self-update & auto-balance update banners (`ComposerServerUpdateStatus`, `useAutoBalanceUpdateBanner`)** (`useSystemComposerBanners.tsx:137,218-263`) — Out of scope (`docs/scope.md` `#1 Orbit` / `#3 Drop` load balancing).
- `[-]` **Enterprise managed policy ceiling banner (`managed-runtime-mode`)** (`ChatComposer.tsx:922-934,2372-2396`) — Out of scope (`docs/scope.md` `#1`/`#27` solo workflow, no cloud/enterprise org policies).

---

## 8. Branch & Permissions Context Strip

- `[~]` **Strip layout, spacing & conditional visibility** (`ComposerSurface.tsx:72-83`, `BranchToolbar.tsx:765-862`, `BranchToolbar.logic.ts:63-76` -> `composer.rs:1223-1468`) — `conn-gpui` always renders a `py(9px) px(6px)` strip with `[Local/Worktree] [Branch]` on the left and `[Plan] [Runtime permissions]` on the right. **Drift:**
  - Conn uses `px-2 pt-2 gap-1 text-xs` (`ComposerSurface.ContextStrip`).
  - On **started threads**, Conn shows `[Workspace mode]` on left and `[PR badge] [Branch picker]` on right (NO Plan button and NO Runtime permissions dropdown in the strip — those live in the composer footer & model picker footer!).
  - On **new-thread drafts**, Conn shows `[Workspace mode]` on left, `[Branch picker]` pushed right, and trailing `[ComposerContextPermissions]` at the far right (`ms-auto`).
  - Strip hides on started threads when not a git repo (and no environment indicator).
- `[~]` **Workspace mode selector (`BranchToolbarEnvModeSelector` + `workspaceOptions.tsx`)** (`BranchToolbarEnvModeSelector.tsx:132-296`, `workspaceOptions.tsx:51-151`, `BranchToolbar.logic.ts:91-112` -> `composer.rs:1238-1296`) — `conn-gpui` only has a 2-state click toggle (`Local` <-> `Worktree`) on drafts and static text on started threads. **Drift / Missing:**
  - Proper dropdown menu (`Select` / `"Workspace"` group header, `⌘⇧X`) with exact Conn labels & icons:
    - `"Current checkout"` (`FolderIcon`) or `"Current worktree"` (`FolderGitIcon`)
    - `"New worktree"` (`FolderGit2Icon`) — locked with `"Each model starts in its own worktree."` tooltip during multi-model draft
    - `"Previous worktree"` (`HistoryIcon` + middle-truncated branch subtitle via `PreviousWorktreeItemContent.tsx`) — reuses the project's most recently updated non-archived worktree thread (`resolvePreviousWorktreeSeed`)
    - `"New Orbit instance"` (`OrbitLogoIcon` + async availability check note `"Checking Orbit…"` / unavailable reason; orbit-only project folders hide local/worktree)
  - Locked display on started threads: `"Local checkout"` / `"Worktree"` / `"New worktree"` with tooltip, plus right-click context menu `"Copy full path"` (`showWorkspaceContextMenu`).
- `[ ]` **Orbit instance status chip & URL pill in strip** (`BranchToolbarEnvModeSelector.tsx:34-114,165-197`) — For threads running in an Orbit instance, show `OrbitLogoIcon` + `"Orbit: setting up"` / `"Orbit: not registered"` / `"Orbit: <subdomain>"` with path tooltip, clickable `OrbitInstanceUrlChip` (`GlobeIcon` + host pill, tooltip `"Open <url>"`, opens in Browser panel), and `"Retry"` button on registration failure.
- `[~]` **Interactive Branch Picker (`BranchToolbarBranchSelector` + `BranchPicker`)** (`BranchToolbarBranchSelector.tsx:98-752`, `BranchPicker.tsx:23-287`, `BranchToolbar.logic.ts:192-314` -> `composer.rs:1298-1309`) — `conn-gpui` only prints the static `thread_branch` string next to `branch.svg` (non-clickable!). **Missing:**
  - Clickable trigger (`ComposerControl size="xs"`, `⌘⇧G`) with `GitBranchIcon` + middle-truncated label (`MiddleTruncate`):
    - Existing checkout/worktree: `<branch>` (or `"Select ref"` if none)
    - New worktree draft: `"From <branch>"` or `"From <branch> (remote)"` when `startFromOrigin` is on for a local branch
  - Popover (`w-80`, `side="top" align="end"`):
    - Search input (`"Search refs..."`, sanitizes spaces via `sanitizeNewRefName`)
    - Paginated virtualized ref list (`vcs.listRefs` infinite scroll, status footer `"Loading refs..."` / `"Loading more refs..."` / `"Showing X of Y refs"`, empty `"No refs found."`)
    - Per-ref badges: `current`, `worktree`, `remote`, `default` (`text-3xs text-muted-foreground/45`)
    - Selecting a ref: sets base branch (new worktree), reuses existing worktree if ref is checked out in one, or calls `vcs.switchRef` with optimistic UI + error toast (stops session if worktree path changes)
    - **`"Start from remote"` switch** (`RefreshIcon` + `Switch` + explanatory tooltip) at bottom of picker when picking a new-worktree base branch
    - **Inline branch creation**: typing a non-matching name shows `"Create new ref \"<sanitized>\""` -> calls `vcs.createRef` with `switchRef: true`
    - **PR checkout from branch search**: pasting a GitHub PR URL / `#123` shows `"Checkout Pull Request"` (`SourceControlIcon` + ref) -> triggers PR checkout flow
    - **Right-click context menu** on trigger or any ref item: `"Copy branch name"` with toast confirmation
- `[ ]` **Linked Pull Request badge in context strip (`ThreadPullRequestBadgeControl`)** (`BranchToolbarBranchSelector.tsx:535-569,686-699`) — Directly left of the branch picker trigger, show the thread's linked or branch-detected GitHub PR badge (`#123` + state icon/color, or multi-PR count badge); clicking opens the Pull Request right-panel tab or PR list.
- `[~]` **Trailing `ComposerContextPermissions` on new-thread drafts** (`ComposerContextPermissions.tsx:12-41`, `ChatView.tsx:3885-3899` -> `composer.rs:1351-1436`) — On new-thread drafts, show a compact `xs` button (`ms-auto`) with the mode's specific icon (`LockIcon`/`PenLineIcon`/`SparklesIcon`/`ShieldOffIcon`, NOT generic `shield.svg`) + mode label (`"Supervised"` / `"Auto-accept edits"` / `"Auto"` / `"Full access"` — note `conn-gpui` says `"Accept edits"` instead of `"Auto-accept edits"`!), tooltip `"Permissions · ⌘⇧A"`, clicking opens `ComposerPermissionsSection`.
- `[ ]` **Responsive context strip label collapse** (`BranchToolbar.tsx:452-611,768`, `ComposerContextLabel.tsx:6-36`, `BranchToolbar.logic.ts:78-89`) — When the strip narrows below natural width, smoothly collapse text labels (`max-w-0 opacity-0`, `180ms`) to icon-only with `16px` expand hysteresis (`CONTEXT_STRIP_COMPACT_EXPAND_HYSTERESIS_PX`) so labels never clip or flap.
- `[ ]` **Narrow-width merged `RunContextSelector` menu** (`BranchToolbar.tsx:169-450,771-795`) — Below `@xl/composer-surface`, merge workspace controls cleanly inside a constrained `max-w-[48%]` trigger.
- `[-]` **`BranchToolbarEnvironmentSelector` ("Run on" multi-machine / "Add to another machine" / "Auto balance")** (`BranchToolbarEnvironmentSelector.tsx:38-173`, `BranchToolbar.tsx:336-422,804-823`) — Out of scope (`docs/scope.md` `#1 Orbit` manages Nodes/Instances at shell/settings level; `#3 Drop` load balancing).
- `[-]` **Custom branch naming template settings** (`settings/BranchNamingSettings.tsx`) — Out of scope (`docs/scope.md` `#12 Subset` Drop custom branch-naming template UI).
- `[-]` **GitLab terminology / MR checkout in branch picker** (`BranchToolbarBranchSelector.tsx:277-280`) — Out of scope (`docs/scope.md` `#23 Subset` GitHub only).

---

## 9. Keyboard Shortcuts & Focus

- `[x]` **`Enter` / `Shift+Enter` submit vs newline** (`composer-logic.ts:85-92` -> `composer.rs:205,214-220`) — Bare `Enter` submits (or confirms active menu); `Shift+Enter` inserts newline.
- `[x]` **`Esc` overlay dismissal hierarchy (partial)** (`composer.rs:1890-1904`) — Cancels active Operator dictation first, else closes open model/effort/runtime/command/mention overlays.
- `[~]` **Overlay navigation keys (`Up`/`Down`/`Enter`/`Tab`)** (`composerCommandKey.ts:226-241` -> `composer.rs:1905-1925`) — `Up`/`Down`/`Enter` work for model picker and `/`+`@` menus. **Drift:** Missing `Tab` to accept command/mention suggestion, missing `Up`/`Down`/`Enter` inside effort & runtime menus, missing `ArrowLeft`/`ArrowRight` across model picker sidebar ↔ search ↔ effort column.
- `[ ]` **Configurable `sendShortcut` setting (`enter` / `mod-enter` / `mod-enter-multiline`)** (`composer-logic.ts:49-93`) — Support `"enter"`, `"mod-enter"` (`⌘Enter` to send, `Enter` for newline), and `"mod-enter-multiline"` (`Enter` sends single-line, `⌘Enter` sends multi-line).
- `[ ]` **`⌘Enter` alternate follow-up dispatch (`composer.sendAlternate`)** (`keybindings.ts:184`, `composer-logic.ts:82`, `composerCommandKey.ts:245-256`) — While a turn is running, `⌘Enter` submits with the alternate dispatch mode (queues if default is steer; steers if default is queue).
- `[ ]` **`⌘Enter` / `⌘⌥Enter` send in background & send-and-new-thread** (`keybindings.ts:185-199`, `composer-logic.ts:83-84`) — On draft thread, `⌘Enter` / `⌘⌥Enter` launches thread in background; on active thread, `⌘⌥Enter` sends and opens a new thread.
- `[ ]` **`Shift+Tab` toggle Plan / Build mode** (`composerCommandKey.ts:211-216`) — Inside composer editor, `Shift+Tab` outdents list item if in a list, otherwise toggles Plan/Build interaction mode (when `planModeUiEnabled`).
- `[ ]` **`⌘⇧M` toggle model picker (`modelPicker.toggle`)** (`keybindings.ts:205`, `composerShortcuts.ts:18-20`) — Opens/closes the docked model picker from anywhere outside terminal.
- `[ ]` **`⌘⇧E` open model picker directly to Effort column (`composer.effort`)** (`keybindings.ts:207`, `composerShortcuts.ts:28`, `composerEventScope.ts:78-93`) — Opens model picker (or jumps within it if already open) and focuses the active effort level radio.
- `[ ]` **`⌘⇧A` open Permissions menu (`composer.mode`)** (`keybindings.ts:208`, `composerShortcuts.ts:29`, `composerEventScope.ts:55-72`) — Opens whichever control owns permissions (context strip on draft, footer chip if overridden, overflow menu, or model picker footer Permissions submenu) and focuses the checked permission segment.
- `[ ]` **`⌘⇧X` open Workspace mode menu (`composer.workspace`)** (`keybindings.ts:209`, `composerShortcuts.ts:30`) — Opens Local/Worktree/Orbit/Previous worktree selector.
- `[ ]` **`⌘⇧G` open Branch picker (`composer.branch`)** (`keybindings.ts:210`, `composerShortcuts.ts:31-33`) — Opens branch combobox and focuses `"Search refs..."`.
- `[ ]` **`⌘⇧L` switch to Previous worktree (`composer.previousWorktree`)** (`keybindings.ts:211`, `composerShortcuts.ts:34-36`) — Immediately selects the project's most recent worktree and refocuses composer.
- `[ ]` **`⌘S` stash prompt (`composer.stash`)** (`keybindings.ts:181`, `useComposerStash.ts`) — Stashes current composer draft into stash queue (or opens stash menu if empty).
- `[ ]` **`⌘⇧Enter` steer next queued message (`thread.steerQueuedMessage`)** (`keybindings.ts:182`, `QueuedRunsControl.tsx:186-191`) — Promotes the first queued message to steer / send immediately.
- `[ ]` **`⌥↑` edit latest queued message (`thread.editQueuedMessage`)** (`keybindings.ts:183`, `QueuedRunsControl.tsx:193-214`) — Loads the most recent queued message into the composer for editing.
- `[ ]` **`⌘⇧↑` / `⌘⇧↓` cycle provider tabs & `⌘1`–`⌘9` jump to model in open model picker** (`keybindings.ts:213-214,227-231`, `ModelPickerContent.tsx:780-834`) — Fast keyboard provider switching and numeric model selection while picker is open.
- `[ ]` **`↑` / `↓` sent prompt history recall** (`composerCommandKey.ts:139-180`, `composerPromptHistory.ts:73-161`) — On empty prompt (or while browsing recalled history) with caret at visual start/end and no attachments/questions, `↑`/`↓` walks prior user-typed messages in the thread (stripping Ultrathink prefix, review comments, and inline context references).
- `[ ]` **`1`–`9` digit shortcuts for pending user-input question options** (`ComposerPendingUserInputPanel.tsx:151-177`) — Selecting question options 1–9 via bare digit keys when editor isn't focused.
- `[ ]` **`PageUp` / `PageDown` timeline scroll passthrough** (`ComposerPromptEditorTiptap.tsx:1780-1816`) — When the composer editor cannot scroll vertically, `PageUp`/`PageDown` scroll the conversation timeline while keeping focus in the composer.
- `[ ]` **Type-to-focus & Paste-to-focus composer redirect** (`composerFocusRedirect.ts:62-87`, `useChatShortcuts.ts:76-85`, `usePasteToFocusComposer.ts:15-56`) — Typing a printable character or pressing `⌘V` while the timeline or non-interactive chrome has focus (and no modal/popup/terminal/browser/secret-input is active) automatically focuses the composer and inserts/pastes at the end.
- `[~]` **Focus restoration on closing composer popups (`finalFocus`)** (`composerEventScope.ts:12-28` -> `composer.rs:519-541,971-1012`) — Picking a model or pressing `Esc` in `conn-gpui` closes the popup without explicitly returning keyboard focus to the composer textarea. Conn restores focus to the editor end whenever a composer menu/picker closes.
- `[ ]` **`⌘⇧V` paste-as-text shortcut** (`ChatComposer.tsx:1076-1121`, `usePasteToFocusComposer.ts:23-30`) — Arms a 1-second bypass for large-text folding and image inline chip insertion.
- `[-]` **User-customizable `keybindings.json` rule editor & migration engine** (`apps/server/src/keybindings.ts`) — Out of scope (`docs/scope.md` `#13 Subset` Drop custom keybindings editor).
- `[-]` **`⌘⇧H` / `composer.host` & `composer.cycleHost` environment host selector shortcut** (`keybindings.ts:206`, `composerShortcuts.ts:27`) — Out of scope (`docs/scope.md` `#1 Orbit` manages Nodes/Instances outside the composer strip).

---

## Prioritized Porting Batches

All `[ ]` and `[~]` items grouped into parallel-safe implementation chunks aligned with `conn-gpui`'s crate boundaries (`conn-state`, `conn-client`, `conn-app`):

### Batch 1 — Composer Core State & Data Models (`crates/conn-state` — GPUI-free, parallel-safe)
1. **Per-thread / per-draft `ComposerDraftStore`** (prompt text, attachments, terminal/review/annotation/thread contexts, sticky per-provider-model options, queued-edit draft isolation).
2. **Prompt Stash state & persistence** (`PromptStashEntry`, max cap, snippet formatter, stash/restore/delete reducers).
3. **Trigger & command search logic** (`detectComposerTrigger` at cursor for `/`, `@`, `$`, `#`; currency/path-word guards; `searchSlashCommandItems` fuzzy ranking; `slashCommandItemsForPromptPosition`; `parseStandaloneComposerSlashCommand`; `extendReplacementRangeForTrailingSpace`).
4. **Prompt history recall & typing guard state machines** (`composerPromptHistory.rs`, `composerTypingGuard.rs` 1500ms hold).
5. **Context window & resume-compaction logic** (`ContextWindowSnapshot`, token/percentage/cost formatters, `shouldOfferResumeCompaction`, `resolveCompatibleRuntimeMode`, `resolveComposerControlsOwnership`).
6. **Prompt length & attachment validation helpers** (`PROVIDER_SEND_TURN_MAX_INPUT_CHARS`, `PROVIDER_SEND_TURN_MAX_ATTACHMENTS`, `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES`, large-paste folding disposition).

### Batch 2 — Docked Model & Effort Picker + Footer Controls Parity (`crates/conn-app/src/chat/composer/model_picker.rs` + `composer.rs`)
1. **Unified Model + Effort trigger** (`EffortGlyph` sharp rising bars + word mode + `FastBolt` + context window suffix + `Unavailable` badge + multi-model stacked icons + combined tooltip).
2. **Docked 2-column Model Picker popup**:
   - Left: `ModelPickerSidebar` (Favorites star tab + divider + provider icons + locked-provider disabled tooltips + animated indicator) + ranked search + `ModelListRow` (right-aligned check, hover favorite star, `⌘1`–`⌘9` badges, `Unavailable`/`New`, legacy `"Show more"`/`"Show less"` toggle, update/setup notices).
   - Right: docked `ComposerEffortColumn` (`w-48`, reasoning radios + descriptions + Ultrathink lock note + `OptionMenuRow` side menus + `OptionSwitchRow` toggles).
   - Bottom: `ComposerPickerFooter` (`SpeedControl` Standard/Fast/Ultrafast segmented radio + `PermissionsMenu`).
   - Full keyboard navigation (`ArrowLeft`/`ArrowRight`, `⌘⇧↑`/`⌘⇧↓`, `⌘1`–`⌘9`, `Shift+Click`/`Shift+Enter` multi-model).
3. **Footer Mode & Permissions Controls**:
   - Move Plan/Build toggle (`PencilRulerIcon` / `BotIcon`) from bottom strip into composer footer (`ComposerFooterModeControls`).
   - Add conditional footer Permissions chip (hidden when matching default) + `ComposerPermissionsSection` 4-segment horizontal radio with live hover/focus preview (`Supervised`, `Auto-accept edits`, `Auto`, `Full access`).
   - Add `CompactComposerControlsMenu` (`...`) responsive overflow for narrow panes.
   - Add `ContextWindowMeter` circular SVG ring + hover popover + manual `"Compact context"` trigger.
   - Add `"Open provider settings"` unavailable fallback button.

### Batch 3 — Primary Action State Machine & Banners / Interactive Panels (`crates/conn-app/src/chat/composer/banners.rs` + `composer.rs` + `chat/mod.rs`)
1. **Reusable `ComposerBanner` & `ComposerBannerStack`** (attached tucked surfaces, `default`/`info`/`success`/`warning`/`error` variants, `environment` vs `attention` grouping, `NoticeText` overflow popover).
2. **`ComposerPrimaryActions` complete state machine**:
   - Pending question actions (`Stop` + `Previous` + `Next question` / `Submit answer(s)` / `Submitting...`)
   - Plan follow-up (`Refine` / split `Implement` + `Implement in a new thread`)
   - Resume (`PlayIcon` + `useComposerResume` flow)
   - Editing queued message (`CheckIcon`)
   - Dual Steer/Queue dispatch while running (`CornerUpRight` vs `ListPlus`, `⌘`-click / `⌘Enter` alternate toggle, dynamic tooltip)
   - Compact-before-send pill (`Minimize2Icon` + `Compact`/`Keep` + token count)
   - Busy spinner & exact disabled-reason tooltips
3. **Interactive Composer Drawers & Banners**:
   - `ComposerPendingUserInputPanel` (collapsible header, Markdown question, radio 200ms auto-advance / multi-select checkboxes, `1`–`9` shortcuts, dismiss, custom-answer editor lock)
   - `ComposerPlanFollowUpBanner` (`"Plan ready"` + title)
   - `ComposerPendingApprovalActions` (full option list + `More` menu for `Always allow this session` / `Cancel` + warnings + composer redirect-on-send) & `ChildThreadApprovals`
   - `QueuedRunsControl` + inline composer edit (`Send now`, `Edit`, `Remove`, collapse >3, `ComposerQueuedAttachmentRow`, external-cancel recovery)
   - `WorktreeSetupCard` (staged progress, 4-line setup-script tail, `Details`, `Open terminal`, `Work locally`, `Cancel`)
   - `useAnnotationWatchBanner` (Watching / Waiting annotations banner)
   - `branchMismatchBannerItem` (`"Branch changed from <branch>"` + `"Restore branch"`)
   - Offline/reconnecting system banner (`WifiOffIcon` + `"Reconnect"`)
   - `ComposerPromptLengthValidation` inline alert
   - `ProviderSubagentBar` (read-only bar on subagent threads) & centered `DraftHeroHeadline` (searchable project combobox + Scratch mode)

### Batch 4 — Menus (`/` · `@` · `$` · `#`) & Prompt Stash (`crates/conn-app/src/chat/composer/menus.rs` + `stash.rs`)
1. **Attached drawer chrome** matching `ComposerBanner.Surface` (`22px` side inset, scroll-into-view on keyboard nav, mouse-hover highlight sync, `Tab` + `Enter` acceptance, trailing-space dedup).
2. **Dynamic `/` menu**: `/model`, `/plan`, `/default` (clears token cleanly on mode switch), `ServerProvider.slashCommands` (start-of-prompt only, `/compact` gated), `/skill:<name>` with `SkillSourceBadge`, fuzzy ranked search.
3. **`$` Skills menu**: `ServerProvider.skills` + workspace snapshot refresh + `SkillSourceBadge`.
4. **`@` Mentions upgrade**: `@pierre/trees` file icons, matching thread items (`MessagesSquareIcon`), stale-query rejection, space-safe serialization.
5. **`#` Pull Requests menu**: debounced GitHub PR search, linked PR priority, exact `#number` lookup, state icons/tones.
6. **Prompt Stash**: `ComposerStashBadge` shoulder tab (with pulse) + `ComposerStashMenu` drawer (`↑`/`↓`/`Enter`/`⌘Backspace`/`Esc`, thumbnails, file counts, relative timestamps) + `⌘S`.

### Batch 5 — Attachments, Paste/Drop & Rich Editor Polish (`crates/conn-app/src/chat/composer/attachments.rs` + `editor.rs`)
1. **Split Media Row & File List**: `64x64` image & video thumbnails (first-frame poster + `PlayIcon`), click-to-expand lightbox, `ComposerFilePreviewDialog` for non-media files, live upload `%`, failed-upload `Retry` button + reason tooltip, non-persisted / needs-reattach indicators.
2. **Attachment intake hardening**: max count/size/MIME validation, client-side image compression + preparing placeholder tiles, large-paste auto-folding into `.txt` + `⌘⇧V` paste-as-text bypass, folder drop -> `@folder`, sidebar thread drop -> context chip/transcript, mention/PR drop + composer drop-ring highlight, confirm dialog when removing inline-referenced image.
3. **Editor ergonomics**: dynamic context placeholders, inline atomic context chips (file, skill, terminal, review/PR, annotation, thread, citation), context undo/redo retention, Ultrathink frame glow, Markdown code-block & list continuation shortcuts.

### Batch 6 — Keyboard Shortcuts & Focus Polish (`crates/conn-app/src/chat/composer.rs` + `app.rs`)
1. **Branch & Permissions Context Strip**:
   - Interactive `BranchToolbarEnvModeSelector` (`Current checkout` / `New worktree` / `Previous worktree` / `New Orbit instance` + Orbit status/URL chip + `"Copy full path"` context menu).
   - Interactive paginated `BranchToolbarBranchSelector` (`BranchPicker`, `From <branch> (remote)`, `"Start from remote"` switch, inline `"Create new ref"`, `"Checkout Pull Request"`, `"Copy branch name"` context menu) + adjacent `ThreadPullRequestBadgeControl`.
   - Trailing `ComposerContextPermissions` on drafts + responsive label collapse with 16px hysteresis.
2. **Complete composer shortcut suite**: `Shift+Tab`, `⌘⇧M`, `⌘⇧E`, `⌘⇧A`, `⌘⇧X`, `⌘⇧G`, `⌘⇧L`, `⌘S`, `⌘Enter` (alternate steer/queue or background draft), `⌘⌥Enter`, `⌘⇧Enter` (steer queued), `⌥↑` (edit queued), `↑`/`↓` prompt history recall, `1`–`9` pending question digits, `PageUp`/`PageDown` timeline scroll passthrough, configurable `sendShortcut`, type-to-focus & paste-to-focus redirect, and `finalFocus` restoration to editor on every popup close.
