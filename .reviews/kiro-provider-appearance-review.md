# Review: Kiro Provider + Appearance

## Project context

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| **Repository** | `declancowen/t3code`                     |
| **Remote**     | `origin`                                 |
| **Branch**     | `main`                                   |
| **Stack**      | TypeScript, Effect, React/Vite, Electron |

## Scope

- `apps/server/src/provider/acp/StandardAcpAdapter.ts` — ACP prompt lifecycle and active-prompt steering.
- `apps/server/src/provider/Layers/KiroAdapter.ts` — Kiro `_message/send` payload mapping.
- `packages/effect-acp/src/protocol.ts` — ACP JSON-RPC transport compatibility for provider-originated requests.
- `apps/server/src/provider/acp/AcpAdapterSupport.ts`, `apps/server/src/provider/acp/AcpRuntimeModel.ts` — ACP permission outcome mapping and tool-call classification.
- `apps/server/src/provider/acp/StandardAcpAdapter.test.ts` — ACP steering regression coverage.
- `apps/web/src/components/ChatView.tsx` — running-turn image send guard removal.
- `apps/web/src/components/AppSidebarLayout.tsx`, `apps/web/src/components/NoActiveThreadState.tsx`, `apps/web/src/index.css`, `apps/web/src/routes/*` — sidebar/background appearance changes.
- `assets/*`, `apps/*/public/*`, `apps/desktop/resources/*` — generated app icon assets.

## Hotspots

- ACP active-turn lifecycle ownership and duplicate `session/prompt` prevention.
- Kiro cancel behavior because Kiro currently rejects `session/cancel`.
- ACP permission requests with provider-owned UUID request IDs and provider-owned option IDs.
- Active-prompt steering payload compatibility for text and image attachments.
- Running-turn UI send behavior across provider adapters.
- Sidebar/translucency surface consistency across route wrappers.
- macOS app icon visual bounds, corner radius, and generated package assets.

## Review status

| Field                 | Value                |
| --------------------- | -------------------- |
| **Review started**    | 2026-05-20           |
| **Last reviewed**     | 2026-05-21 07:08 BST |
| **Total turns**       | 8                    |
| **Open findings**     | 0                    |
| **Resolved findings** | 6                    |
| **Accepted findings** | 0                    |

## Turn 8 — 2026-05-21 07:08 BST

| Field           | Value        |
| --------------- | ------------ |
| **Commit**      | working tree |
| **IDE / Agent** | Codex        |

**Summary:** Re-reviewed the full local diff after the Kiro ACP permission/stop fixes, send/icon/sidebar polish, and the corrected macOS-style app icon corner radius.
**Outcome:** No findings.
**Risk score:** High — this turn touches the shared ACP transport, shared ACP adapter lifecycle, provider-specific Kiro behavior, and generated release assets.
**Change archetypes:** protocol compatibility, provider lifecycle, permission mapping, visual asset replacement, shared UI presentation.
**Intended change:** Keep Kiro steering as active-prompt `_message/send`, make Kiro tool approvals complete by preserving UUID JSON-RPC request IDs and provider option IDs, make Stop actually stop Kiro when `session/cancel` is unsupported, and refresh the generated app icon assets with a rounder macOS-style boundary.
**Intent vs actual:** The diff matches the intent. Steering remains isolated to `sendMessageWhilePromptActive` in `KiroAdapter` and is not routed through the stop fallback. The stop fallback is Kiro opt-in only through `stopSessionOnInterruptCancelUnsupported`. Permission responses now use provider-supplied option IDs, and the ACP transport preserves non-numeric request IDs without making Kiro-specific protocol branches.
**Confidence:** High for protocol/unit behavior and package output; medium for final visual preference until the rebuilt DMG is inspected in Finder/Dock.
**Coverage note:** Targeted ACP protocol, ACP adapter, ACP runtime-model, sidebar, and composer tests passed. Full `bun fmt`, `bun lint`, `bun typecheck`, and `git diff --check` passed. Electron macOS arm64 packaging passed and rebuilt the DMG/ZIP artifacts.
**Finding triage:** No open findings. The main suspected issues were checked directly: Kiro Stop no longer depends on Kiro honoring `session/cancel`, and active-prompt send/attachment steering stays on the `_message/send` path.
**Architecture impact:** The protocol fix lives in `effect-acp` as transport compatibility, not in the Kiro provider. Shared ACP adapter behavior remains opt-in for providers that cannot cancel. Kiro-specific wiring is limited to the existing Kiro adapter layer. UI polish stays in owning sidebar/composer helpers and source icon assets.
**Bug classes / invariants checked:** nonnumeric JSON-RPC IDs round-trip; provider permission option IDs are honored; missing ACP tool kinds are inferred conservatively; Kiro Stop closes the ACP session after cancel write/failure; project row toggle behavior remains after chevron removal; generated icons preserve expected formats and dimensions.
**Branch totality:** Reviewed all local changes in the dirty tree. The branch is still local and dirty on `main`, one commit behind `origin/main`.
**Sibling closure:** Rechecked shared ACP transport/client tests, ACP adapter tests, Cursor adapter permission mapping, Kiro adapter active-prompt send path, provider runtime ingestion of `session.exited`, sidebar status helpers, composer primary action rendering, and desktop/web/marketing icon targets.
**Residual risk / unknowns:** The local dev server must be restarted before live Kiro Stop reflects this patch. Kiro Stop now terminates the Kiro ACP session because Kiro does not support a soft `session/cancel`; a fresh Kiro session may be needed after stopping.

### Validation

- `bun --filter t3 test src/provider/acp/AcpRuntimeModel.test.ts src/provider/acp/AcpAdapterSupport.test.ts src/provider/acp/StandardAcpAdapter.test.ts` — passed, 19 tests.
- `bun --filter effect-acp test src/client.test.ts src/protocol.test.ts` — passed, 15 tests.
- `bun --filter @t3tools/web test src/components/Sidebar.logic.test.ts src/components/chat/ComposerPrimaryActions.test.ts src/components/ui/sidebar.test.tsx` — passed, 59 tests.
- `bun fmt` — passed.
- `bun lint` — passed with 9 existing warnings.
- `bun typecheck` — passed, 13 packages.
- `git diff --check` — passed.
- `file`, `sips`, and `iconutil -c iconset` checks verified updated desktop/web/marketing icon file types and dimensions.
- `bun run dist:desktop:dmg:arm64` — passed after rerunning outside the sandbox temp-dir restriction; rebuilt `release/T3-Code-0.0.24-arm64.dmg` and `.zip`.

### Branch-totality proof

- **Non-delta files/systems re-read:** diff-review gates, architecture-standards build-mode guidance, ACP transport protocol tests, ACP adapter/runtime helpers, Kiro adapter, Cursor adapter, sidebar helpers, composer primary actions, brand asset outputs.
- **Prior open findings rechecked:** No open findings remained from Turn 7. The new Kiro stop regression was handled and covered.
- **Prior resolved/adjacent areas revalidated:** Running composer remains stop-only visually while the send/steer path is still available through active-prompt dispatch. Generated icon assets were refreshed again after the radius change.
- **Hotspots or sibling paths revisited:** Provider approval request handling, active prompt send hook, interrupt/stop path, JSON-RPC request ID translation, project row toggle handlers, status color aggregation, macOS `.icns` decode.
- **Why this is enough:** The risky runtime changes are covered by focused unit tests in both the shared transport and server adapter layers, and the generated assets were validated by type/dimension/package checks.

### Challenger pass

Done — the most plausible miss was conflating Stop with steering. The code paths are separate: active-prompt user messages go through Kiro `_message/send`, while only `interruptTurn` uses the Kiro opt-in session-stop fallback.

### Resolved / Carried / New findings

- None.

### Recommendations

1. **Fix first:** none.
2. **Then address:** restart the local backend/web process before live-testing Kiro Stop, because the old server process will still have the old adapter behavior.

## Turn 7 — 2026-05-21 06:24 BST

| Field           | Value        |
| --------------- | ------------ |
| **Commit**      | working tree |
| **IDE / Agent** | Codex        |

**Summary:** Re-reviewed the full local diff after the app icon inset, repo-list chevron removal, send-icon centering adjustment, and Lobster-colored working indicator.
**Outcome:** No findings.
**Risk score:** Medium — this is presentation and generated asset work across desktop/web/marketing targets, with shared sidebar status logic touched, but no provider runtime or hook architecture changes.
**Change archetypes:** visual asset replacement, shared UI presentation, sidebar thread-status logic.
**Intended change:** Make the packaged app icon visually match normal Dock icon sizing, remove the visible project/repo chevron without removing row toggle behavior, center the send icon, and make the active working marker use the Lobster primary color.
**Intent vs actual:** The diff matches the stated intent. The project row click/keyboard handlers remain in place after removing the chevron. `resolveThreadStatusPill` still owns thread status presentation and now maps only the `Working` state to `text-primary`/`bg-primary`. The app icon source SVGs now keep transparent outer padding and all generated icon targets were refreshed.
**Confidence:** High for code behavior and asset file validity; medium for final visual preference until the rebuilt Electron app is inspected in the Dock.
**Coverage note:** Targeted sidebar/composer/brand tests passed, full repo fmt/lint/typecheck passed, generated icon formats and dimensions were checked, and the Electron macOS arm64 artifacts were rebuilt.
**Finding triage:** No open findings. The previous provider/ACP and CORS hotspots are unchanged by this turn.
**Architecture impact:** Presentation behavior remains in the existing owning components/helpers: sidebar status policy in `Sidebar.logic`, project row rendering in `Sidebar`, and composer primary action rendering in `ComposerPrimaryActions`. Provider hooks/adapters and ACP runtime architecture are untouched.
**Bug classes / invariants checked:** project row remains toggleable without visual chevron; working status priority and folded project indicator still flow through shared status logic; send button still uses the existing submit path; icon assets preserve expected public dimensions while reducing opaque alpha bounds.
**Branch totality:** Reviewed all local changes in the dirty tree. The branch is still local and dirty on `main`, which is one merge commit behind `origin/main` but had no tree delta from origin before these edits.
**Sibling closure:** Checked sidebar project header, hidden-thread status label path, command-palette thread status consumers, composer primary action path, web/marketing/desktop icon targets, and brand asset tests.
**Residual risk / unknowns:** The browser visual smoke for the sidebar row itself was not rerun in this turn; the packaged app was rebuilt for Dock-icon inspection.

### Validation

- `bun run test src/components/Sidebar.logic.test.ts src/components/chat/ComposerPrimaryActions.test.ts src/components/ui/sidebar.test.tsx` — passed, 59 tests.
- `bun run test lib/brand-assets.test.ts` — passed, 5 tests.
- `bun fmt` — passed.
- `bun lint` — passed with 9 existing warnings.
- `bun typecheck` — passed, 13 packages.
- `git diff --check` — passed.
- `file` and `sips` checks verified updated desktop/web/marketing icon file types and dimensions.
- Alpha-bounds check verified `assets/prod/black-macos-1024.png` opaque content is inset to `832x832` within the `1024x1024` canvas.
- `bun run dist:desktop:dmg:arm64` — passed after rerunning outside the local packaging temp-dir restriction; rebuilt `release/T3-Code-0.0.24-arm64.dmg` and `.zip`.

### Branch-totality proof

- **Non-delta files/systems re-read:** diff-review gates, architecture-standards build-mode guidance, `ThreadStatusIndicators`, `Sidebar.logic`, `Sidebar`, `ComposerPrimaryActions`, brand asset outputs.
- **Prior open findings rechecked:** No open findings remained. Provider hook and ACP adapter paths are untouched by this turn.
- **Prior resolved/adjacent areas revalidated:** Running composer behavior remains stop-only visually while submit behavior is unchanged outside this visual icon edit.
- **Hotspots or sibling paths revisited:** Project row toggle handlers, status priority aggregation, compact status label, generated macOS/Windows/web icon targets.
- **Why this is enough:** The changed code is narrow presentation logic with direct unit coverage; binary asset changes were regenerated from the source SVGs and checked for validity/dimensions; desktop packaging succeeded.

### Challenger pass

Done — the main plausible miss was removing the chevron in a way that also removed expand/collapse affordance behavior. The row's click and keyboard toggle handlers remain wired, and tests still cover sidebar UI primitives.

### Resolved / Carried / New findings

- None.

### Recommendations

1. **Fix first:** none.
2. **Then address:** inspect the rebuilt DMG in the Dock to confirm the new icon inset has the desired visual size.

## Turn 6 — 2026-05-21 05:45 BST

| Field           | Value        |
| --------------- | ------------ |
| **Commit**      | working tree |
| **IDE / Agent** | Codex        |

**Summary:** Re-reviewed the full current local diff after the new icon and chat UI adjustments, including staged CORS/auth changes and unstaged branding/chat presentation changes.
**Outcome:** All clear after restoring the `ProjectFavicon` rendering invariant.
**Risk score:** Medium — the current tree spans browser auth headers, app branding assets, and chat composer/timeline presentation, but the high-risk provider lifecycle paths remain unchanged by this turn.
**Change archetypes:** auth/API contract, visual asset replacement, chat presentation behavior, shared UI rendering.
**Intended change:** Keep credentialed browser auth working, preserve Kiro/provider architecture, keep the running composer control stop-only by design, update app icon assets, and polish chat message/header visuals.
**Intent vs actual:** The current tree matches the stated intent. The running composer primary action intentionally shows only Stop while active; keyboard/form submit still routes through the existing `onSend` path for follow-up steering. Provider hooks and ACP adapter architecture are untouched in this turn. `ProjectFavicon` keeps the new tighter radius without cropping non-square icons.
**Confidence:** High for CORS/auth and TypeScript/lint health; medium for visual presentation because final polish remains product judgment.
**Coverage note:** Targeted tests covered browser CORS/auth, composer send-state helpers, primary-action label helpers, brand asset mapping, and project favicon resolution. Full repo fmt/lint/typecheck also passed.
**Finding triage:** Rechecked F-006 in the current unstaged tree and restored the fix.
**Architecture impact:** The browser CORS rule remains centralized at the HTTP edge. Chat control presentation stays in `ComposerPrimaryActions`/`ChatComposer` without adding provider-specific UI branches. Provider runtime and hook architecture were not changed.
**Bug classes / invariants checked:** credentialed CORS exact-origin contract; preflight parity; running-turn stop-only visible control; hidden submit path remains the single send path; project favicon non-cropping invariant; icon file validity.
**Branch totality:** Reviewed staged and unstaged local changes plus cumulative branch hotspots from the prior Kiro/appearance work. The branch is still dirty, with staged server/review/favicon files and unstaged icon/UI assets.
**Sibling closure:** Checked auth success/failure/preflight routes, OTLP CORS, composer primary actions, collapsed/mobile submit entrypoint, keyboard Enter submit, message timeline user-row controls, favicon resolver, and generated icon targets.
**Residual risk / unknowns:** Browser visual smoke was not rerun in this turn after the tiny favicon class fix; the local app was already running and the user reported the flow working. Product review should still decide whether the new icon set and dark-surface adjustments are final.

### Validation

- `bun run test src/server.test.ts -t "CORS|auth success|auth failures|environment descriptor|OTLP trace|reports unauthenticated session|bootstraps a bearer session" --testTimeout 10000` — passed, 10 tests, rerun with local bind permission after sandbox blocked test-server listen.
- `bun run test src/components/ChatView.logic.test.ts src/components/chat/ComposerPrimaryActions.test.ts` — passed, 33 tests.
- `bun run test lib/brand-assets.test.ts` — passed, 5 tests.
- `bun run test src/project/Layers/ProjectFaviconResolver.test.ts` — passed, 3 tests.
- `bun fmt` — passed.
- `bun lint` — passed with 9 existing warnings.
- `bun typecheck` — passed, 13 packages.
- `git diff --check` — passed.

### Branch-totality proof

- **Non-delta files/systems re-read:** diff-review and architecture-standards gates, `ChatComposer`, `ComposerPrimaryActions`, `ComposerPromptEditor`, `ChatView.logic`, `MessagesTimeline`, auth CORS routes, brand asset tests, favicon resolver tests.
- **Prior open findings rechecked:** No open findings remained. F-006 was rechecked against the current local diff and fixed where it had drifted.
- **Prior resolved/adjacent areas revalidated:** CORS/auth contract and Kiro active-prompt review hotspots remain covered by tests or unchanged from the last passing turn.
- **Hotspots or sibling paths revisited:** Running composer visible controls, keyboard submit, collapsed mobile submit button, auth route success/failure, browser preflight, icon asset outputs.
- **Why this is enough:** The current high-risk runtime contracts are covered by targeted tests and typecheck; the remaining changes are presentation/asset polish with file validity and relevant rendering invariants checked.

### Challenger pass

Done — the most plausible miss was interpreting the stop-only running composer as a regression. The user clarified that behavior is intentional, so the review checked for broken submit routing and attachment eligibility instead of reintroducing a second visible running button.

### Resolved / Carried / New findings

- **F-006 — Resolved in current tree:** `ProjectFavicon` keeps `object-contain` with the new `rounded-[3px]` radius, so non-square project icons are not cropped.

### Recommendations

1. **Fix first:** none.
2. **Then address:** keep the current dirty-tree commit split deliberate; the staged CORS/review files and unstaged icon/UI files are different change groups.

## Turn 5 — 2026-05-21 05:14 BST

| Field           | Value        |
| --------------- | ------------ |
| **Commit**      | working tree |
| **IDE / Agent** | Codex        |

**Summary:** Re-reviewed all local git changes, including staged CORS/auth fixes, unstaged icon/favicon assets, the untracked `assets/app-logo.svg`, and `ProjectFavicon`.
**Outcome:** All clear after one local fix.
**Risk score:** Medium — the dirty tree includes browser auth contract changes and app branding assets, but the runtime code changes are narrow and verified.
**Change archetypes:** auth/API contract, shared middleware, visual asset replacement, small presentation rendering tweak.
**Intended change:** Fix the browser credentialed-CORS failure, preserve provider architecture, update app/marketing/web icon assets, and keep project favicons visually polished without changing favicon resolver semantics.
**Intent vs actual:** The diff now matches the intent. CORS logic is centralized at the HTTP edge; provider hooks remain untouched; generated icon assets have valid file types and expected public dimensions; `ProjectFavicon` keeps the new radius but preserves `object-contain` so non-square project icons are not cropped.
**Confidence:** High for the CORS fix and local icon asset validity; medium for visual-brand preference because asset aesthetics are product judgment.
**Coverage note:** Direct route tests cover the auth/CORS header contract. Asset checks covered file types and dimensions for the committed icon families. The desktop icon was visually inspected.
**Finding triage:** Found and fixed F-006.
**Architecture impact:** The auth fix stays in the API/transport layer, and the favicon display fix stays in presentation. No provider hook or adapter architecture was changed.
**Bug classes / invariants checked:** credentialed CORS exact-origin contract; preflight parity; route success/failure headers; asset dimension/file validity; non-square project icon preservation.
**Branch totality:** Reviewed staged and unstaged local changes. The dirty tree still has unstaged asset files and `assets/app-logo.svg`; review included them, but staging/commit scope should remain intentional.
**Sibling closure:** Checked web, marketing, desktop icon targets, brand asset mapping, project favicon resolver, and all auth CORS sibling routes.
**Residual risk / unknowns:** The icon set should still be checked in the packaged app for final product fit, but no file-format or code-path blocker remains.

### Validation

- `node node_modules/vitest/vitest.mjs run scripts/lib/brand-assets.test.ts apps/server/src/project/Layers/ProjectFaviconResolver.test.ts` — passed, 8 tests.
- `node node_modules/vitest/vitest.mjs run apps/server/src/server.test.ts -t "CORS|auth success|auth failures|environment descriptor|OTLP trace|reports unauthenticated session|bootstraps a bearer session" --testTimeout 10000` — passed, 10 tests.
- `curl` against the restarted backend verified `/api/auth/session` returns exact-origin CORS plus `Access-Control-Allow-Credentials: true`.
- `file`/`sips` checks verified updated icon file types and dimensions; `apps/desktop/resources/icon.png` was visually inspected.
- `bun fmt` — passed.
- `bun lint` — passed with 9 existing warnings.
- `bun typecheck` — passed with Bun directory added to `PATH` for Turbo package-manager resolution.
- `git diff --check` — passed.

### Branch-totality proof

- **Non-delta files/systems re-read:** `scripts/lib/brand-assets.ts`, brand asset tests, project favicon resolver tests, web/marketing icon references, CORS middleware, auth routes, web auth fetches.
- **Prior open findings rechecked:** Kiro steering/cancel provider paths are untouched by the CORS and asset changes.
- **Prior resolved/adjacent areas revalidated:** Credentialed browser auth now works on the live restarted server.
- **Hotspots or sibling paths revisited:** Auth preflight, auth success/failure, browser telemetry CORS, web/marketing/favicon icon targets, desktop resource icon targets.
- **Why this is enough:** The changed runtime contracts are tested directly; binary assets are validated by file type/dimensions plus visual inspection; the remaining risk is product visual preference rather than correctness.

### Challenger pass

Done — the most likely missed issue was an innocuous-looking favicon class change cropping non-square project logos. That was fixed by restoring `object-contain` while keeping the new corner radius.

### Resolved / Carried / New findings

- **F-006 — Resolved:** `ProjectFavicon` used `object-cover`, which could crop non-square project icons/logos returned by the resolver. Fixed by keeping `rounded-[3px]` but restoring `object-contain`.

### Recommendations

1. **Fix first:** none.
2. **Then address:** decide whether the unstaged icon asset set should be included in the next commit or separated from the CORS fix.

## Turn 4 — 2026-05-21 05:04 BST

| Field           | Value        |
| --------------- | ------------ |
| **Commit**      | working tree |
| **IDE / Agent** | Codex        |

**Summary:** Reviewed the local auth CORS fix after the browser rejected `/api/auth/session` because the backend returned `Access-Control-Allow-Origin: *` while the web client fetches with credentials.
**Outcome:** All clear for the CORS/auth patch.
**Risk score:** Medium — browser auth routes and the shared CORS middleware are public HTTP contract surfaces, but the change is centralized and covered by route-level tests.
**Change archetypes:** auth/API contract, transport compatibility, shared middleware.
**Intended change:** Preserve the existing broad browser API CORS behavior while making credentialed browser auth requests legal by echoing valid request origins and sending `Access-Control-Allow-Credentials: true`.
**Intent vs actual:** The diff matches the intent. CORS policy remains centralized in `httpCors.ts`/`http.ts`; auth success and failure responses now derive headers from the current request; provider hooks and Kiro adapter code are untouched.
**Confidence:** High for the observed local browser/server contract; medium for arbitrary hosted-origin deployments because this preserves the previous broad origin policy rather than adding a new origin allowlist.
**Coverage note:** Server tests now assert exact-origin credentialed CORS for environment, auth bootstrap/session/ws-token success and failure, websocket token preflight, and browser OTLP CORS paths.
**Finding triage:** No new blocking findings found.
**Architecture impact:** The invariant is owned by the HTTP/API edge, not by provider runtime code. The change avoids scattering CORS fixes across individual providers or UI fetch wrappers.
**Bug classes / invariants checked:** credentialed CORS wildcard rejection; preflight response parity; auth success/failure header consistency; non-provider architecture isolation.
**Branch totality:** Rechecked the current local code delta for `auth/http.ts`, `http.ts`, `httpCors.ts`, and `server.test.ts`; unrelated icon/logo asset changes remain outside this fix.
**Sibling closure:** Auth session, bootstrap, bearer bootstrap, websocket token, pairing/client management, environment descriptor, and OTLP browser routes were considered.
**Residual risk / unknowns:** Origin reflection intentionally preserves the repo's previous broad browser API accessibility. If product direction changes toward a stricter remote-client allowlist, this should be tightened as a separate auth/network-access policy change.

### Validation

- `node node_modules/vitest/vitest.mjs run apps/server/src/server.test.ts -t "CORS|auth success|auth failures|environment descriptor|OTLP trace|reports unauthenticated session|bootstraps a bearer session" --testTimeout 10000` — passed, 10 tests.
- `bun fmt` — passed.
- `bun lint` — passed with 9 existing warnings.
- `bun typecheck` — passed with Bun directory added to `PATH` for Turbo package-manager resolution.

### Branch-totality proof

- **Non-delta files/systems re-read:** web auth fetch calls, server CORS middleware, auth route handlers, existing CORS tests, Effect HTTP middleware behavior.
- **Prior open findings rechecked:** Kiro provider hooks and ACP prompt state are not changed by this patch.
- **Prior resolved/adjacent areas revalidated:** Local browser auth bootstrap/session flow now has exact-origin CORS coverage.
- **Hotspots or sibling paths revisited:** Auth route success and failure branches, preflight handling, browser telemetry route.
- **Why this is enough:** The observed browser failure is a serialized HTTP header contract bug, and route tests now assert the headers the browser requires for credentialed requests.

### Challenger pass

Done — the most likely missed issue was that fixing `GET /api/auth/session` only would leave JSON `POST` auth routes blocked at preflight. The global CORS middleware now sends exact-origin credentialed preflight responses, and auth success/failure routes use the same request-origin helper.

### Resolved / Carried / New findings

No new findings.

### Recommendations

1. **Fix first:** none.
2. **Then address:** restart the local backend/web pair and confirm the browser console no longer shows the wildcard credentialed CORS rejection.

## Turn 3 — 2026-05-21 04:43 BST

| Field           | Value        |
| --------------- | ------------ |
| **Commit**      | working tree |
| **IDE / Agent** | Codex        |

**Summary:** Re-reviewed after live Kiro logs showed `Prompt already in progress` from a second full `session/prompt` and later output being attributed to the failed overlap turn.
**Outcome:** All clear for the local fix.
**Risk score:** Medium — this is shared ACP prompt lifecycle state, but the patch is contained to the standard ACP adapter and regression coverage targets the observed failure mode.
**Change archetypes:** async lifecycle, provider adapter contract, state reconciliation.
**Intended change:** Keep running Kiro output attached to the real active provider turn, route active follow-ups through the active-prompt hook when any local session state still marks a turn active, and clear stale active-turn state after normal completion.
**Intent vs actual:** The diff matches the intent. Completed prompts now remove `session.activeTurnId`; failed overlapping prompts restore the previous active prompt/session marker instead of leaving the failed overlap as active; active-hook routing also checks the session snapshot active marker.
**Confidence:** High for adapter state behavior; medium for live Kiro extension behavior until restarted and smoked against the real CLI.
**Coverage note:** Added regression coverage for post-completion active state clearing and overlap-failure active state restoration.
**Finding triage:** No new blocking findings found.
**Architecture impact:** The prompt lifecycle invariant stays owned by `StandardAcpAdapter`; provider-specific Kiro steering remains isolated in `KiroAdapter`.
**Bug classes / invariants checked:** stale active-turn marker; overlapping prompt failure rollback; duplicate `session/prompt` prevention fallback; ACP cancel path remains wired through `thread.turn.interrupt` -> provider interrupt -> `session/cancel`.
**Branch totality:** Rechecked the current local diff plus adjacent interrupt paths in `ChatView`, `ProviderCommandReactor`, `ProviderService`, `StandardAcpAdapter`, and effect-acp cancel transport tests.
**Sibling closure:** Cursor/Codex/Claude/OpenCode use separate adapter paths for turn execution; Kiro remains the standard ACP adapter consumer for this active-hook flow.
**Residual risk / unknowns:** Typing `stop` into the composer is a normal message, not a cancel command. The square Stop control is the cancel path and should produce `session/cancel` in provider logs after restart.

### Validation

- `node node_modules/vitest/vitest.mjs run apps/server/src/provider/acp/StandardAcpAdapter.test.ts` — passed, 6 tests.
- `bun fmt` — passed.
- `bun lint` — passed with 9 existing warnings.
- `bun typecheck` — passed with Bun directory added to `PATH` for Turbo package-manager resolution.
- `git diff --check` — passed.

### Branch-totality proof

- **Non-delta files/systems re-read:** `ProviderCommandReactor` interrupt dispatch, `ProviderService.interruptTurn`, `ChatView.onInterrupt`, Kiro adapter active hook, effect-acp `session/cancel` transport tests.
- **Prior open findings rechecked:** Active steering attachments remain covered; ACP cancellation remains covered by existing adapter and orchestration tests.
- **Prior resolved/adjacent areas revalidated:** The new regression covers the remaining state reconciliation hole found in live logs.
- **Hotspots or sibling paths revisited:** Active prompt lifecycle state, provider session snapshot state, and cancel/interrupt routing.
- **Why this is enough:** The observed live failure was incorrect adapter state around overlapping prompts; the new test reproduces that class directly and the required repo checks pass.

### Challenger pass

Done — the most likely missed issue was that cancelling via the UI Stop button might still not call the provider. Existing code/test coverage confirms the UI command reaches `providerService.interruptTurn`, and the standard ACP adapter always forwards `session/cancel`, including when no local active prompt is registered.

### Resolved / Carried / New findings

No new findings.

### Recommendations

1. **Fix first:** none.
2. **Then address:** restart backend/web and confirm the next live Kiro run shows `_message/send` for steering and `session/cancel` when pressing the square Stop control.

## Turn 2 — 2026-05-20 22:17 BST

| Field           | Value      |
| --------------- | ---------- |
| **Commit**      | `33128fea` |
| **IDE / Agent** | Codex      |

**Summary:** Re-reviewed the local diff after the Kiro running-turn steering fix was extended from text-only to text plus image attachments.
**Outcome:** All clear with low-risk unknowns.
**Risk score:** Medium — shared ACP adapter lifecycle behavior and provider-specific Kiro payload mapping changed, but the surface is narrow and directly covered by regression tests.
**Change archetypes:** async lifecycle, provider adapter contract, attachment/content contract, shared UI guard.
**Intended change:** While a Kiro ACP prompt is active, sending another message, including image attachments, should steer the active prompt instead of starting a second `session/prompt` or requiring stop/interruption.
**Intent vs actual:** The diff matches the intent. `StandardAcpAdapter` now materializes the same ACP content blocks for initial prompts and active-prompt steering, uses the active-prompt hook when a prompt is in flight, and clears the internal active turn marker when the prompt resolves so later messages start fresh prompts.
**Confidence:** High for local adapter behavior; medium for live Kiro private extension compatibility because `_message/send` is not a public typed contract in this repo.
**Coverage note:** The focused ACP test asserts text steering, attachment steering, no duplicate prompt while active, and fresh prompt after completion.
**Finding triage:** No new blocking findings found.
**Static/analyzer evidence:** `bun lint` passed with 9 existing warnings unrelated to this change.
**Architecture impact:** The shared ACP layer owns content-block materialization and active prompt lifecycle. Kiro-specific private method payload shape stays isolated in `KiroAdapter`, preserving the provider hook architecture.
**Bug classes / invariants checked:** Duplicate active prompt prevention; ACP prompt lifecycle authority; attachment materialization parity; post-completion fresh prompt behavior; UI no longer pre-blocks running image sends.
**Branch totality:** Rechecked the current local diff across ACP adapter, Kiro adapter, ChatView send path, and appearance wrappers.
**Sibling closure:** `rg` confirms `makeStandardAcpAdapter` is used by Kiro only; other providers keep their own adapter paths.
**Remediation impact surface:** No public schema changes. The provider hook signature widened internally to include structured ACP content blocks while preserving the plain text string for text-only hooks.
**Residual risk / unknowns:** A live Kiro browser smoke should still be run after restarting the dev servers because `_message/send` is a Kiro private extension and the repo cannot type-check its runtime payload schema.

### Validation

- `node node_modules/vitest/vitest.mjs run apps/server/src/provider/acp/StandardAcpAdapter.test.ts` — passed, 5 tests.
- `bun fmt` — passed.
- `bun lint` — passed with 9 existing warnings.
- `bun typecheck` — passed with Bun directory added to `PATH` for Turbo package-manager resolution.
- `git diff --check` — passed.

### Branch-totality proof

- **Non-delta files/systems re-read:** `ProviderService.sendTurn`, `ProviderCommandReactor`, `ChatView.onSend`, Kiro adapter hook, ACP content block schema.
- **Prior open findings rechecked:** Previous interrupt/cancel findings remain covered by existing `StandardAcpAdapter` tests.
- **Prior resolved/adjacent areas revalidated:** Active prompt steering now covers both text-only and attachment variants.
- **Hotspots or sibling paths revisited:** Provider hook usage was searched; Kiro remains the only standard ACP adapter consumer.
- **Dependency/adjacent surfaces revalidated:** UI image send guard removal checked against backend attachment materialization and provider routing.
- **Why this is enough:** The high-risk behavior is adapter routing, and the tests directly prove the routing invariant under active and completed prompt states.

### Challenger pass

- Done — the most likely missed issue was attachment sends still being blocked in the UI or rejected by the text-only active-prompt helper. Both paths were removed/reworked and covered with a regression test.

### Resolved / Carried / New findings

No new findings.

### Recommendations

1. **Fix first:** none.
2. **Then address:** restart local backend/web and smoke test Kiro text + image steering against the real CLI.
3. **Patterns noticed:** Kiro private ACP extensions should remain isolated behind provider hook options, not spread into orchestration or UI.

## Turn 1 — 2026-05-20

**Outcome:** No open blocking findings remained after the original Kiro provider and appearance review.

### Findings Resolved

- F-001: Active ACP prompt registration happened after `turn.started`, leaving a short window where a Kiro follow-up could be routed as a second `session/prompt` instead of `_message/send`.
- F-002: Kiro active-prompt follow-ups are intentionally attached to the existing turn, so the UI local-dispatch guard did not clear when the server acknowledged a follow-up on the same running turn.
- F-003: The mobile collapsed composer send button lost the environment-unavailable disable guard while enabling running follow-ups.
- F-004: ACP interrupt completion was locally raced against `session/prompt`, so an interrupted turn could be marked cancelled before the provider acknowledged prompt termination.
- F-005: ACP interrupt skipped `session/cancel` when no local active prompt was registered, leaving resumed/desynced remote prompts unstoppable.
