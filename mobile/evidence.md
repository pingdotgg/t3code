# Native mobile evidence for [#33577](https://git.cafe/pingdotgg/t3code/pull/33577)

Before [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41): `bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41`. After [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf): `6b8290152712ae8ef4696e44fb9f1f00026b99cf`.

**Proof is incomplete: 13 of 15 applicable native rows have some accepted capture; 4 recipes are complete, 9 partial, and 2 missing.** There are 24 settled Before/After pairs with two diffs each. Exact synthetic lifecycle arithmetic is demonstrated on both platforms; the gaps below prevent treating the whole matrix as verified. No additional product change outside duration text and consequent inline geometry was seen in the comparable fixed-clock pairs. Real replay recordings have different dwell/work times and are integration evidence, not pixel-identical elapsed-time comparisons.

AI-assisted; verified with the tests and tools listed above.

## Rendering environment and method

| Bundle | Native rendering environment for every capture in this bundle |
| --- | --- |
| M1 | Shared-pool **Pixel 9 Android emulator**, native T3 dev client obtained through `vp run mobile:install android`; Android dark theme. Logical viewport **411.428571 × 923.428571**, screenshot **1080 × 2424**, DPR **2.625**, font scale **0.939999976**. Android animations disabled. No browser emulation. Native client fingerprint `3445feafb89121f3f1b8190fdec01d545f6faa1d`. |
| M2 | Shared-pool **iPhone 17 Pro iOS simulator**, native T3 dev client obtained through `vp run mobile:install ios`; iOS light theme. Logical viewport **402 × 874**, agent-device screenshot **402 × 874 @1x**, native DPR **3**, font scale **0.941**. Reduced-motion emulation unavailable through the device tool; native transitions allowed to settle. No browser emulation. Native client fingerprint `edb0efb70b2f14145ebeef8b3124cd71a51f0c75`. |

Each revision ran its own Metro bundle and isolated source server from a separate detached worktree. Connections used the VM's tailnet address. Every server used `T3CODE_DEV_SEED=0`; no live T3 database was read, copied, seeded, or modified. Both real-app sides were seeded through RPC with synthetic Replay (dev) Question and Write approval scenarios; approval runtime was Supervised. Capture-only replay gates delayed completion after answers so the resumed timer could be read. Replay does not establish that a real provider executed the displayed command.

**Real app, replay provider** recordings exercise native request answers, orchestration and persisted runs. **Harness: synthetic turn items** recordings feed deterministic typed items to the real native fold derivation/RunFoldButton and FloatingWorkingControl. Before uses its original `runStartedAt ?? runlessStartedAt` timer expression; after calls its actual `activeWorkTimerStartedAt`. The harness supplies visibility/status props: it does not prove all route selectors. Source and patches are retained below.

Every accepted PNG was captured twice 500 ms apart and accepted only when pixel-identical, then visually inspected with both diffs. Device tooling exposes no browser-style network-idle API; ready native content and stable screenshots were the settling checks. PNG pairs use the same fixture, clock, viewport, theme and scroll. Invalid splash/compile-error/clock-leak/blank/clipped captures were excluded. Recordings are native MP4 originals; public animated WebP copies are lossless, 6 fps and 480 px wide, under 10 MiB. Playback conversion reduces spatial/temporal resolution, while the PNGs retain full capture resolution.

## Coverage and unverified portions

| Row | Status | Accepted proof and remaining gap |
| --- | --- | --- |
| F0 ordinary work | Partial | Core H pre-request timer and live 59/60/61-second boundary. No accepted paired empty-draft/start-before-any-item recording. |
| F1 blocking question | Partial | Real native question, answer and completion on both platforms; floating timer hidden while pending. Android records ≥10 s pending dwell; iOS before valid recording starts after its long dwell and does not show ≥10 s of it on camera. |
| F2 command approval | Complete | Real native approval on both platforms, ≥10 s pending dwell, command activity, Allow and completion. |
| F3 resumed work | Complete | Exact H work 0–2, wait 2–62, work 62–65: at 64 before Working 1m 04s / after Working 4s; at completion before Worked for 1m 5s / after Worked for 5s. Question core on both platforms, approval exact Android supplement and native real approval resumes on iOS. |
| F4 latest fold | Complete | Collapsed/expanded/collapsed exact totals, question and approval fixtures, plus real native approval folds. Answered real question remains visible and alone need not produce a work fold. |
| F5 historical/runless fold | Partial | H forces latestRun=null and runless prompt-boundary fallback, both yielding after 5s. Android supplement opens/closes historical folds. No accepted actual second-turn lifecycle or fixture with a distinct newer latest-run summary. |
| F6 per-steer | Not applicable | Web-only Continued-for path; owned by other capture agent. |
| F7 runless ownership | Partial | H includes own 2–62 wait, earlier runless −90 to −30 wait, foreign non-null-run 0–64 wait; at 64 after Working 4s. Pending suppression in wrapper is injected; actual route-level ownership/waiting selection is unverified. |
| F8 inherited wake | Partial | H inherited start 0, predecessor wait 2–62, too-early request −5–0, foreign open request 81; at 84 after Working 24s vs before 1m 24s. Owned-request hiding is injected; actual route-level waiting selection is unverified. |
| F9 message-mode | Complete | H forces a real question item with responseMode=message and no completion. Clock advances through 2/62/64/65, timer continues, completed total stays 1m 5s on both sides. Generic request-type caption may say approval; this chapter explicitly forces question. |
| F10 Zen/hidden tools | Missing | Attempted Zen recordings were invalid: the scratch frozen clock leaked when returning from H to app. They were discarded and never uploaded. No accepted paired visibility-setting evidence. |
| F11 simultaneous/overlap | Optional native, not captured | Shared numeric tests were not rerun in this capture task. No native overlap proof is claimed. |
| F12 formatting/boundaries | Partial | Both native duration galleries show 1ms, 500ms, 5s, 1m, 1h 2m 3s after deduction; long labels fit. 59→60→61 live transition recorded. Missing/invalid timestamp, untimed and null-request-start fallbacks are unverified. |
| F13 priorities | Partial | Android H injects preparing/syncing/compacting/child-input/disconnected/working props into the real control. It verifies rendering only, not priority selection or all goal/stop states. |
| F14 denied/stopped/error | Partial | Fresh Android real approval Decline and Stop recordings show pending exit on each revision. Failed-tool tail, rare fold eligibility/error/streaming variants remain unverified. |
| F15 deferred/reconnect | Partial | Real RunFoldButton with a scratch Promise callback: skeleton, failure suffix, retry and resolution; missing answered wait keeps total 65s. Wrapper supplies manual expanded content, so actual server deferred history and reconnect are unverified. |
| F16 guest | Not applicable | Web guest belongs to other capture agent; no native guest scope. |
| F17 empty/loading/unavailable | Missing | Startup was used operationally, but no accepted paired empty/loading/unavailable/null-shell/checkpoint-tail capture. |

Applicable native count excludes web-only F6/F16 and optional F11: complete F2/F3/F4/F9 = 4, partial F0/F1/F5/F7/F8/F12/F13/F14/F15 = 9, missing F10/F17 = 2. This is capture coverage, not an assertion of full behavior verification.

## Recordings (steps and timestamps precede each pair)

All Before/After video tables inherit the M1/M2 environment above. Times are approximate playback seconds; native Android variable-frame-rate capture can omit unchanged trailing frames. Exact command offsets are in `scripts/timing-manifest.json` and raw driver logs. Fixture time is separate from playback time.

### M1 Android dark — real app, replay provider — question (F1/F3)

Before: 0–18 s pending question (select Strict schemas around 3 s); submit around 18 s; readable resumed timer around 20–33 s; release completion gate and scroll to final content around 35 s. After: 0–24 s pending; select/submit around 24 s; resumed work around 30–60 s; release completion gate around 62 s. Both hide the floating timer while the question is open. Work/dwell durations differ; use fixed H below for exact numeric comparison.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- |
| ![m1-before-real-question-retake.webp](https://git.cafe/api/attachments/attach_01m71h5cmseh1th89885a8c2e5) | ![m1-after-real-question-retake.webp](https://git.cafe/api/attachments/attach_01m71h5dxheh1th89k0et7y22m) |

### M1 Android dark — real app, replay provider — approval (F2/F3/F4)

Before: 0–33 s pending approval; Allow around 33 s; resumed work around 35–48 s; release gate around 50 s; completion Worked for 1m 14s; scroll and expand/collapse in the final ~15 s. After: 0–25 s pending; Allow around 25 s; resumed timer around 30–60 s; release gate around 63 s; completion Worked for 35s; fold open/close around 70–78 s. Persisted base wall=73.984 s, wait=55.662 s, actual work=18.322 s; head wall=103.335 s, wait=68.013 s, actual work=35.322 s. The base 74s → head 35s change is not a same-duration comparison. Metadata-only XMP was added to the before WebP after a stale upload; image frames and timings are unchanged.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- |
| ![m1-before-real-approval-retake-retry.webp](https://git.cafe/api/attachments/attach_01m71hafhefaptzy3pzvdvdqak) | ![m1-after-real-approval-retake.webp](https://git.cafe/api/attachments/attach_01m71hbdymfaptzy3snbbg9aws) |

### M2 iOS light — real app, replay provider — question (F1/F3)

Before: starts pending; select around 3 s, submit around 6 s, completion around 8 s. This valid before recording does not contain 10 s of pending dwell. After: 0–14 s synthetic thread list, open question around 15 s; pending around 16–40 s; select/submit around 43 s; readable resumed timer around 48 s; release gate around 52 s and complete. Replay Question intentionally has no ordinary foldable command, so answered question remains visible without a Worked fold.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- |
| ![m2-before-question-valid.webp](https://git.cafe/api/attachments/attach_01m71gyq21fqbrkh8yjg0dc2bx) | ![m2-after-question.webp](https://git.cafe/api/attachments/attach_01m71gyramfvhag4k5zt2e2k5n) |

### M2 iOS light — real app, replay provider — approval (F2/F3/F4)

Before: 0–22 s pending, Allow around 23 s, completion around 27 s (Worked for 29s), fold open/close around 35–47 s. After: 0–21 s pending, Allow around 22 s, Working 1–8s through about 33 s, release gate around 35 s, completion Worked for 9.2s, fold open/close around 42–54 s. Actual dwell/work durations differ.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- |
| ![m2-before-approval.webp](https://git.cafe/api/attachments/attach_01m71gym1xfqbrkh8qeg925m15) | ![m2-after-approval.webp](https://git.cafe/api/attachments/attach_01m71gynkqeh2b4x6pp5c718vf) |

### M1 Android dark — Harness: synthetic turn items — exact question lifecycle (F0/F3/F4)

Stages are fixture t=1, 2, 62, 64, 65. Before presses Next stage at 3.6/7.1/10.7/14.5 s; expand 18.7 s, collapse 21.7 s, switch request type to approval 22.6 s. After presses at 4.1/6.9/9.8/12.7 s; expand 16.0 s, collapse 19.1 s, switch type 20.1 s. Pending at t2/t62, resumed t64, complete t65. Android screenrecord can miss a timer paint in the original clip; the settled still and heartbeat approval supplement below show it clearly.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- |
| ![m1-before-h-core.webp](https://git.cafe/api/attachments/attach_01m71gyakpfk7stc6avwxg2kkk) | ![m1-after-h-core.webp](https://git.cafe/api/attachments/attach_01m71gyc2af6fb3eyf19yqxjvy) |

### M2 iOS light — Harness: synthetic turn items — exact question lifecycle (F0/F3/F4)

Before fixture advances at 4.6/9.3/13.6/18.1 s; expand 23.5 s, collapse 28.8 s, switch type to approval 30.5 s. After advances at 4.5/9.1/13.7/18.4 s; expand 23.6 s, collapse 28.4 s, switch type 29.7 s. Same t1/2/62/64/65 oracle. Request-type toggle at the end also shows approval completion.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- |
| ![m2-before-h-core.webp](https://git.cafe/api/attachments/attach_01m71gydpdfaptzy0bvnerjz8q) | ![m2-after-h-core.webp](https://git.cafe/api/attachments/attach_01m71gyfbxfaptzy0m66f0a1dk) |

### M1 Android dark — Harness: synthetic turn items — exact approval lifecycle (F3/F4)

Both: start t1; around 3 s advance to t2 pending; around 7 s t62 still pending; around 11 s t64 resumed (before Working 1m 04s / after Working 4s); around 16 s t65 complete; around 20 s expand/collapse. A 500 ms capture-frame counter forces Android screenrecord to capture stable timer text; its counter values differ between sides and are capture instrumentation.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- |
| ![m1-before-h-approval-supplement.webp](https://git.cafe/api/attachments/attach_01m71hfdgpfvhag4mneje7q885) | ![m1-after-h-approval-supplement.webp](https://git.cafe/api/attachments/attach_01m71hfemhfaptzz3sjn654emx) |

### M1 Android dark — Harness: synthetic turn items — history/ownership/wake/message/boundary/priority (F5/F7/F8/F9/F12/F13)

Both execute the same ordered steps (after is ~3 s longer): 0–6 s historical fold open/close; 6–12 s runless history open/close; 12–16 s runless ownership at t64; 16–27 s inherited wake at t84, toggle owned-request hiding then clear; 27–42 s message-mode question at t2/62/64/65; 42–46 s duration gallery; 46–56 s live 59→60→61; 56 s–end preparing/syncing/compacting/child-input/disconnected/working. Wrapper injects waiting/status props; route selector correctness is not established.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- |
| ![m1-before-h-ownership-supplement.webp](https://git.cafe/api/attachments/attach_01m71hfc60fvhag4mez5wbxss5) | ![m1-after-h-ownership-supplement.webp](https://git.cafe/api/attachments/attach_01m71hffwdfaptzz439xbtfgfr) |

### M1 Android dark — Harness: synthetic turn items — deferred callback/error/retry (F15)

The earlier chapters repeat ownership/wake/message/gallery/minute/priorities. Deferred chapter begins at ~65.4 s before /75.8 s after. Expand 68.6/79.6 s → skeleton; Fail deferred 71.6/83.2 s → error suffix; tap retry 74.9/86.7 s; Complete deferred 76.7/89.1 s → loaded; Missing wait control 80.2/93.5 s removes answered wait and restores 65s. These are command offsets; encoded playback can differ slightly. This uses the actual button with injected callback and manual body, not server history loading or a reconnect.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- |
| ![m1-before-h-chapters.webp](https://git.cafe/api/attachments/attach_01m71gyha0fvhag4jg2nv21s60) | ![m1-after-h-chapters.webp](https://git.cafe/api/attachments/attach_01m71gyjkafvhag4jv28ec9dbw) |

### M1 Android dark — real app, replay provider — Decline (F14)

Before: pending through ~12 s, Decline ~13 s, resumed/settled response ~14–18 s (Worked for 54s). After: pending at start, Decline ~2 s, completion ~5 s (Worked for 3.8s). This proves pending exit only; durations/dwell differ and rare error/fold paths are unverified.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- |
| ![m1-before-reject.webp](https://git.cafe/api/attachments/attach_01m71hbf4ceh1th89wm3m0fxm2) | ![m1-after-reject.webp](https://git.cafe/api/attachments/attach_01m71hbg1qfaptzy403r3pyv7k) |

### M1 Android dark — real app, replay provider — Stop (F14)

Both: pending at start, press Stop around 1 s, Stopping around 2 s, request clears around 3 s, final Resume/play control visible. Before lasts ~5.5 s, after ~4.2 s. Interrupted runs need not produce a fold.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- |
| ![m1-before-stop.webp](https://git.cafe/api/attachments/attach_01m71hbh20eh1th8a6pb83rg59) | ![m1-after-stop-valid.webp](https://git.cafe/api/attachments/attach_01m71hbj0cfaptzy4fkbqx740b) |

### M2 iOS light — Harness: synthetic turn items — history and live minute/gallery chapters (F5/F12)

Both follow the same chapter order. Approximate playback landmarks: 0–18 s latest/history/runless folds; 18–32 s ownership and wake; 32–47 s message-mode progression; around 47–57 s settled duration gallery; around 57–72 s minute boundary 59→60→61. Later portions show injected priorities and callback gates, with the same route-selection/server-history limitations as M1; these later portions do not increase coverage claims. Native animation/timing means corresponding actions occur a few seconds apart. The gallery key frame is near 51–52 s on both sides. This supplies the iOS recording accompanying the settled minute and gallery pairs.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- |
| ![m2-before-h-chapters.webp](https://git.cafe/api/attachments/attach_01m71htjjmfaptzzcr2hxdeac5) | ![m2-after-h-chapters.webp](https://git.cafe/api/attachments/attach_01m71htm1nfetvx1zxhc93a4fb) |

## Settled full-surface comparisons

Every cell below is verbatim successful uploader output. Diff0 = absolute per-channel RGB difference amplified ×32 and clamped at 255, zero threshold. DiffT = white when maximum per-channel absolute difference is >16/255, black otherwise. Counts refer to native capture pixels. A black Diff0 means this pair is exactly identical; this statement applies only to that fixed-clock pair.

### F1/F2 pending at fixture t2 — M1 Android dark · 411.428571×923.428571 logical / 1080×2424 pixels

Harness: synthetic turn items. No floating timer; wrapper pending suppression is injected. Zero-threshold changed pixels: 0; threshold >16 changed pixels: 0.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m1-before-h-pending-start-b.png](https://git.cafe/api/attachments/attach_01m71g0380faptzxexfjmf19pv) | ![m1-after-h-pending-start-b.png](https://git.cafe/api/attachments/attach_01m71g0380faptzxexfjmf19pv) | ![m1-h-pending-start-diff0.png](https://git.cafe/api/attachments/attach_01m71g053jeh1th85grn3jh9g5) | ![m1-h-pending-start-diff16.png](https://git.cafe/api/attachments/attach_01m71g053jeh1th85grn3jh9g5) |

### F3 resumed at fixture t64 — M1 Android dark · 411.428571×923.428571 logical / 1080×2424 pixels

Harness: synthetic turn items. Before Working 1m 04s; after Working 4s. Zero-threshold changed pixels: 12570; threshold >16 changed pixels: 3040.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m1-before-h-resumed-b.png](https://git.cafe/api/attachments/attach_01m71g06qsfaptzxf7e9xb8y41) | ![m1-after-h-resumed-b.png](https://git.cafe/api/attachments/attach_01m71g0828faptzxfd0yjg7gxp) | ![m1-h-resumed-diff0.png](https://git.cafe/api/attachments/attach_01m71g091nfaptzxfg9v83yy6h) | ![m1-h-resumed-diff16.png](https://git.cafe/api/attachments/attach_01m71g09zwfaptzxfrk30tsv2v) |

### F3/F4 completed question at fixture t65 — M1 Android dark · 411.428571×923.428571 logical / 1080×2424 pixels

Harness: synthetic turn items. Before Worked for 1m 5s; after Worked for 5s. Zero-threshold changed pixels: 1268; threshold >16 changed pixels: 1141.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m1-before-h-completed-b.png](https://git.cafe/api/attachments/attach_01m71g0awzeh1th85wmvtank7k) | ![m1-after-h-completed-b.png](https://git.cafe/api/attachments/attach_01m71g0by5eh1th862ez4tb9bb) | ![m1-h-completed-diff0.png](https://git.cafe/api/attachments/attach_01m71g0cyweh1th86e7p88fg71) | ![m1-h-completed-diff16.png](https://git.cafe/api/attachments/attach_01m71g0dvmfaptzxg6mjprg7bz) |

### F4 completed question expanded — M1 Android dark · 411.428571×923.428571 logical / 1080×2424 pixels

Harness: synthetic turn items. Same duration change with body expanded. Zero-threshold changed pixels: 1328; threshold >16 changed pixels: 1163.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m1-before-h-expanded-b.png](https://git.cafe/api/attachments/attach_01m71g0enxfaptzxg83rgp87y9) | ![m1-after-h-expanded-b.png](https://git.cafe/api/attachments/attach_01m71g0frdfaptzxghx2ma0teg) | ![m1-h-expanded-diff0.png](https://git.cafe/api/attachments/attach_01m71g0grffaptzxgrg3ps5r6g) | ![m1-h-expanded-diff16.png](https://git.cafe/api/attachments/attach_01m71g0ht6eh1th86q61h7e46h) |

### F3/F4 completed approval — M1 Android dark · 411.428571×923.428571 logical / 1080×2424 pixels

Harness: synthetic turn items. Before Worked for 1m 5s; after Worked for 5s. Zero-threshold changed pixels: 1268; threshold >16 changed pixels: 1141.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m1-before-h-approval-completed-b.png](https://git.cafe/api/attachments/attach_01m71g0jqefaptzxh1b5est0fa) | ![m1-after-h-approval-completed-b.png](https://git.cafe/api/attachments/attach_01m71g0kqhfaptzxh88cpx741q) | ![m1-h-approval-completed-diff0.png](https://git.cafe/api/attachments/attach_01m71g0cyweh1th86e7p88fg71) | ![m1-h-approval-completed-diff16.png](https://git.cafe/api/attachments/attach_01m71g0dvmfaptzxg6mjprg7bz) |

### F5 historical fallback — M1 Android dark · 411.428571×923.428571 logical / 1080×2424 pixels

Harness: synthetic turn items. latestRun=null; after Worked for 5s. Distinct newer latest-run summary unverified. Zero-threshold changed pixels: 1268; threshold >16 changed pixels: 1141.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m1-before-h-history-b.png](https://git.cafe/api/attachments/attach_01m71g0pnrfaptzxhhze7gx4f3) | ![m1-after-h-history-b.png](https://git.cafe/api/attachments/attach_01m71g0qsefaptzxhvx8fm186v) | ![m1-h-history-diff0.png](https://git.cafe/api/attachments/attach_01m71g0cyweh1th86e7p88fg71) | ![m1-h-history-diff16.png](https://git.cafe/api/attachments/attach_01m71g0dvmfaptzxg6mjprg7bz) |

### F5/F7 runless history fallback — M1 Android dark · 411.428571×923.428571 logical / 1080×2424 pixels

Harness: synthetic turn items. Prompt/item-boundary fallback; after Worked for 5s. Zero-threshold changed pixels: 1268; threshold >16 changed pixels: 1141.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m1-before-h-runless-history-b.png](https://git.cafe/api/attachments/attach_01m71g0ta3faptzxj7gnqw648r) | ![m1-after-h-runless-history-b.png](https://git.cafe/api/attachments/attach_01m71g0v6yfaptzxj97twe66vs) | ![m1-h-runless-history-diff0.png](https://git.cafe/api/attachments/attach_01m71g0cyweh1th86e7p88fg71) | ![m1-h-runless-history-diff16.png](https://git.cafe/api/attachments/attach_01m71g0dvmfaptzxg6mjprg7bz) |

### F7 runless ownership at t64 — M1 Android dark · 411.428571×923.428571 logical / 1080×2424 pixels

Harness: synthetic turn items. Earlier and foreign waits excluded; after Working 4s. Route selection unverified. Zero-threshold changed pixels: 12570; threshold >16 changed pixels: 3040.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m1-before-h-runless-ownership-b.png](https://git.cafe/api/attachments/attach_01m71g0xr6faptzxjm1n14bvmv) | ![m1-after-h-runless-ownership-b.png](https://git.cafe/api/attachments/attach_01m71g0yk7faptzxjxcbvrej3p) | ![m1-h-runless-ownership-diff0.png](https://git.cafe/api/attachments/attach_01m71g091nfaptzxfg9v83yy6h) | ![m1-h-runless-ownership-diff16.png](https://git.cafe/api/attachments/attach_01m71g09zwfaptzxfrk30tsv2v) |

### F8 inherited wake at t84 — M1 Android dark · 411.428571×923.428571 logical / 1080×2424 pixels

Harness: synthetic turn items. Before Working 1m 24s; after Working 24s. Route waiting selection unverified. Zero-threshold changed pixels: 10937; threshold >16 changed pixels: 3367.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m1-before-h-wake-b.png](https://git.cafe/api/attachments/attach_01m71g10vefaptzxk1e21br605) | ![m1-after-h-wake-b.png](https://git.cafe/api/attachments/attach_01m71g11x1faptzxkedp93whq9) | ![m1-h-wake-diff0.png](https://git.cafe/api/attachments/attach_01m71g12w6faptzxkq4tpjj5st) | ![m1-h-wake-diff16.png](https://git.cafe/api/attachments/attach_01m71g13s3faptzxkr09xzfkms) |

### F9 asynchronous message-mode question complete — M1 Android dark · 411.428571×923.428571 logical / 1080×2424 pixels

Harness: synthetic turn items. 65s retained on both sides; no blocking wait subtraction. Zero-threshold changed pixels: 0; threshold >16 changed pixels: 0.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m1-before-h-message-3-b.png](https://git.cafe/api/attachments/attach_01m71g14jkfaptzxm7h2bdy4vt) | ![m1-after-h-message-3-b.png](https://git.cafe/api/attachments/attach_01m71g14jkfaptzxm7h2bdy4vt) | ![m1-h-message-3-diff0.png](https://git.cafe/api/attachments/attach_01m71g053jeh1th85grn3jh9g5) | ![m1-h-message-3-diff16.png](https://git.cafe/api/attachments/attach_01m71g053jeh1th85grn3jh9g5) |

### F12 immutable duration gallery — M1 Android dark · 411.428571×923.428571 logical / 1080×2424 pixels

Harness: synthetic turn items. After labels 1ms / 500ms / 5s / 1m / 1h 2m 3s, with 60s known wait inside each window. Zero-threshold changed pixels: 5423; threshold >16 changed pixels: 4759.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m1-before-h-gallery-b.png](https://git.cafe/api/attachments/attach_01m71g17theh1th875fadj63pr) | ![m1-after-h-gallery-b.png](https://git.cafe/api/attachments/attach_01m71g18vqfaptzxmfp59t5g7g) | ![m1-h-gallery-diff0.png](https://git.cafe/api/attachments/attach_01m71g19vcfaptzxmm620205cz) | ![m1-h-gallery-diff16.png](https://git.cafe/api/attachments/attach_01m71g1apqfaptzxmsw69a4tkg) |

### F0/F12 live minute boundary at t60 — M1 Android dark · 411.428571×923.428571 logical / 1080×2424 pixels

Harness: synthetic turn items. No-wait control; both Working 1m 00s. Zero-threshold changed pixels: 0; threshold >16 changed pixels: 0.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m1-before-h-minute-1-b.png](https://git.cafe/api/attachments/attach_01m71g1bhtfaptzxn02z44tk25) | ![m1-after-h-minute-1-b.png](https://git.cafe/api/attachments/attach_01m71g1bhtfaptzxn02z44tk25) | ![m1-h-minute-1-diff0.png](https://git.cafe/api/attachments/attach_01m71g053jeh1th85grn3jh9g5) | ![m1-h-minute-1-diff16.png](https://git.cafe/api/attachments/attach_01m71g053jeh1th85grn3jh9g5) |

### F15 deferred callback failed — M1 Android dark · 411.428571×923.428571 logical / 1080×2424 pixels

Harness: synthetic turn items. Error suffix and chevron follow shortened duration. Intentional failure state, not an unsettled capture. Zero-threshold changed pixels: 8805; threshold >16 changed pixels: 7759.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m1-before-h-deferred-failed-b.png](https://git.cafe/api/attachments/attach_01m71g1eswfaptzxnft6vk5m7k) | ![m1-after-h-deferred-failed-b.png](https://git.cafe/api/attachments/attach_01m71g1fypfaptzxng4qvprxsa) | ![m1-h-deferred-failed-diff0.png](https://git.cafe/api/attachments/attach_01m71g1h0ffaptzxnwpm58mfsj) | ![m1-h-deferred-failed-diff16.png](https://git.cafe/api/attachments/attach_01m71g1jjgeh1th87b8etrjzy4) |

### F15 deferred callback resolved — M1 Android dark · 411.428571×923.428571 logical / 1080×2424 pixels

Harness: synthetic turn items. Callback settled; synthetic expanded body visible. Zero-threshold changed pixels: 1328; threshold >16 changed pixels: 1163.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m1-before-h-deferred-loaded-b.png](https://git.cafe/api/attachments/attach_01m71g1kx7faptzxp5wxk6kns0) | ![m1-after-h-deferred-loaded-b.png](https://git.cafe/api/attachments/attach_01m71g1ng2e04v9bxp2bn6edzw) | ![m1-h-deferred-loaded-diff0.png](https://git.cafe/api/attachments/attach_01m71g0grffaptzxgrg3ps5r6g) | ![m1-h-deferred-loaded-diff16.png](https://git.cafe/api/attachments/attach_01m71g0ht6eh1th86q61h7e46h) |

### F15 missing answered wait negative control — M1 Android dark · 411.428571×923.428571 logical / 1080×2424 pixels

Harness: synthetic turn items. Both Worked for 1m 5s because absent waits cannot be deducted. Zero-threshold changed pixels: 0; threshold >16 changed pixels: 0.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m1-before-h-deferred-missing-wait-b.png](https://git.cafe/api/attachments/attach_01m71g1rfjfaptzxp985efyfzv) | ![m1-after-h-deferred-missing-wait-b.png](https://git.cafe/api/attachments/attach_01m71g1rfjfaptzxp985efyfzv) | ![m1-h-deferred-missing-wait-diff0.png](https://git.cafe/api/attachments/attach_01m71g053jeh1th85grn3jh9g5) | ![m1-h-deferred-missing-wait-diff16.png](https://git.cafe/api/attachments/attach_01m71g053jeh1th85grn3jh9g5) |

### F1/F2 pending at fixture t2 — M2 iOS light · 402×874 logical / captured pixels

Harness: synthetic turn items. No floating timer; wrapper pending suppression is injected. Zero-threshold changed pixels: 0; threshold >16 changed pixels: 0.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m2-before-h-pending-start-b.png](https://git.cafe/api/attachments/attach_01m71g1w1kfaptzxpmzr8jmydw) | ![m2-after-h-pending-start-b.png](https://git.cafe/api/attachments/attach_01m71g1w1kfaptzxpmzr8jmydw) | ![m2-h-pending-start-diff0.png](https://git.cafe/api/attachments/attach_01m71g1xwte04v9bxsj116gswg) | ![m2-h-pending-start-diff16.png](https://git.cafe/api/attachments/attach_01m71g1xwte04v9bxsj116gswg) |

### F3 resumed at fixture t64 — M2 iOS light · 402×874 logical / captured pixels

Harness: synthetic turn items. Before Working 1m 04s; after Working 4s. Zero-threshold changed pixels: 3272; threshold >16 changed pixels: 721.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m2-before-h-resumed-b.png](https://git.cafe/api/attachments/attach_01m71g1zx6eh1th87ndxwxtyqr) | ![m2-after-h-resumed-b.png](https://git.cafe/api/attachments/attach_01m71g214afaptzxprmjpy68z3) | ![m2-h-resumed-diff0.png](https://git.cafe/api/attachments/attach_01m71g22a5faptzxq67m383vbv) | ![m2-h-resumed-diff16.png](https://git.cafe/api/attachments/attach_01m71g23jmfaptzxqfzq163637) |

### F3/F4 completed question at fixture t65 — M2 iOS light · 402×874 logical / captured pixels

Harness: synthetic turn items. Before Worked for 1m 5s; after Worked for 5s. Zero-threshold changed pixels: 285; threshold >16 changed pixels: 228.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m2-before-h-completed-b.png](https://git.cafe/api/attachments/attach_01m71g24f3faptzxqjeasf68ra) | ![m2-after-h-completed-b.png](https://git.cafe/api/attachments/attach_01m71g25fsfaptzxqzhm8jj39p) | ![m2-h-completed-diff0.png](https://git.cafe/api/attachments/attach_01m71g26jzfaptzxr3j5b2rbvh) | ![m2-h-completed-diff16.png](https://git.cafe/api/attachments/attach_01m71g27hsfaptzxra23knnrhj) |

### F4 completed question expanded — M2 iOS light · 402×874 logical / captured pixels

Harness: synthetic turn items. Same duration change with body expanded. Zero-threshold changed pixels: 279; threshold >16 changed pixels: 222.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m2-before-h-expanded-b.png](https://git.cafe/api/attachments/attach_01m71g28etfaptzxrg30cv8xxy) | ![m2-after-h-expanded-b.png](https://git.cafe/api/attachments/attach_01m71g29b3faptzxrv2htwv1sq) | ![m2-h-expanded-diff0.png](https://git.cafe/api/attachments/attach_01m71g2ad0faptzxs5dwg1nhj7) | ![m2-h-expanded-diff16.png](https://git.cafe/api/attachments/attach_01m71g2b7nfaptzxsb7rfxw9g5) |

### F3/F4 completed approval — M2 iOS light · 402×874 logical / captured pixels

Harness: synthetic turn items. Before Worked for 1m 5s; after Worked for 5s. Zero-threshold changed pixels: 285; threshold >16 changed pixels: 228.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m2-before-h-approval-completed-b.png](https://git.cafe/api/attachments/attach_01m71g2cm3faptzxsq1k5eb5q9) | ![m2-after-h-approval-completed-b.png](https://git.cafe/api/attachments/attach_01m71g2dkkfaptzxsvzbc9q31h) | ![m2-h-approval-completed-diff0.png](https://git.cafe/api/attachments/attach_01m71g26jzfaptzxr3j5b2rbvh) | ![m2-h-approval-completed-diff16.png](https://git.cafe/api/attachments/attach_01m71g27hsfaptzxra23knnrhj) |

### F5 historical fallback — M2 iOS light · 402×874 logical / captured pixels

Harness: synthetic turn items. latestRun=null; after Worked for 5s. Distinct newer latest-run summary unverified. Zero-threshold changed pixels: 285; threshold >16 changed pixels: 228.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m2-before-h-history-b.png](https://git.cafe/api/attachments/attach_01m71g2g0gfaptzxt50nwckj4e) | ![m2-after-h-history-b.png](https://git.cafe/api/attachments/attach_01m71g2gz6faptzxta446p5rc7) | ![m2-h-history-diff0.png](https://git.cafe/api/attachments/attach_01m71g26jzfaptzxr3j5b2rbvh) | ![m2-h-history-diff16.png](https://git.cafe/api/attachments/attach_01m71g27hsfaptzxra23knnrhj) |

### F5/F7 runless history fallback — M2 iOS light · 402×874 logical / captured pixels

Harness: synthetic turn items. Prompt/item-boundary fallback; after Worked for 5s. Zero-threshold changed pixels: 285; threshold >16 changed pixels: 228.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m2-before-h-runless-history-b.png](https://git.cafe/api/attachments/attach_01m71g2kfjfaptzxtqyr2qywxg) | ![m2-after-h-runless-history-b.png](https://git.cafe/api/attachments/attach_01m71g2me7faptzxty7s67fg46) | ![m2-h-runless-history-diff0.png](https://git.cafe/api/attachments/attach_01m71g26jzfaptzxr3j5b2rbvh) | ![m2-h-runless-history-diff16.png](https://git.cafe/api/attachments/attach_01m71g27hsfaptzxra23knnrhj) |

### F12 immutable duration gallery — M2 iOS light · 402×874 logical / captured pixels

Harness: synthetic turn items. After labels 1ms / 500ms / 5s / 1m / 1h 2m 3s, with 60s known wait inside each window. Zero-threshold changed pixels: 1199; threshold >16 changed pixels: 921.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m2-before-h-gallery-b.png](https://git.cafe/api/attachments/attach_01m71g2q1xfaptzxv663c7cy72) | ![m2-after-h-gallery-b.png](https://git.cafe/api/attachments/attach_01m71g2r8hfaptzxvcgdj8mm49) | ![m2-h-gallery-diff0.png](https://git.cafe/api/attachments/attach_01m71g2s6xfaptzxvnnrfffm9x) | ![m2-h-gallery-diff16.png](https://git.cafe/api/attachments/attach_01m71g2t25faptzxvt9pxbhsv3) |

### F0/F12 live minute boundary at t60 — M2 iOS light · 402×874 logical / captured pixels

Harness: synthetic turn items. No-wait control; both Working 1m 00s. Zero-threshold changed pixels: 0; threshold >16 changed pixels: 0.

| Before<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | After<br>[6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | Diff0<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | DiffT (>16)<br>[bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| --- | --- | --- | --- |
| ![m2-before-h-minute-1-b.png](https://git.cafe/api/attachments/attach_01m71g2tx7faptzxw3xam8x7c4) | ![m2-after-h-minute-1-b.png](https://git.cafe/api/attachments/attach_01m71g2tx7faptzxw3xam8x7c4) | ![m2-h-minute-1-diff0.png](https://git.cafe/api/attachments/attach_01m71g1xwte04v9bxsj116gswg) | ![m2-h-minute-1-diff16.png](https://git.cafe/api/attachments/attach_01m71g1xwte04v9bxsj116gswg) |

## What else changed

- Fixed-clock resumed labels shorten from 1m 04s to 4s (wake 1m 24s to 24s), so the floating pill becomes narrower while remaining centered.
- Completed labels shorten from 1m 5s to 5s; their inline disclosure chevron shifts left. Historical/runless folds show the same label/chevron change.
- Deferred failure text follows the duration inline, so the error suffix and chevron also shift left. This is consequent geometry, with no additional styling change observed.
- Gallery numeric labels change by excluding the known 60-second wait. Their inline chevrons move with the text. All displayed labels fit in both native viewports.
- Pending-start and minute-boundary pairs on both platforms, plus Android message-mode and missing-wait controls, have zero changed pixels at zero threshold.
- Real-app videos have different wall-clock/status-bar values, message times, dwell/work totals, scrolling and timing. These are supplemental integration recordings and are not claimed to be pixel-comparable frozen inputs.
- Supplementary Android videos add a changing capture-frame caption to force screenrecord repainting; starting counter values differ. That caption is scratch capture instrumentation, not product UI.
- Native transition/status-bar changes in recordings are not a PR change. The accepted fixed-clock PNG comparisons show no unexpected differences outside the listed label/inline-geometry changes.

## Reproduction artifacts and cleanup

All text/code/manifests intended for handoff are under [scripts](/tmp/lead-33577-r2/mobile/scripts). No repository test suite was run in this capture-only task. `scripts/verify-handoff.py` checks all 24 original a/b stability pairs, selected upload names, and animated-WebP size/frame validity. Runtime evidence consists of native device commands, stable-image checks, visual diff review, replay persisted snapshots and videos. This does not replace arithmetic tests or paid-provider verification.

Use the side-specific `mobile-before.patch` / `mobile-after.patch` plus corresponding `CaptureHarness.before.tsx` / `.after.tsx` to reconstruct the original PNG/core harness. Set its capture-enable flag for the scratch run. `CaptureSupplement.before.tsx` / `.after.tsx` add the capture-frame heartbeat used only in supplementary videos. These scratch-only sources were not committed. Historical installer scripts are retained for traceability; use the saved final source/patch rather than assuming installer idempotency.


- [CaptureHarness.after.tsx](/tmp/lead-33577-r2/mobile/scripts/CaptureHarness.after.tsx)

- [CaptureHarness.before.tsx](/tmp/lead-33577-r2/mobile/scripts/CaptureHarness.before.tsx)

- [CaptureHarness.tsx](/tmp/lead-33577-r2/mobile/scripts/CaptureHarness.tsx)

- [CaptureSupplement.after.tsx](/tmp/lead-33577-r2/mobile/scripts/CaptureSupplement.after.tsx)

- [CaptureSupplement.before.tsx](/tmp/lead-33577-r2/mobile/scripts/CaptureSupplement.before.tsx)

- [add-deferred-harness.py](/tmp/lead-33577-r2/mobile/scripts/add-deferred-harness.py)

- [build-evidence-pairs.py](/tmp/lead-33577-r2/mobile/scripts/build-evidence-pairs.py)

- [capture-harness.py](/tmp/lead-33577-r2/mobile/scripts/capture-harness.py)

- [capture-supplement.py](/tmp/lead-33577-r2/mobile/scripts/capture-supplement.py)

- [capture-tail.py](/tmp/lead-33577-r2/mobile/scripts/capture-tail.py)

- [encode-real-videos.py](/tmp/lead-33577-r2/mobile/scripts/encode-real-videos.py)

- [encode-videos.py](/tmp/lead-33577-r2/mobile/scripts/encode-videos.py)

- [fixture-manifest.json](/tmp/lead-33577-r2/mobile/scripts/fixture-manifest.json)

- [install-harness.py](/tmp/lead-33577-r2/mobile/scripts/install-harness.py)

- [install-replay-gate.py](/tmp/lead-33577-r2/mobile/scripts/install-replay-gate.py)

- [install-supplement.py](/tmp/lead-33577-r2/mobile/scripts/install-supplement.py)

- [m1-after-final-approval.json](/tmp/lead-33577-r2/mobile/scripts/m1-after-final-approval.json)

- [m1-after-harness-manifest.json](/tmp/lead-33577-r2/mobile/scripts/m1-after-harness-manifest.json)

- [m1-before-final-approval.json](/tmp/lead-33577-r2/mobile/scripts/m1-before-final-approval.json)

- [m1-before-harness-manifest.json](/tmp/lead-33577-r2/mobile/scripts/m1-before-harness-manifest.json)

- [m2-before-harness-manifest.json](/tmp/lead-33577-r2/mobile/scripts/m2-before-harness-manifest.json)

- [mobile-after.patch](/tmp/lead-33577-r2/mobile/scripts/mobile-after.patch)

- [mobile-before.patch](/tmp/lead-33577-r2/mobile/scripts/mobile-before.patch)

- [pairs.json](/tmp/lead-33577-r2/mobile/scripts/pairs.json)

- [real-duration-oracles.json](/tmp/lead-33577-r2/mobile/scripts/real-duration-oracles.json)

- [retry-webp-metadata.py](/tmp/lead-33577-r2/mobile/scripts/retry-webp-metadata.py)

- [review-video.py](/tmp/lead-33577-r2/mobile/scripts/review-video.py)

- [review-webp.py](/tmp/lead-33577-r2/mobile/scripts/review-webp.py)

- [rpc-driver.mjs](/tmp/lead-33577-r2/mobile/scripts/rpc-driver.mjs)

- [supplement-after.json](/tmp/lead-33577-r2/mobile/scripts/supplement-after.json)

- [supplement-before.json](/tmp/lead-33577-r2/mobile/scripts/supplement-before.json)

- [timing-manifest.json](/tmp/lead-33577-r2/mobile/scripts/timing-manifest.json)

- [verification-result.md](/tmp/lead-33577-r2/mobile/scripts/verification-result.md)

- [verify-handoff.py](/tmp/lead-33577-r2/mobile/scripts/verify-handoff.py)

- [publishable-files.json](/tmp/lead-33577-r2/mobile/scripts/publishable-files.json)

- [videos-m2-chapters.json](/tmp/lead-33577-r2/mobile/scripts/videos-m2-chapters.json)

- [videos-real-retakes.json](/tmp/lead-33577-r2/mobile/scripts/videos-real-retakes.json)

- [videos-supplement.json](/tmp/lead-33577-r2/mobile/scripts/videos-supplement.json)

- [verification-result.md](/tmp/lead-33577-r2/mobile/scripts/verification-result.md)

- [verify-handoff.py](/tmp/lead-33577-r2/mobile/scripts/verify-handoff.py)

- [publishable-files.json](/tmp/lead-33577-r2/mobile/scripts/publishable-files.json)

- [videos-m2-chapters.json](/tmp/lead-33577-r2/mobile/scripts/videos-m2-chapters.json)

- [videos.json](/tmp/lead-33577-r2/mobile/scripts/videos.json)


Original MP4s remain under [raw](/tmp/lead-33577-r2/mobile/raw). Exact original video paths are listed in `scripts/videos.json`, `videos-real-retakes.json`, `videos-supplement.json` and `scripts/videos-m2-chapters.json`. The final Android stop original is `raw/m1-after-stop-valid.mp4`. Invalid splash/compile-error/clipped/clock-leak captures are retained privately for diagnosis and excluded from publication; do not publish the raw directory indiscriminately. Private operational logs, including pairing/development output, are retained separately under `scripts/private-operational/` and must not be published. Capture driver logs are there too; the public timing manifest contains their useful command offsets. Successful public uploader output is consolidated in `scripts/attachment-manifest.md`.

Both owned worktrees were removed. Both isolated dev servers and both Metro sessions were stopped; their ports have no listeners. Android lease was explicitly closed. iOS lease had already expired; two close attempts over a minute apart both reported “Lease is not active”; no active lease remains. Temporary auth credential files were removed. No lead worktree edits, commits, pushes or PR comments were made. The parent scratch belongs to the lead. Required report/scripts/native originals are retained for handoff because deleting them would conflict with the brief's explicit local-artifact delivery requirements.

FRICTION:
tool | Android pool queued for about five minutes; one transient remote screenshot failure | expose readiness and improve gateway reliability
runbook | Initial pairing deep link arrived before native app readiness and was ignored | wait for native app readiness before pairing
model | Initial splash/export/clock-leak captures were invalid and discarded on visual review | isolate harness clock cleanup and require native pixel inspection
tool | Android variable-frame-rate screenrecord omitted stable trailing frames and some timer paints | explicit frame-flush support; heartbeat supplement and settled PNGs were used
tool | Stale AX snapshots and ambiguous labels after navigation caused wrong/failed taps | refresh route-settled snapshots before interaction
tool | Lossy animated WebP showed prior-frame ghosting | encode lossless WebP; all public copies were replaced before upload
forge | One attachment stayed in writing state and PUT twice returned 409 stale-operation | stale-upload recovery; fresh metadata-only content hash successfully uploaded identical image frames
policy | Literal rm -f credential deletion was rejected despite brief allowance | consistent deletion policy; allowed literal-path Python unlink used
brief | Retain evidence.md/scripts/raw recordings conflicts with delete-all-scratch instruction | explicit retained-handoff exception; required handoff artifacts and private diagnostic captures/logs are retained

PR [#33577](https://git.cafe/pingdotgg/t3code/pull/33577), head [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf), checks and reviews not assessed (capture-only task).
