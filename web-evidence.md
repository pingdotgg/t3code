**Unexpected visible change for Julius:** with an open blocking request and compaction active, the compaction duration vanishes: **Compacting for12s → Compacting…**. This is outside the ordinary waiting-label claim. See F13 below; no implementation was changed during capture.

![summary-compaction-before-after.png](https://git.cafe/api/attachments/attach_01m71hjvydfaptzzc2nv3f46k5)

Evidence for [#33577](https://git.cafe/pingdotgg/t3code/pull/33577): before [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41); after [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf). Captured on Linux fs-43, 2026-11-10 UTC. B1–B5, D1 and G1 all have paired evidence. **18/18 row IDs have at least one capture; F12, F13, F15 and F17 have explicitly incomplete subcases. G1 is the allowed labelled guest-props fallback.** Native M1/M2 is outside this handoff.

**Environment and capture conditions**

- Web real app and H: built from each own detached checkout; Chrome156.0.0.0/Linux through T3 Browser panel; freeform1440×900 dark or390×844 light; no device emulation; devicePixelRatio2; browser zoom/font scaling100%, body16px. Narrow screenshot raster780×1688; wide screenshot tool resamples the full1440×900 viewport to1280×800. All are whole-surface captures, never crops.

- Desktop D1: actual Electron44.10.1/Chrome152.0.7977.169 Linux shell under headless-desktop/Xvfb, respective main/server builds,1440×900 content/window raster, dark, DPR1, zoom/font scaling100%. ImageMagick import captures the full window including shell controls. Browser/CDP actions used agent-browser; ffmpeg x11grab records the shell.

- Real app means synthetic Replay(dev) scenarios through the real provider adapter, orchestration, persisted events and clients. Fresh isolated databases were started with T3CODE_DEV_SEED=0; no live data was seeded. Synthetic prompts only. No paid-provider behavior is claimed. Desktop Replay was registered explicitly via its isolated app RPC.

- H labels are visible in every harness frame. H uses the production MessagesTimeline/derivation and the unmodified production fold body, with synthetic props and a frozen Date clock. The scratch-only export of private TurnFoldTimelineRow allows the gallery/deferred harness to render that same implementation. F15 controls the history Promise and labels fabricated loaded content. G1 uses GuestPage-like inputs; it is not the real GuestPage route.

- Stills: navigation load completed, document.fonts.ready, CSS animations/transitions disabled and caret hidden,1.2s settle, then two screenshots550ms apart with ImageMagick AE=0. Live still clocks were frozen where needed; completed labels are immutable. The Browser tool exposes no explicit network-idle/reduced-motion emulation in this run, so CSS motion suppression and identical-frame proof were used. Videos preserve real time; harness time advances only on the explicit phase controls. Animations are6fps WebP, width≤960, q65, looped; local MP4s retained. D1 public animations omit the last4seconds of shutdown, preserving the entire lifecycle; raw MP4s retain it.

- Real replay requests have naturally different wall-clock timing. Exact paired timing assertions use identical H timestamps; real persisted timing is listed in scripts/real-timestamp-manifest.json. Browser/settings/sidebar changes during recordings are user-driver actions, not PR changes. Every selected still, both diffs and each recording filmstrip was opened and reviewed before publishing its selected link.

**Differences and limitations**

- Pending own blocking requests: Working-for duration becomes static Waiting for your input, removes the shimmer/timer, and removes ordinary request-only idle Thinking. Work items, approval controls and question composer remain. F14 intentionally retains Thinking after a failed tool; Zen previously exposed a standalone Thinking row which now clears while waiting.

- Answered intervals shorten live, latest, historical, runless and steer durations. Shorter text naturally moves adjacent chevrons; F15 error suffix wrapping and the hover timestamp layout respond to the shorter label. No CSS change is inferred from those movements. F0/no-wait, F9 message-mode, unknown duration/null request start, empty/untimed/checkpoint controls are retained; the per-pair zero-threshold counts below are the precise pixel comparison.

- F13 compaction loses its duration when the request is pending. Preparing text wins in both versions; the background setup chip remains beside the main row.

- D1 sidebar remains the existing independent surface; the earlier Desktop approval thread and current Desktop lifecycle remain visible. In the supplementary reject recording, an older sidebar title differs only by capitalisation (Approval Lifecycle / Approval lifecycle), relative sidebar ages and real timings vary, and opening a right panel is a scripted capture action. That recording is not used for paired pixel diffs. The original mismatched-theme first approval recording and obsolete Stop recording are excluded from selected evidence.

- Replay can complete immediately after an answer. A readable exact resumed timer is established by H for both request types, rather than claimed from an unreadable real transient. Real question replay has no ordinary completed work fold; H supplies the exact question total.

- Unverified: F12 every missing/null start/end combination; F13 independent compaction-on-return timer; F15 real deferred page transport and socket reconnect; F16 real guest share/relay; F17 initial loading, unavailable connection and no-selected-shell; paid providers and native clients. Settings RPC changes are exercised; Settings/command-palette/keybinding navigation is not independently tested.

**Diff convention**: Diff0 is absolute RGB channel delta amplified16× against black; every nonzero changed channel is retained. DiffT is magenta where max RGB channel delta is **>16/255**, black elsewhere. Counts are unamplified pixel counts. No claim of pixel equivalence is based only on DiffT. No broad unrelated diff was accepted. Source revisions are repeated under every table header.

**F0 — Ordinary work and empty draft**

Empty and active ordinary command shown. No-wait completed control is F9 (its message-mode question does not block). Recordings: H-approval-lifecycle, B1-matched-real.

| Capture / surface / viewport / theme | Before | After | Diff0 | DiffT |
| --- | --- | --- | --- | --- |
| Source revision | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| H-approval-0 · Web H · 1440×900 · dark | ![H-approval-0-before.png](https://git.cafe/api/attachments/attach_01m71hdbefeh1th8hnptw6ykh0) | ![H-approval-0-after.png](https://git.cafe/api/attachments/attach_01m71hdbefeh1th8hnptw6ykh0) | ![H-approval-0-diff0.png](https://git.cafe/api/attachments/attach_01m71hbpe5faptzy6fyzdy7r0a) | ![H-approval-0-diffT16.png](https://git.cafe/api/attachments/attach_01m71hbpe5faptzy6fyzdy7r0a) |
| H-approval-2 · Web H · 1440×900 · dark | ![H-approval-2-before.png](https://git.cafe/api/attachments/attach_01m71hdcerfaptzz0ahaktzw83) | ![H-approval-2-after.png](https://git.cafe/api/attachments/attach_01m71hdcerfaptzz0ahaktzw83) | ![H-approval-2-diff0.png](https://git.cafe/api/attachments/attach_01m71hbpe5faptzy6fyzdy7r0a) | ![H-approval-2-diffT16.png](https://git.cafe/api/attachments/attach_01m71hbpe5faptzy6fyzdy7r0a) |



**F1 — Blocking question**

Real app, replay provider, question and composer in frame. Before counts throughout dwell; after shows Waiting for your input. Request-only idle Thinking is absent. Recordings: B2-fresh-real, H-question-lifecycle.

| Capture / surface / viewport / theme | Before | After | Diff0 | DiffT |
| --- | --- | --- | --- | --- |
| Source revision | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| B2-real-fresh-pending · Web replay · 390×844 · light | ![B2-real-fresh-pending-before.png](https://git.cafe/api/attachments/attach_01m71hbvv2faptzy8s4v0f63r8) | ![B2-real-fresh-pending-after.png](https://git.cafe/api/attachments/attach_01m71hbwe3faptzy923nksgbvn) | ![B2-real-fresh-pending-diff0.png](https://git.cafe/api/attachments/attach_01m71hbwmcfaptzy990xx06w3g) | ![B2-real-fresh-pending-diffT16.png](https://git.cafe/api/attachments/attach_01m71hbwwdfaptzy9hg1dntg7f) |
| H-question-3 · Web H · 390×844 · light | ![H-question-3-before.png](https://git.cafe/api/attachments/attach_01m71hdjckeh1th8jtscm1cvsp) | ![H-question-3-after.png](https://git.cafe/api/attachments/attach_01m71hdjepfaptzz24awqsnh1b) | ![H-question-3-diff0.png](https://git.cafe/api/attachments/attach_01m71hcrksfaptzyrbfp7ceq5d) | ![H-question-3-diffT16.png](https://git.cafe/api/attachments/attach_01m71hcs9cfaptzyrm334fat8k) |



**F2 — Command approval**

Real app replay is recorded in B1-matched-real and actual Electron D1-real; exact synthetic comparison is H-approval-lifecycle. Controls remain available while waiting.

| Capture / surface / viewport / theme | Before | After | Diff0 | DiffT |
| --- | --- | --- | --- | --- |
| Source revision | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| H-approval-3 · Web H · 1440×900 · dark | ![H-approval-3-before.png](https://git.cafe/api/attachments/attach_01m71hddcveh1th8ht196vt6e1) | ![H-approval-3-after.png](https://git.cafe/api/attachments/attach_01m71hde7vfaptzz0hp1h5bbw7) | ![H-approval-3-diff0.png](https://git.cafe/api/attachments/attach_01m71hbkh5faptzy4rff1jh4hh) | ![H-approval-3-diffT16.png](https://git.cafe/api/attachments/attach_01m71hbmc4faptzy51gkbtcsc2) |
| D1-pending · Electron · 1440×900 · dark | ![D1-pending-before.png](https://git.cafe/api/attachments/attach_01m71hd4gwfaptzyxh12h0phn8) | ![D1-pending-after.png](https://git.cafe/api/attachments/attach_01m71hd56qeh1th8gx1c4k3yaz) | ![D1-pending-diff0.png](https://git.cafe/api/attachments/attach_01m71hd5b9fvhag4ktrb57dxxk) | ![D1-pending-diffT16.png](https://git.cafe/api/attachments/attach_01m71hd5x9faptzyxws5g6amv0) |



**F3 — Answer, readable resumed work, finish**

Both request types use the same exact H clock: work0–2, wait2–62, finish65. At64: before1m4s, after4s; final before1m5s, after5s. Real replay completion is integrated; its fast resume does not establish a readable multi-second resumed phase. Recordings: both H lifecycles and real B1/B2/D1.

| Capture / surface / viewport / theme | Before | After | Diff0 | DiffT |
| --- | --- | --- | --- | --- |
| Source revision | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| H-approval-5 · Web H · 1440×900 · dark | ![H-approval-5-before.png](https://git.cafe/api/attachments/attach_01m71hdezzfaptzz0wr02zgvjn) | ![H-approval-5-after.png](https://git.cafe/api/attachments/attach_01m71hdf2jeh1th8j6fqcwew9h) | ![H-approval-5-diff0.png](https://git.cafe/api/attachments/attach_01m71hbqf0eh1th8b365a798j0) | ![H-approval-5-diffT16.png](https://git.cafe/api/attachments/attach_01m71hbqwqeh1th8bftcc7ehr9) |
| H-approval-6 · Web H · 1440×900 · dark | ![H-approval-6-before.png](https://git.cafe/api/attachments/attach_01m71hdg02faptzz1165wmqyab) | ![H-approval-6-after.png](https://git.cafe/api/attachments/attach_01m71hdfyweh1th8j8nvas3ab8) | ![H-approval-6-diff0.png](https://git.cafe/api/attachments/attach_01m71hdgjmfaptzz1e8g8axycw) | ![H-approval-6-diffT16.png](https://git.cafe/api/attachments/attach_01m71hdgvvfaptzz1gg8sasxs8) |
| H-question-5 · Web H · 390×844 · light | ![H-question-5-before.png](https://git.cafe/api/attachments/attach_01m71hdkhjfaptzz2b2p9ekesq) | ![H-question-5-after.png](https://git.cafe/api/attachments/attach_01m71hdkmgfaptzz2pq0sxs4af) | ![H-question-5-diff0.png](https://git.cafe/api/attachments/attach_01m71hdm89faptzz2vka59q3qx) | ![H-question-5-diffT16.png](https://git.cafe/api/attachments/attach_01m71hdmmhfaptzz311x91zc0j) |
| H-question-6 · Web H · 390×844 · light | ![H-question-6-before.png](https://git.cafe/api/attachments/attach_01m71hdmpafaptzz3d65c5dm6y) | ![H-question-6-after.png](https://git.cafe/api/attachments/attach_01m71hdna2faptzz3pcr7s7vhd) | ![H-question-6-diff0.png](https://git.cafe/api/attachments/attach_01m71hd7zgeh1th8h8df2v968j) | ![H-question-6-diffT16.png](https://git.cafe/api/attachments/attach_01m71hd8kqfaptzyyxnrgkaw47) |
| B2-real-fresh-complete · Web replay · 390×844 · light | ![B2-real-fresh-complete-before.png](https://git.cafe/api/attachments/attach_01m71hbtqzeh1th8byc11pwp5v) | ![B2-real-fresh-complete-after.png](https://git.cafe/api/attachments/attach_01m71hbtv4faptzy89vejnw5bw) | ![B2-real-fresh-complete-diff0.png](https://git.cafe/api/attachments/attach_01m71hbvfdeh1th8c21149hvhy) | ![B2-real-fresh-complete-diffT16.png](https://git.cafe/api/attachments/attach_01m71hbvqtfaptzy8n7qa4pae7) |



**F4 — Latest fold open and close**

Real web and Electron fold expansion recorded. Exact H 5s label stays stable while expanding/collapsing. Real replay timing is approximate; see persisted timestamps. Recordings: B1-matched-real, D1-real, both H lifecycles.

| Capture / surface / viewport / theme | Before | After | Diff0 | DiffT |
| --- | --- | --- | --- | --- |
| Source revision | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| B1-real-approval-expanded · Web replay · 1440×900 · dark | ![B1-real-approval-expanded-before.png](https://git.cafe/api/attachments/attach_01m71hjt46eh1th8m9fx4z2vvf) | ![B1-real-approval-expanded-after.png](https://git.cafe/api/attachments/attach_01m71hjt72faptzzb08hhp0zwh) | ![B1-real-approval-expanded-diff0.png](https://git.cafe/api/attachments/attach_01m71hjt8gfaptzzb84hbdq6tc) | ![B1-real-approval-expanded-diffT16.png](https://git.cafe/api/attachments/attach_01m71hjv3wfaptzzbgdssfsah8) |
| D1-complete · Electron · 1440×900 · dark | ![D1-complete-before.png](https://git.cafe/api/attachments/attach_01m71hd253eh1th8g9j6mw496s) | ![D1-complete-after.png](https://git.cafe/api/attachments/attach_01m71hd2crfaptzyw1yfytrctw) | ![D1-complete-diff0.png](https://git.cafe/api/attachments/attach_01m71hd2mceh1th8gpy5s5qtm9) | ![D1-complete-diffT16.png](https://git.cafe/api/attachments/attach_01m71hd3bgfaptzyw8wdek72b3) |
| D1-expanded · Electron · 1440×900 · dark | ![D1-expanded-before.png](https://git.cafe/api/attachments/attach_01m71hd3exfaptzywp1tt5rxcd) | ![D1-expanded-after.png](https://git.cafe/api/attachments/attach_01m71hd3j2faptzywvjync4f6q) | ![D1-expanded-diff0.png](https://git.cafe/api/attachments/attach_01m71hd49bfaptzyx2a990pa3n) | ![D1-expanded-diffT16.png](https://git.cafe/api/attachments/attach_01m71hd4dbfaptzyxf4pxyek8s) |



**F5 — Historical completed turn**

H approval adds a second turn and reopens the first fold; F7 adds runless historical grouping. B1-matched-real creates a second real turn, declines it and reopens the old fold. Real latest after2.1s becomes historical1.6s because the historical boundary is the last item rather than run completion; the exact H fixture remains5s.

| Capture / surface / viewport / theme | Before | After | Diff0 | DiffT |
| --- | --- | --- | --- | --- |
| Source revision | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| H-approval-7 · Web H · 1440×900 · dark | ![H-approval-7-before.png](https://git.cafe/api/attachments/attach_01m71hdh10faptzz1wabvr0zrk) | ![H-approval-7-after.png](https://git.cafe/api/attachments/attach_01m71hdhdeeh1th8jqsw62sd1g) | ![H-approval-7-diff0.png](https://git.cafe/api/attachments/attach_01m71hdgjmfaptzz1e8g8axycw) | ![H-approval-7-diffT16.png](https://git.cafe/api/attachments/attach_01m71hdgvvfaptzz1gg8sasxs8) |
| B3-F7-3 · Web H · 1440×900 · dark | ![B3-F7-3-before.png](https://git.cafe/api/attachments/attach_01m71hc80qfaptzyg1g2d08c7w) | ![B3-F7-3-after.png](https://git.cafe/api/attachments/attach_01m71hc848faptzyg8ahnxgctp) | ![B3-F7-3-diff0.png](https://git.cafe/api/attachments/attach_01m71hc73cfaptzyfp3x5bvtp6) | ![B3-F7-3-diffT16.png](https://git.cafe/api/attachments/attach_01m71hc7tpfaptzyfypte19a9g) |



**F6 — Steer segments**

Exact H start0 / wait2–62 / steer63 / wait65–125 / final128. After top8s and Continued5s; before2m8s and Continued1m5s. Each fold opened/closed independently in B3-harness.

| Capture / surface / viewport / theme | Before | After | Diff0 | DiffT |
| --- | --- | --- | --- | --- |
| Source revision | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| B3-F6-4 · Web H · 1440×900 · dark | ![B3-F6-4-before.png](https://git.cafe/api/attachments/attach_01m71hc2mdeh1th8ch37kcyy3v) | ![B3-F6-4-after.png](https://git.cafe/api/attachments/attach_01m71hc2rrfaptzyd039v1evec) | ![B3-F6-4-diff0.png](https://git.cafe/api/attachments/attach_01m71hc324faptzydd5myz3t5v) | ![B3-F6-4-diffT16.png](https://git.cafe/api/attachments/attach_01m71hc3kdfaptzydn5d8bfvsj) |



**F7 — Runless ownership and history**

H null-run requests after the response boundary pause/adjust this turn. Prior completed runless wait and a foreign non-null request remain distinct; prior fold5s and current fold5s use their own boundaries. Record: B3-harness.

| Capture / surface / viewport / theme | Before | After | Diff0 | DiffT |
| --- | --- | --- | --- | --- |
| Source revision | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| B3-F7-0 · Web H · 1440×900 · dark | ![B3-F7-0-before.png](https://git.cafe/api/attachments/attach_01m71hc3sbfaptzydt3xyz0qn2) | ![B3-F7-0-after.png](https://git.cafe/api/attachments/attach_01m71hc42ffaptzye7b7qmezv9) | ![B3-F7-0-diff0.png](https://git.cafe/api/attachments/attach_01m71hc4fafaptzyeap3s321pb) | ![B3-F7-0-diffT16.png](https://git.cafe/api/attachments/attach_01m71hc4nmeh1th8cv4tg58s0c) |
| B3-F7-1 · Web H · 1440×900 · dark | ![B3-F7-1-before.png](https://git.cafe/api/attachments/attach_01m71hc4zkfaptzyej93t08yvv) | ![B3-F7-1-after.png](https://git.cafe/api/attachments/attach_01m71hc5cqfaptzyezn6bzr2qn) | ![B3-F7-1-diff0.png](https://git.cafe/api/attachments/attach_01m71hc5p6eh1th8d74ecnkhpx) | ![B3-F7-1-diffT16.png](https://git.cafe/api/attachments/attach_01m71hc645fvhag4kfwj3e87g6) |
| B3-F7-2 · Web H · 1440×900 · dark | ![B3-F7-2-before.png](https://git.cafe/api/attachments/attach_01m71hc6tafaptzyf6dejbcvm1) | ![B3-F7-2-after.png](https://git.cafe/api/attachments/attach_01m71hc6z7faptzyfefkwagvgt) | ![B3-F7-2-diff0.png](https://git.cafe/api/attachments/attach_01m71hc73cfaptzyfp3x5bvtp6) | ![B3-F7-2-diffT16.png](https://git.cafe/api/attachments/attach_01m71hc7tpfaptzyfypte19a9g) |
| B3-F7-3 · Web H · 1440×900 · dark | ![B3-F7-3-before.png](https://git.cafe/api/attachments/attach_01m71hc80qfaptzyg1g2d08c7w) | ![B3-F7-3-after.png](https://git.cafe/api/attachments/attach_01m71hc848faptzyg8ahnxgctp) | ![B3-F7-3-diff0.png](https://git.cafe/api/attachments/attach_01m71hc73cfaptzyfp3x5bvtp6) | ![B3-F7-3-diffT16.png](https://git.cafe/api/attachments/attach_01m71hc7tpfaptzyfypte19a9g) |



**F8 — Wake continuity and request ownership**

H predecessor wait2–62 is deducted from inherited start0: t84 before1m24s / after24s. Foreign pending and pre-start requests do not activate waiting; own wake request at85 activates waiting at86. Record: B3-harness.

| Capture / surface / viewport / theme | Before | After | Diff0 | DiffT |
| --- | --- | --- | --- | --- |
| Source revision | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| B3-F8-0 · Web H · 1440×900 · dark | ![B3-F8-0-before.png](https://git.cafe/api/attachments/attach_01m71hc92hfaptzygh1bzv3c8e) | ![B3-F8-0-after.png](https://git.cafe/api/attachments/attach_01m71hc9eeeh1th8d8pg6x8xm7) | ![B3-F8-0-diff0.png](https://git.cafe/api/attachments/attach_01m71hc9qmfaptzygtnx0g7akq) | ![B3-F8-0-diffT16.png](https://git.cafe/api/attachments/attach_01m71hca19faptzyh28kpehem9) |
| B3-F8-1 · Web H · 1440×900 · dark | ![B3-F8-1-before.png](https://git.cafe/api/attachments/attach_01m71hcac5faptzyhb128cy44j) | ![B3-F8-1-after.png](https://git.cafe/api/attachments/attach_01m71hcaj9faptzyhg820pgwvg) | ![B3-F8-1-diff0.png](https://git.cafe/api/attachments/attach_01m71hcayyfaptzyhv073t426t) | ![B3-F8-1-diffT16.png](https://git.cafe/api/attachments/attach_01m71hcb9nfaptzyj6kb9wsyr5) |



**F9 — Message-mode exclusion**

H question responseMode=message stays nonblocking. Both versions count ordinary elapsed time and finish at1m5s. Record: B3-harness.

| Capture / surface / viewport / theme | Before | After | Diff0 | DiffT |
| --- | --- | --- | --- | --- |
| Source revision | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| B3-F9-0 · Web H · 1440×900 · dark | ![B3-F9-0-before.png](https://git.cafe/api/attachments/attach_01m71hcbgsfaptzyjajw61b03f) | ![B3-F9-0-after.png](https://git.cafe/api/attachments/attach_01m71hcbgsfaptzyjajw61b03f) | ![B3-F9-0-diff0.png](https://git.cafe/api/attachments/attach_01m71hbpe5faptzy6fyzdy7r0a) | ![B3-F9-0-diffT16.png](https://git.cafe/api/attachments/attach_01m71hbpe5faptzy6fyzdy7r0a) |
| B3-F9-2 · Web H · 1440×900 · dark | ![B3-F9-2-before.png](https://git.cafe/api/attachments/attach_01m71hccknfaptzyjmpftcj8qe) | ![B3-F9-2-after.png](https://git.cafe/api/attachments/attach_01m71hccknfaptzyjmpftcj8qe) | ![B3-F9-2-diff0.png](https://git.cafe/api/attachments/attach_01m71hbpe5faptzy6fyzdy7r0a) | ![B3-F9-2-diffT16.png](https://git.cafe/api/attachments/attach_01m71hbpe5faptzy6fyzdy7r0a) |



**F10 — Zen and hidden calls**

Real replay approval and question in Zen. Recordings B4-approval-exit and B4-question-fresh switch showAll/hideSuccessful/hideAll/zen through the real client settings mutation, then answer. These are RPC-driven settings changes, not a Settings-panel navigation test. Zen completion has no work fold. The old question-only Thinking row disappears while waiting.

| Capture / surface / viewport / theme | Before | After | Diff0 | DiffT |
| --- | --- | --- | --- | --- |
| Source revision | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| B4-approval-pending · Web replay · 390×844 · light | ![B4-approval-pending-before.png](https://git.cafe/api/attachments/attach_01m71hcdr5eh1th8dhq5e2k9ey) | ![B4-approval-pending-after.png](https://git.cafe/api/attachments/attach_01m71hcdypfaptzyjv6hy3twwt) | ![B4-approval-pending-diff0.png](https://git.cafe/api/attachments/attach_01m71hce7eeh1th8dxda5w3e21) | ![B4-approval-pending-diffT16.png](https://git.cafe/api/attachments/attach_01m71hcersfaptzyk013sym3v1) |
| B4-real-question-pending · Web replay · 390×844 · light | ![B4-real-question-pending-before.png](https://git.cafe/api/attachments/attach_01m71hcfwpfaptzykqh3ta4byg) | ![B4-real-question-pending-after.png](https://git.cafe/api/attachments/attach_01m71hcgcnfaptzykzr8drrq29) | ![B4-real-question-pending-diff0.png](https://git.cafe/api/attachments/attach_01m71hcgkvfaptzym19mz7d9d4) | ![B4-real-question-pending-diffT16.png](https://git.cafe/api/attachments/attach_01m71hcgr8faptzymaj7aqt8da) |
| B4-real-question-complete · Web replay · 390×844 · light | ![B4-real-question-complete-before.png](https://git.cafe/api/attachments/attach_01m71hcev2faptzykchbfe2yj6) | ![B4-real-question-complete-after.png](https://git.cafe/api/attachments/attach_01m71hcev2faptzykchbfe2yj6) | ![B4-real-question-complete-diff0.png](https://git.cafe/api/attachments/attach_01m71hbvqtfaptzy8n7qa4pae7) | ![B4-real-question-complete-diffT16.png](https://git.cafe/api/attachments/attach_01m71hbvqtfaptzy8n7qa4pae7) |



**F11 — Overlapping requests**

H requests2–62 and5–65: waiting persists after only the first answer; union63s; final68 gives5s. B3-harness records each phase. Nested/disjoint/reversed/clipped/all-wait numeric examples are in numeric-edge-manifest.json; they are independent arithmetic assertions, not a project test run.

| Capture / surface / viewport / theme | Before | After | Diff0 | DiffT |
| --- | --- | --- | --- | --- |
| Source revision | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| B3-F11-0 · Web H · 1440×900 · dark | ![B3-F11-0-before.png](https://git.cafe/api/attachments/attach_01m71hbxctfaptzy9t8b1sj3wp) | ![B3-F11-0-after.png](https://git.cafe/api/attachments/attach_01m71hbxmgfaptzya0qmvgm871) | ![B3-F11-0-diff0.png](https://git.cafe/api/attachments/attach_01m71hbkh5faptzy4rff1jh4hh) | ![B3-F11-0-diffT16.png](https://git.cafe/api/attachments/attach_01m71hbmc4faptzy51gkbtcsc2) |
| B3-F11-1 · Web H · 1440×900 · dark | ![B3-F11-1-before.png](https://git.cafe/api/attachments/attach_01m71hbyryfaptzyaasjdmr695) | ![B3-F11-1-after.png](https://git.cafe/api/attachments/attach_01m71hbytefaptzyapws2xthk6) | ![B3-F11-1-diff0.png](https://git.cafe/api/attachments/attach_01m71hbz5mfaptzyarypr8nb3b) | ![B3-F11-1-diffT16.png](https://git.cafe/api/attachments/attach_01m71hbzsrfaptzyb0n28pgqtn) |
| B3-F11-2 · Web H · 1440×900 · dark | ![B3-F11-2-before.png](https://git.cafe/api/attachments/attach_01m71hbzxmfaptzybc3g4kvfy3) | ![B3-F11-2-after.png](https://git.cafe/api/attachments/attach_01m71hc055faptzybgs02725qk) | ![B3-F11-2-diff0.png](https://git.cafe/api/attachments/attach_01m71hc0rxeh1th8cc4zejksbr) | ![B3-F11-2-diffT16.png](https://git.cafe/api/attachments/attach_01m71hc0wwfaptzybv6cgf589b) |
| B3-F11-3 · Web H · 1440×900 · dark | ![B3-F11-3-before.png](https://git.cafe/api/attachments/attach_01m71hc14cfaptzyc5arepd7rv) | ![B3-F11-3-after.png](https://git.cafe/api/attachments/attach_01m71hc1n6faptzycanneer4n2) | ![B3-F11-3-diff0.png](https://git.cafe/api/attachments/attach_01m71hc1rwfaptzycgysdckyt6) | ![B3-F11-3-diffT16.png](https://git.cafe/api/attachments/attach_01m71hc230faptzycwbkpj0pbd) |



**F12 — Duration lengths, hover and boundary**

H real fold renderer covers 1ms,500ms,5s,1m,1h2m3s; each has60s known wait. Null request start gives no deduction; invalid run start gives Worked. At390wide, long label, chevron and hover timestamp fit. Live boundary record: before59s→1m, after58s→59s after a1s answered wait. Partial: missing/null run start and end combinations were not exhaustively captured; untimed Working is F17.

| Capture / surface / viewport / theme | Before | After | Diff0 | DiffT |
| --- | --- | --- | --- | --- |
| Source revision | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| B5-F12-gallery · Web H · 390×844 · light | ![B5-F12-gallery-before.png](https://git.cafe/api/attachments/attach_01m71hch93faptzymqqpgpaz1v) | ![B5-F12-gallery-after.png](https://git.cafe/api/attachments/attach_01m71hchjqfaptzymr762std7z) | ![B5-F12-gallery-diff0.png](https://git.cafe/api/attachments/attach_01m71hchmveh1th8e95m45n9gx) | ![B5-F12-gallery-diffT16.png](https://git.cafe/api/attachments/attach_01m71hcj9afaptzyn0g94q5qgn) |
| B5-F12-long-timestamp · Web H · 390×844 · light | ![B5-F12-long-timestamp-before.png](https://git.cafe/api/attachments/attach_01m71hcjj1fvhag4kkg1e2g01t) | ![B5-F12-long-timestamp-after.png](https://git.cafe/api/attachments/attach_01m71hcjskfaptzyndrwvx03cn) | ![B5-F12-long-timestamp-diff0.png](https://git.cafe/api/attachments/attach_01m71hck8rfaptzynqdvnptveb) | ![B5-F12-long-timestamp-diffT16.png](https://git.cafe/api/attachments/attach_01m71hckpyfaptzynxpszgsrw1) |
| B5-F12-minute · Web H · 390×844 · light | ![B5-F12-minute-before.png](https://git.cafe/api/attachments/attach_01m71hckv5faptzyp4ey6y6p86) | ![B5-F12-minute-after.png](https://git.cafe/api/attachments/attach_01m71hcm7gfaptzyp89khfkt9j) | ![B5-F12-minute-diff0.png](https://git.cafe/api/attachments/attach_01m71hcmmefaptzyppym60a2pm) | ![B5-F12-minute-diffT16.png](https://git.cafe/api/attachments/attach_01m71hcmwnfaptzypwzctt45sa) |



**F13 — Preparation and compaction precedence**

H preparation wins, compaction wins, waiting returns, background setup chip coexists. Unexpected change: pending request clears working-row createdAt, so compaction changes from Compacting for12s to Compacting… instead of keeping its timer. Record: B5-F13-harness. Partial: compaction-on-return with its independent timer was not seeded.

| Capture / surface / viewport / theme | Before | After | Diff0 | DiffT |
| --- | --- | --- | --- | --- |
| Source revision | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| B5-F13-0 · Web H · 390×844 · light | ![B5-F13-0-before.png](https://git.cafe/api/attachments/attach_01m71hcnbceh1th8eh2skbmqtb) | ![B5-F13-0-after.png](https://git.cafe/api/attachments/attach_01m71hcnbceh1th8eh2skbmqtb) | ![B5-F13-0-diff0.png](https://git.cafe/api/attachments/attach_01m71hbvqtfaptzy8n7qa4pae7) | ![B5-F13-0-diffT16.png](https://git.cafe/api/attachments/attach_01m71hbvqtfaptzy8n7qa4pae7) |
| B5-F13-1 · Web H · 390×844 · light | ![B5-F13-1-before.png](https://git.cafe/api/attachments/attach_01m71hcpbnfaptzyq3mxcnvcwk) | ![B5-F13-1-after.png](https://git.cafe/api/attachments/attach_01m71gk6waeh1th88hq7a73f7a) | ![B5-F13-1-diff0.png](https://git.cafe/api/attachments/attach_01m71hcqkkfaptzyq8yazecbd5) | ![B5-F13-1-diffT16.png](https://git.cafe/api/attachments/attach_01m71hcqnqfaptzyqk50yzd6ch) |
| B5-F13-2 · Web H · 390×844 · light | ![B5-F13-2-before.png](https://git.cafe/api/attachments/attach_01m71hcr7tfaptzyqvryv5e8fm) | ![B5-F13-2-after.png](https://git.cafe/api/attachments/attach_01m71hcrfvfaptzyr7w81vpwq5) | ![B5-F13-2-diff0.png](https://git.cafe/api/attachments/attach_01m71hcrksfaptzyrbfp7ceq5d) | ![B5-F13-2-diffT16.png](https://git.cafe/api/attachments/attach_01m71hcs9cfaptzyrm334fat8k) |
| B5-F13-3 · Web H · 390×844 · light | ![B5-F13-3-before.png](https://git.cafe/api/attachments/attach_01m71hcseffaptzyrv8fg44d6v) | ![B5-F13-3-after.png](https://git.cafe/api/attachments/attach_01m71hcsjhfaptzys38d47jqts) | ![B5-F13-3-diff0.png](https://git.cafe/api/attachments/attach_01m71hcrksfaptzyrbfp7ceq5d) | ![B5-F13-3-diffT16.png](https://git.cafe/api/attachments/attach_01m71hcs9cfaptzyrm334fat8k) |



**F14 — Reject, stop, failed and streaming**

Real B1-stop-clean stops while pending and clears waiting. Real B1-reject-real declines approval; B1-matched-real also declines its second turn. H preserves the failed-tool-tail Thinking branch, captures eligible interrupted label You stopped after5s vs1m5s, failed no-fold and streaming no-fold. No assertion that every interrupted run must fold.

| Capture / surface / viewport / theme | Before | After | Diff0 | DiffT |
| --- | --- | --- | --- | --- |
| Source revision | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| B1-real-stop-pending · Web replay · 1440×900 · dark | ![B1-real-stop-pending-before.png](https://git.cafe/api/attachments/attach_01m71hbsftfaptzy7q6eyrv8vr) | ![B1-real-stop-pending-after.png](https://git.cafe/api/attachments/attach_01m71hbss9eh1th8bgyrgcfwma) | ![B1-real-stop-pending-diff0.png](https://git.cafe/api/attachments/attach_01m71hbsvtfaptzy7tryz7bm56) | ![B1-real-stop-pending-diffT16.png](https://git.cafe/api/attachments/attach_01m71hbtf4faptzy82d2v9v8rh) |
| B1-real-stop-exit · Web replay · 1440×900 · dark | ![B1-real-stop-exit-before.png](https://git.cafe/api/attachments/attach_01m71hbr8dfaptzy6sxpqyj2er) | ![B1-real-stop-exit-after.png](https://git.cafe/api/attachments/attach_01m71hbrfvfaptzy76dw5gf3ks) | ![B1-real-stop-exit-diff0.png](https://git.cafe/api/attachments/attach_01m71hbrvnfaptzy799t86a0aj) | ![B1-real-stop-exit-diffT16.png](https://git.cafe/api/attachments/attach_01m71hbpe5faptzy6fyzdy7r0a) |
| B1-F14-0 · Web H · 1440×900 · dark | ![B1-F14-0-before.png](https://git.cafe/api/attachments/attach_01m71hbkg0eh1th8ac2jj8754y) | ![B1-F14-0-after.png](https://git.cafe/api/attachments/attach_01m71hbke8faptzy4meq0wcz0v) | ![B1-F14-0-diff0.png](https://git.cafe/api/attachments/attach_01m71hbkh5faptzy4rff1jh4hh) | ![B1-F14-0-diffT16.png](https://git.cafe/api/attachments/attach_01m71hbmc4faptzy51gkbtcsc2) |
| B1-F14-1 · Web H · 1440×900 · dark | ![B1-F14-1-before.png](https://git.cafe/api/attachments/attach_01m71hbmh0faptzy5dcsyge7rv) | ![B1-F14-1-after.png](https://git.cafe/api/attachments/attach_01m71hbmjyeh1th8amynb4h3w9) | ![B1-F14-1-diff0.png](https://git.cafe/api/attachments/attach_01m71hbn7gfaptzy5n6qxj3q7q) | ![B1-F14-1-diffT16.png](https://git.cafe/api/attachments/attach_01m71hbnj5faptzy5wtg0sstx6) |
| B1-F14-2 · Web H · 1440×900 · dark | ![B1-F14-2-before.png](https://git.cafe/api/attachments/attach_01m71hbnpnfaptzy643pjhmgn5) | ![B1-F14-2-after.png](https://git.cafe/api/attachments/attach_01m71hbnpnfaptzy643pjhmgn5) | ![B1-F14-2-diff0.png](https://git.cafe/api/attachments/attach_01m71hbpe5faptzy6fyzdy7r0a) | ![B1-F14-2-diffT16.png](https://git.cafe/api/attachments/attach_01m71hbpe5faptzy6fyzdy7r0a) |
| B1-F14-3 · Web H · 1440×900 · dark | ![B1-F14-3-before.png](https://git.cafe/api/attachments/attach_01m71hbpwxeh1th8atwqexev85) | ![B1-F14-3-after.png](https://git.cafe/api/attachments/attach_01m71hbqaffaptzy6mrs3cn6d1) | ![B1-F14-3-diff0.png](https://git.cafe/api/attachments/attach_01m71hbqf0eh1th8b365a798j0) | ![B1-F14-3-diffT16.png](https://git.cafe/api/attachments/attach_01m71hbqwqeh1th8bftcc7ehr9) |



**F15 — Deferred history, retry and missing wait**

PARTIAL H. The production fold loading/error/retry UI is driven by a controlled loadEarlierHistory Promise. Loaded content is explicitly harness text. Adjusted label stays5s through loading/error/retry; removing answered wait restores1m5s on both. The reconnect phase retains identical inputs only: no real socket reconnect, server page load or remount was exercised. Record: B5-F15-harness.

| Capture / surface / viewport / theme | Before | After | Diff0 | DiffT |
| --- | --- | --- | --- | --- |
| Source revision | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| B5-F15-error · Web H · 390×844 · light | ![B5-F15-error-before.png](https://git.cafe/api/attachments/attach_01m71hctk6faptzysd5j7m8vs2) | ![B5-F15-error-after.png](https://git.cafe/api/attachments/attach_01m71hctxzfaptzyshbvgh2c5v) | ![B5-F15-error-diff0.png](https://git.cafe/api/attachments/attach_01m71hcv6hfaptzyssarb9g98e) | ![B5-F15-error-diffT16.png](https://git.cafe/api/attachments/attach_01m71hcvknfaptzyt6chdgmav3) |
| B5-F15-loaded · Web H · 390×844 · light | ![B5-F15-loaded-before.png](https://git.cafe/api/attachments/attach_01m71hcw4feh1th8ettbw8rb1z) | ![B5-F15-loaded-after.png](https://git.cafe/api/attachments/attach_01m71hcw7efaptzyt9zpd248v3) | ![B5-F15-loaded-diff0.png](https://git.cafe/api/attachments/attach_01m71hcwh4faptzytnxdzk5qfh) | ![B5-F15-loaded-diffT16.png](https://git.cafe/api/attachments/attach_01m71hcx3bfaptzytr8p0vvp4n) |
| B5-F15-negative · Web H · 390×844 · light | ![B5-F15-negative-before.png](https://git.cafe/api/attachments/attach_01m71hcx8vfaptzyv2qtdn3cpq) | ![B5-F15-negative-after.png](https://git.cafe/api/attachments/attach_01m71hcx8vfaptzyv2qtdn3cpq) | ![B5-F15-negative-diff0.png](https://git.cafe/api/attachments/attach_01m71hbvqtfaptzy8n7qa4pae7) | ![B5-F15-negative-diffT16.png](https://git.cafe/api/attachments/attach_01m71hbvqtfaptzy8n7qa4pae7) |



**F16 — Guest caller**

Guest timeline-props H, not a real share. Production MessagesTimeline receives app-run data without owner pendingApprovalRequestIds/runless-active inputs. Approval and question pending→answer→complete are recorded in G1-harness. Harness Next phase stands in for owner response. Real guest route, sharing relay and transport remain unverified.

| Capture / surface / viewport / theme | Before | After | Diff0 | DiffT |
| --- | --- | --- | --- | --- |
| Source revision | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| G1-0 · Guest props H · 390×844 · light | ![G1-0-before.png](https://git.cafe/api/attachments/attach_01m71hd677faptzyy44g84mav1) | ![G1-0-after.png](https://git.cafe/api/attachments/attach_01m71hd68ceh1th8h0vjvxsqev) | ![G1-0-diff0.png](https://git.cafe/api/attachments/attach_01m71hcrksfaptzyrbfp7ceq5d) | ![G1-0-diffT16.png](https://git.cafe/api/attachments/attach_01m71hcs9cfaptzyrm334fat8k) |
| G1-2 · Guest props H · 390×844 · light | ![G1-2-before.png](https://git.cafe/api/attachments/attach_01m71hd7a7faptzyydb0ympdjp) | ![G1-2-after.png](https://git.cafe/api/attachments/attach_01m71hd7qyfaptzyym4349f18z) | ![G1-2-diff0.png](https://git.cafe/api/attachments/attach_01m71hd7zgeh1th8h8df2v968j) | ![G1-2-diffT16.png](https://git.cafe/api/attachments/attach_01m71hd8kqfaptzyyxnrgkaw47) |
| G1-3 · Guest props H · 390×844 · light | ![G1-3-before.png](https://git.cafe/api/attachments/attach_01m71hd8rafaptzyz7969yb21r) | ![G1-3-after.png](https://git.cafe/api/attachments/attach_01m71hd8yxfaptzyzbhwvysk1m) | ![G1-3-diff0.png](https://git.cafe/api/attachments/attach_01m71hd9jjfaptzyzhwmywygbn) | ![G1-3-diffT16.png](https://git.cafe/api/attachments/attach_01m71hcs9cfaptzyrm334fat8k) |
| G1-5 · Guest props H · 390×844 · light | ![G1-5-before.png](https://git.cafe/api/attachments/attach_01m71hd9x8faptzyzy9dz0pstk) | ![G1-5-after.png](https://git.cafe/api/attachments/attach_01m71hdafpfaptzz06p0eckvps) | ![G1-5-diff0.png](https://git.cafe/api/attachments/attach_01m71hdah2fvhag4m6rphxj1vp) | ![G1-5-diffT16.png](https://git.cafe/api/attachments/attach_01m71hd8kqfaptzyyxnrgkaw47) |



**F17 — Empty, untimed and checkpoint tail**

PARTIAL. Empty draft, active work with no start (Working…), and completed/checkpoint tail are captured without waiting/NaN. Initial detail loading, unavailable connection and no-selected-shell states are unverified. Harness placeholder paragraphs for those states are deliberately not used as evidence. Record: B5-F17-harness.

| Capture / surface / viewport / theme | Before | After | Diff0 | DiffT |
| --- | --- | --- | --- | --- |
| Source revision | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) | [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) → [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| B5-F17-empty · Web H · 390×844 · light | ![B5-F17-empty-before.png](https://git.cafe/api/attachments/attach_01m71hcztcfaptzyvpmmq06j2f) | ![B5-F17-empty-after.png](https://git.cafe/api/attachments/attach_01m71hd014eh1th8fw3cxtsxna) | ![B5-F17-empty-diff0.png](https://git.cafe/api/attachments/attach_01m71hd0d7eh1th8g0vthd1xaa) | ![B5-F17-empty-diffT16.png](https://git.cafe/api/attachments/attach_01m71hbvqtfaptzy8n7qa4pae7) |
| B5-F17-untimed · Web H · 390×844 · light | ![B5-F17-untimed-before.png](https://git.cafe/api/attachments/attach_01m71hd0yzfaptzyvvgxsq0emj) | ![B5-F17-untimed-after.png](https://git.cafe/api/attachments/attach_01m71hd0yzfaptzyvvgxsq0emj) | ![B5-F17-untimed-diff0.png](https://git.cafe/api/attachments/attach_01m71hbvqtfaptzy8n7qa4pae7) | ![B5-F17-untimed-diffT16.png](https://git.cafe/api/attachments/attach_01m71hbvqtfaptzy8n7qa4pae7) |
| B5-F17-checkpoint · Web H · 390×844 · light | ![B5-F17-checkpoint-before.png](https://git.cafe/api/attachments/attach_01m71hcyfefaptzyvf7n9dnswg) | ![B5-F17-checkpoint-after.png](https://git.cafe/api/attachments/attach_01m71hcytneh1th8f3y9sn15sh) | ![B5-F17-checkpoint-diff0.png](https://git.cafe/api/attachments/attach_01m71hcz16eh1th8fen5v0dt32) | ![B5-F17-checkpoint-diffT16.png](https://git.cafe/api/attachments/attach_01m71hczeaeh1th8fphsmxv6hg) |



**Recording narration**

Times below are playback seconds, approximate to the nearest second. H phase checkpoints are reconstructed from host trace times relative to stop-time minus media duration; use the visible phase/t= header as the exact synthetic clock. Raw host-millisecond traces are retained. WebP loops; open the image separately to replay. Each Before/After pair uses the same scripted phase/action order, with small tool latency differences. Full raw MP4 paths are included for the lead.

**B1-matched-real**

Real app, replay provider,1440×900 dark. Start approval turn; close sidebar/details panel; dwell pending; Approve; open and close latest fold; submit second prompt; Decline; reopen prior fold. Work labels before42s/31s; after latest2.1s, historical1.6s and second658ms. Exact event arithmetic is in the real timestamp manifest.

Before (2880×1800 recording raster; raw 143.92s; public 143.92s): 0.0s start; 41.4s approve; 54.3s expand; 79.7s collapse; 79.8s second; 110.5s second-reject; 131.7s historical-expand

After (2880×1800 recording raster; raw 143.02s; public 143.02s): 0.0s start; 39.8s approve; 52.6s expand; 78.1s collapse; 78.2s second; 108.9s second-reject; 130.0s historical-expand

| Before | After |
| --- | --- |
| [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| ![B1-matched-real-before.webp](https://git.cafe/api/attachments/attach_01m71hjv60faptzzbxp7tsw5cj) | ![B1-matched-real-after.webp](https://git.cafe/api/attachments/attach_01m71hjv7qeh1th8mks3gywttd) |



Raw before: [B1-matched-real-before.mp4](/tmp/lead-33577-r2/web/raw/B1-matched-real-before.mp4).

Raw after: [B1-matched-real-after.mp4](/tmp/lead-33577-r2/web/raw/B1-matched-real-after.mp4).



**H-approval-lifecycle**

Web H1440×900 dark. Click Next phase through empty/start/work/pending/dwell/answer/resume/complete/history; expand/collapse completed and historical fold. Frozen request2–62; at64 after4s; final/history5s.

Before (2880×1800 recording raster; raw 34.94s; public 34.94s): 2s F3 draft; 6s F3 start; 8s F3 work; 12s F3 pending; 16s F3 pending-long; 18s F3 resumed; 22s F3 complete; 29s F3 history

After (2880×1800 recording raster; raw 35.41s; public 35.41s): 2s F3 draft; 6s F3 start; 8s F3 work; 12s F3 pending; 16s F3 pending-long; 18s F3 resumed; 22s F3 complete; 29s F3 history

| Before | After |
| --- | --- |
| [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| ![H-approval-lifecycle-before.webp](https://git.cafe/api/attachments/attach_01m71hfw0kfaptzzaq6xe3q3sw) | ![H-approval-lifecycle-after.webp](https://git.cafe/api/attachments/attach_01m71hfw22eh1th8kyq25epb2q) |



Raw before: [H-approval-lifecycle-before.mp4](/tmp/lead-33577-r2/web/raw/H-approval-lifecycle-before.mp4).

Raw after: [H-approval-lifecycle-after.mp4](/tmp/lead-33577-r2/web/raw/H-approval-lifecycle-after.mp4).



**H-question-lifecycle**

Web H390×844 light. Next phase: ordinary command, pending blocking question, answered/resumed, completed. Open/collapse5s fold; answered question remains visible.

Before (780×1688 recording raster; raw 17.30s; public 17.30s): 1s F3 work; 3s F3 pending; 7s F3 pending-long; 9s F3 resumed; 12s F3 complete

After (780×1688 recording raster; raw 17.74s; public 17.74s): 1s F3 work; 3s F3 pending; 7s F3 pending-long; 9s F3 resumed; 13s F3 complete

| Before | After |
| --- | --- |
| [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| ![H-question-lifecycle-before.webp](https://git.cafe/api/attachments/attach_01m71hfx11eh1th8m7x0ncv55m) | ![H-question-lifecycle-after.webp](https://git.cafe/api/attachments/attach_01m71hfw7jfaptzzax6f82s5hr) |



Raw before: [H-question-lifecycle-before.mp4](/tmp/lead-33577-r2/web/raw/H-question-lifecycle-before.mp4).

Raw after: [H-question-lifecycle-after.mp4](/tmp/lead-33577-r2/web/raw/H-question-lifecycle-after.mp4).



**B3-harness**

Web H1440×900 dark. Chapters F6 steer, F7 runless, F8 wake, F9 message-mode, F11 overlap. Advance phases within each chapter, then independently open/close eligible folds. F6 top8s/Continued5s; F7 current/history5s; F8 inherited24s; F9 completed1m5s unchanged; F11 waiting remains until both answers, final5s.

Before (2880×1800 recording raster; raw 71.35s; public 71.35s): 2s F6 pending-first; 4s F6 resumed-first; 5s F6 pending-second; 6s F6 resumed-second; 8s F6 complete; 17s F7 pending; 22s F7 resumed; 26s F7 complete; 31s F7 history; 35s F8 resumed; 40s F8 pending; 44s F9 work; 48s F9 work-long; 50s F9 complete; 54s F11 both-pending; 59s F11 one-pending; 63s F11 resumed; 68s F11 complete

After (2880×1800 recording raster; raw 71.19s; public 71.19s): 2s F6 pending-first; 3s F6 resumed-first; 5s F6 pending-second; 6s F6 resumed-second; 8s F6 complete; 17s F7 pending; 22s F7 resumed; 26s F7 complete; 31s F7 history; 35s F8 resumed; 39s F8 pending; 44s F9 work; 48s F9 work-long; 50s F9 complete; 54s F11 both-pending; 58s F11 one-pending; 63s F11 resumed; 68s F11 complete

| Before | After |
| --- | --- |
| [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| ![B3-harness-before.webp](https://git.cafe/api/attachments/attach_01m71hfn9vfaptzz66smqkarzt) | ![B3-harness-after.webp](https://git.cafe/api/attachments/attach_01m71hfn0bfaptzz5sa3dfhp5s) |



Raw before: [B3-harness-before.mp4](/tmp/lead-33577-r2/web/raw/B3-harness-before.mp4).

Raw after: [B3-harness-after.mp4](/tmp/lead-33577-r2/web/raw/B3-harness-after.mp4).



**B4-approval-exit**

Real app, replay provider,390×844 light. At0s approval already pending in Zen; switch hideSuccessful then hideAll and back to Zen (within first4s before / first8s after); Approve around4s before /8s after; completion has no work fold by5s before /10s after. Settings changes go through the actual client mutation.

Before (780×1688 recording raster; raw 6.04s; public 6.04s): 

After (780×1688 recording raster; raw 10.67s; public 10.67s): 

| Before | After |
| --- | --- |
| [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| ![B4-approval-exit-before.webp](https://git.cafe/api/attachments/attach_01m71hfp3bfaptzz6httanw70z) | ![B4-approval-exit-after.webp](https://git.cafe/api/attachments/attach_01m71hfp0gfaptzz697c17f4wv) |



Raw before: [B4-approval-exit-before.mp4](/tmp/lead-33577-r2/web/raw/B4-approval-exit-before.mp4).

Raw after: [B4-approval-exit-after.mp4](/tmp/lead-33577-r2/web/raw/B4-approval-exit-after.mp4).



**B4-question-fresh**

Real app, replay provider,390×844 light. At0s empty Zen thread; send question; pending/options by3s. Dwell to about39s before /47s after; switch retained-request visibility settings then return to Zen, select Strict schemas. The question submits immediately on selection; completion by45s before /55s after. No ordinary work fold is expected.

Before (780×1688 recording raster; raw 46.32s; public 46.32s): 

After (780×1688 recording raster; raw 55.85s; public 55.85s): 

| Before | After |
| --- | --- |
| [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| ![B4-question-fresh-before.webp](https://git.cafe/api/attachments/attach_01m71hfpwweh1th8kjr76c08p7) | ![B4-question-fresh-after.webp](https://git.cafe/api/attachments/attach_01m71hfpd4faptzz6z5x36wkah) |



Raw before: [B4-question-fresh-before.mp4](/tmp/lead-33577-r2/web/raw/B4-question-fresh-before.mp4).

Raw after: [B4-question-fresh-after.mp4](/tmp/lead-33577-r2/web/raw/B4-question-fresh-after.mp4).



**D1-real**

Actual Electron1440×900 dark. At0s start synthetic approval; pending by3s; leave unanswered until roughly72s. Approve around72s, completion follows; expand then collapse completed fold in the later chapter (~106–130s). Whole native shell shown. Before1m12s; after953ms. Replay resume is fast; readable resumed seconds are covered in H. Public animation ends4s before raw shutdown.

Before (1440×900 recording raster; raw 154.60s; public 150.60s): 

After (1440×900 recording raster; raw 153.40s; public 149.40s): 

| Before | After |
| --- | --- |
| [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| ![D1-real-before.webp](https://git.cafe/api/attachments/attach_01m71hftvwfaptzz9xmkj8431x) | ![D1-real-after.webp](https://git.cafe/api/attachments/attach_01m71hft7sfaptzz9ha7hhbeww) |



Raw before: [D1-real-before.mp4](/tmp/lead-33577-r2/web/raw/D1-real-before.mp4).

Raw after: [D1-real-after.mp4](/tmp/lead-33577-r2/web/raw/D1-real-after.mp4).



**G1-harness**

Guest timeline-props H390×844 light.0s pending approval → about3s answered → about6s complete; about9s pending question →12s answered →14s complete. Next phase is an owner-response stand-in, not a guest answer control. Open/collapse final fold around15s. Before totals1m5s; after5s.

Before (780×1688 recording raster; raw 17.11s; public 17.11s): 

After (780×1688 recording raster; raw 16.31s; public 16.31s): 

| Before | After |
| --- | --- |
| [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| ![G1-harness-before.webp](https://git.cafe/api/attachments/attach_01m71hfv40faptzzaa1gs98wzm) | ![G1-harness-after.webp](https://git.cafe/api/attachments/attach_01m71hftzhfaptzza0pmr90n2j) |



Raw before: [G1-harness-before.mp4](/tmp/lead-33577-r2/web/raw/G1-harness-before.mp4).

Raw after: [G1-harness-after.mp4](/tmp/lead-33577-r2/web/raw/G1-harness-after.mp4).



**B5-F13-harness**

Web H390×844 light.0s preparing, around2s compaction, around5s ordinary waiting, around7s background setup alongside waiting. Both use synthetic t12. The unexpected lost compaction timer is visible in the middle chapter.

Before (780×1688 recording raster; raw 10.04s; public 10.04s): 

After (780×1688 recording raster; raw 9.66s; public 9.66s): 

| Before | After |
| --- | --- |
| [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| ![B5-F13-harness-before.webp](https://git.cafe/api/attachments/attach_01m71hfry7faptzz8chwe33zvb) | ![B5-F13-harness-after.webp](https://git.cafe/api/attachments/attach_01m71hfra3faptzz8270z8gm0m) |



Raw before: [B5-F13-harness-before.mp4](/tmp/lead-33577-r2/web/raw/B5-F13-harness-before.mp4).

Raw after: [B5-F13-harness-after.mp4](/tmp/lead-33577-r2/web/raw/B5-F13-harness-after.mp4).



**B5-F15-harness**

Web H390×844 light.0s collapsed; click fold about1s; production skeleton; force error around2s; click retry around4s; resolve promise and select loaded chapter around7s; retain same inputs in reconnect-labelled phase around9s; remove answered wait around11s. The reconnect-labelled phase is not an actual reconnect. Negative control ends1m5s in both.

Before (780×1688 recording raster; raw 13.94s; public 13.94s): 

After (780×1688 recording raster; raw 13.51s; public 13.51s): 

| Before | After |
| --- | --- |
| [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| ![B5-F15-harness-before.webp](https://git.cafe/api/attachments/attach_01m71hfs7efaptzz8wyf2awyp5) | ![B5-F15-harness-after.webp](https://git.cafe/api/attachments/attach_01m71hfs14faptzz8g0q97kwrw) |



Raw before: [B5-F15-harness-before.mp4](/tmp/lead-33577-r2/web/raw/B5-F15-harness-before.mp4).

Raw after: [B5-F15-harness-after.mp4](/tmp/lead-33577-r2/web/raw/B5-F15-harness-after.mp4).



**B5-F17-harness**

Web H390×844 light.0s empty draft → about3s no-start active/untimed Working… → about5s checkpoint tail. No fabricated loading/unavailable/no-shell paragraph is included.

Before (780×1688 recording raster; raw 7.63s; public 7.63s): 

After (780×1688 recording raster; raw 7.52s; public 7.52s): 

| Before | After |
| --- | --- |
| [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| ![B5-F17-harness-before.webp](https://git.cafe/api/attachments/attach_01m71hfszrfaptzz9c0y4180kc) | ![B5-F17-harness-after.webp](https://git.cafe/api/attachments/attach_01m71hfsxhfaptzz953sjhxah7) |



Raw before: [B5-F17-harness-before.mp4](/tmp/lead-33577-r2/web/raw/B5-F17-harness-before.mp4).

Raw after: [B5-F17-harness-after.mp4](/tmp/lead-33577-r2/web/raw/B5-F17-harness-after.mp4).



**B1-F14-harness**

Web H1440×900 dark.0s failed-tool tail with pending approval retains Thinking. Around4s eligible interrupted group (after5s); around7s failed no-fold; around10s streaming active no-fold (after4s). Phase transitions only; synthetic clock is in header.

Before (2880×1800 recording raster; raw 15.04s; public 15.04s): 

After (2880×1800 recording raster; raw 13.52s; public 13.52s): 

| Before | After |
| --- | --- |
| [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| ![B1-F14-harness-before.webp](https://git.cafe/api/attachments/attach_01m71hfhpefaptzz49m4z26n3e) | ![B1-F14-harness-after.webp](https://git.cafe/api/attachments/attach_01m71hfhr8faptzz4pswye4sgy) |



Raw before: [B1-F14-harness-before.mp4](/tmp/lead-33577-r2/web/raw/B1-F14-harness-before.mp4).

Raw after: [B1-F14-harness-after.mp4](/tmp/lead-33577-r2/web/raw/B1-F14-harness-after.mp4).



**B1-stop-clean**

Real app, replay provider,1440×900 dark.0s empty; send pending approval. Leave unanswered for at least10s; Stop around17s before /23s after; waiting clears to stopping then interrupted tool summary by21s before /27s after. Panels are closed on both sides.

Before (2880×1800 recording raster; raw 22.32s; public 22.32s): 

After (2880×1800 recording raster; raw 27.90s; public 27.90s): 

| Before | After |
| --- | --- |
| [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| ![B1-stop-clean-before.webp](https://git.cafe/api/attachments/attach_01m71hfk0vfvhag4myqhmdcsvq) | ![B1-stop-clean-after.webp](https://git.cafe/api/attachments/attach_01m71hfjt8faptzz55a8mr741m) |



Raw before: [B1-stop-clean-before.mp4](/tmp/lead-33577-r2/web/raw/B1-stop-clean-before.mp4).

Raw after: [B1-stop-clean-after.mp4](/tmp/lead-33577-r2/web/raw/B1-stop-clean-after.mp4).



**B1-reject-real**

Supplementary real app, replay provider,1440×900 dark.0s empty; send approval. Pending from3s; leave until~69s before /79s after. Open right panel near end; Decline; request settles and completed work fold appears. Before~1m10s; after~1.1s. Sidebar age/title-capitalisation differences are capture data, so this supplement has no pixel-diff assertion.

Before (2880×1800 recording raster; raw 77.91s; public 77.91s): 

After (2880×1800 recording raster; raw 87.46s; public 87.46s): 

| Before | After |
| --- | --- |
| [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| ![B1-reject-real-before.webp](https://git.cafe/api/attachments/attach_01m71hfjqwfaptzz4x5sm7x4ej) | ![B1-reject-real-after.webp](https://git.cafe/api/attachments/attach_01m71hfhmjeh1th8k422gwcyj2) |



Raw before: [B1-reject-real-before.mp4](/tmp/lead-33577-r2/web/raw/B1-reject-real-before.mp4).

Raw after: [B1-reject-real-after.mp4](/tmp/lead-33577-r2/web/raw/B1-reject-real-after.mp4).



**B2-fresh-real**

Real app, replay provider,390×844 light.0s empty → send question → options/pending by3s; dwell past one minute. Select Strict schemas around79s before /84s after; auto-submit completes by84s before /90s after. Composer and real nonempty question/options remain in frame. Readable exact resumed timer is in H-question-lifecycle.

Before (780×1688 recording raster; raw 84.22s; public 84.22s): 

After (780×1688 recording raster; raw 89.98s; public 89.98s): 

| Before | After |
| --- | --- |
| [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| ![B2-fresh-real-before.webp](https://git.cafe/api/attachments/attach_01m71hfmwjfaptzz5q5eddzfbw) | ![B2-fresh-real-after.webp](https://git.cafe/api/attachments/attach_01m71hfm1seh1th8kcmf9zynhm) |



Raw before: [B2-fresh-real-before.mp4](/tmp/lead-33577-r2/web/raw/B2-fresh-real-before.mp4).

Raw after: [B2-fresh-real-after.mp4](/tmp/lead-33577-r2/web/raw/B2-fresh-real-after.mp4).



**B5-F12-boundary**

Web H390×844 light.0s synthetic59; about1s advance to60. Before59s→1m; after58s→59s because an answered1s interval is excluded. Remaining work/Thinking are unchanged.

Before (780×1688 recording raster; raw 4.56s; public 4.56s): 

After (780×1688 recording raster; raw 4.19s; public 4.19s): 

| Before | After |
| --- | --- |
| [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| ![B5-F12-boundary-before.webp](https://git.cafe/api/attachments/attach_01m71hfqd3faptzz7bmptvdtbr) | ![B5-F12-boundary-after.webp](https://git.cafe/api/attachments/attach_01m71hfq33faptzz755ngxn250) |



Raw before: [B5-F12-boundary-before.mp4](/tmp/lead-33577-r2/web/raw/B5-F12-boundary-before.mp4).

Raw after: [B5-F12-boundary-after.mp4](/tmp/lead-33577-r2/web/raw/B5-F12-boundary-after.mp4).



**B5-F12-hover**

Web H390×844 light.0s settled duration gallery; pointer hovers the longest completed fold within1s; right timestamp12:00PM appears next to long text and chevron. Both whole narrow viewports fit the label. No click/expansion in this hover recording.

Before (780×1688 recording raster; raw 2.81s; public 2.81s): 

After (780×1688 recording raster; raw 2.97s; public 2.97s): 

| Before | After |
| --- | --- |
| [bbdc7dc](https://git.cafe/pingdotgg/t3code/commit/bbdc7dca320ee4fbc7131498aaffef2fa1eb3d41) | [6b82901](https://git.cafe/pingdotgg/t3code/commit/6b8290152712ae8ef4696e44fb9f1f00026b99cf) |
| ![B5-F12-hover-before.webp](https://git.cafe/api/attachments/attach_01m71hfr1nfaptzz7tz5hdq0jf) | ![B5-F12-hover-after.webp](https://git.cafe/api/attachments/attach_01m71hfr0bfaptzz7grp7qpvsd) |



Raw before: [B5-F12-hover-before.mp4](/tmp/lead-33577-r2/web/raw/B5-F12-hover-before.mp4).

Raw after: [B5-F12-hover-after.mp4](/tmp/lead-33577-r2/web/raw/B5-F12-hover-after.mp4).



**Per-pair pixel counts**

| Pair | Diff0 changed pixels | DiffT changed pixels | Total pixels |
| --- | ---: | ---: | ---: |
| B1-F14-0 | 1058 | 668 | 1024000 |
| B1-F14-1 | 330 | 187 | 1024000 |
| B1-F14-2 | 0 | 0 | 1024000 |
| B1-F14-3 | 264 | 176 | 1024000 |
| B1-real-approval-expanded | 282 | 193 | 1024000 |
| B1-real-stop-exit | 1 | 0 | 1024000 |
| B1-real-stop-pending | 994 | 667 | 1024000 |
| B2-real-fresh-complete | 2 | 0 | 1316640 |
| B2-real-fresh-pending | 3099 | 2683 | 1316640 |
| B3-F11-0 | 1058 | 668 | 1024000 |
| B3-F11-1 | 1072 | 688 | 1024000 |
| B3-F11-2 | 255 | 162 | 1024000 |
| B3-F11-3 | 329 | 196 | 1024000 |
| B3-F6-4 | 630 | 380 | 1024000 |
| B3-F7-0 | 1370 | 863 | 1024000 |
| B3-F7-1 | 591 | 372 | 1024000 |
| B3-F7-2 | 628 | 383 | 1024000 |
| B3-F7-3 | 628 | 383 | 1024000 |
| B3-F8-0 | 363 | 223 | 1024000 |
| B3-F8-1 | 1096 | 703 | 1024000 |
| B3-F9-0 | 0 | 0 | 1024000 |
| B3-F9-2 | 0 | 0 | 1024000 |
| B4-approval-pending | 2966 | 2578 | 1316640 |
| B4-real-question-complete | 0 | 0 | 1316640 |
| B4-real-question-pending | 4449 | 3921 | 1316640 |
| B5-F12-gallery | 3069 | 2657 | 1316640 |
| B5-F12-long-timestamp | 3068 | 2671 | 1316640 |
| B5-F12-minute | 583 | 489 | 1316640 |
| B5-F13-0 | 0 | 0 | 1316640 |
| B5-F13-1 | 757 | 678 | 1316640 |
| B5-F13-2 | 2918 | 2519 | 1316640 |
| B5-F13-3 | 2918 | 2519 | 1316640 |
| B5-F15-error | 9856 | 9060 | 1316640 |
| B5-F15-loaded | 972 | 845 | 1316640 |
| B5-F15-negative | 0 | 0 | 1316640 |
| B5-F17-checkpoint | 730 | 610 | 1316640 |
| B5-F17-empty | 1 | 0 | 1316640 |
| B5-F17-untimed | 0 | 0 | 1316640 |
| D1-complete | 450 | 380 | 1296000 |
| D1-expanded | 446 | 376 | 1296000 |
| D1-pending | 938 | 826 | 1296000 |
| G1-0 | 2918 | 2519 | 1316640 |
| G1-2 | 830 | 706 | 1316640 |
| G1-3 | 2919 | 2519 | 1316640 |
| G1-5 | 831 | 706 | 1316640 |
| H-approval-0 | 0 | 0 | 1024000 |
| H-approval-2 | 0 | 0 | 1024000 |
| H-approval-3 | 1058 | 668 | 1024000 |
| H-approval-5 | 264 | 176 | 1024000 |
| H-approval-6 | 326 | 192 | 1024000 |
| H-approval-7 | 326 | 192 | 1024000 |
| H-question-3 | 2918 | 2519 | 1316640 |
| H-question-5 | 734 | 651 | 1316640 |
| H-question-6 | 830 | 706 | 1316640 |



**Scripts and manifests for publication by the lead**

- [handoff-status.json](/tmp/lead-33577-r2/web/scripts/handoff-status.json)

- [README.md](/tmp/lead-33577-r2/web/scripts/README.md)

- [capture-harness.tsx](/tmp/lead-33577-r2/web/scripts/capture-harness.tsx)

- [capture.html](/tmp/lead-33577-r2/web/scripts/capture.html)

- [real-driver.js](/tmp/lead-33577-r2/web/scripts/real-driver.js)

- [snapHelper.js](/tmp/lead-33577-r2/web/scripts/snapHelper.js)

- [recStop.js](/tmp/lead-33577-r2/web/scripts/recStop.js)

- [desktop-seed.js](/tmp/lead-33577-r2/web/scripts/desktop-seed.js)

- [desktop-seed-before.js](/tmp/lead-33577-r2/web/scripts/desktop-seed-before.js)

- [desktop-fresh.js](/tmp/lead-33577-r2/web/scripts/desktop-fresh.js)

- [desktop-run.js](/tmp/lead-33577-r2/web/scripts/desktop-run.js)

- [desktop-send.js](/tmp/lead-33577-r2/web/scripts/desktop-send.js)

- [desktop-eval.mjs](/tmp/lead-33577-r2/web/scripts/desktop-eval.mjs)

- [desktop-capture.py](/tmp/lead-33577-r2/web/scripts/desktop-capture.py)

- [cdp.mjs](/tmp/lead-33577-r2/web/scripts/cdp.mjs)

- [retake-plan.json](/tmp/lead-33577-r2/web/scripts/retake-plan.json)

- [b1-matched-trace.json](/tmp/lead-33577-r2/web/scripts/b1-matched-trace.json)

- [final-approval.json](/tmp/lead-33577-r2/web/scripts/final-approval.json)

- [final-question.json](/tmp/lead-33577-r2/web/scripts/final-question.json)

- [final-b3.json](/tmp/lead-33577-r2/web/scripts/final-b3.json)

- [final-edges.json](/tmp/lead-33577-r2/web/scripts/final-edges.json)

- [final-captures.json](/tmp/lead-33577-r2/web/scripts/final-captures.json)

- [real-timestamp-manifest.json](/tmp/lead-33577-r2/web/scripts/real-timestamp-manifest.json)

- [numeric-edge-manifest.json](/tmp/lead-33577-r2/web/scripts/numeric-edge-manifest.json)

- [pairs.json](/tmp/lead-33577-r2/web/scripts/pairs.json)

- [video-metadata.json](/tmp/lead-33577-r2/web/scripts/video-metadata.json)

- [review-assets.py](/tmp/lead-33577-r2/web/scripts/review-assets.py)

- [convert-recordings.py](/tmp/lead-33577-r2/web/scripts/convert-recordings.py)

- [make-filmstrips.py](/tmp/lead-33577-r2/web/scripts/make-filmstrips.py)

- [upload-reviewed.py](/tmp/lead-33577-r2/web/scripts/upload-reviewed.py)

- [build-evidence.py](/tmp/lead-33577-r2/web/scripts/build-evidence.py)



Raw logs and intermediate/discarded takes are private scratch, not publication inputs. The selected uploader output is also retained verbatim in [uploads.md](/tmp/lead-33577-r2/web/uploads.md). No PR comments, commits or pushes were made. Own servers/tabs and both capture worktrees are removed at handoff; the requested evidence/scripts/raw media are retained at these fixed handoff paths for the lead.

AI-assisted; verified with the tests and tools listed above.

FRICTION:

tool | agent-browser and ghdrop absent | used npx agent-browser plus the provided cafe uploader; preinstall them

tool | stored origin theme overrode Browser appearance | set application theme explicitly before each take

tool | Browser recording/screenshot raster differs from CSS viewport and exposes no explicit network-idle or reduced-motion control | report CSS and raster dimensions, suppress CSS motion and require identical settled frames

runbook | bundled Electron does not register Replay automatically | document isolated desktop RPC registration

tool | upload directory included obsolete Stop takes | use the final video-metadata allowlist; two obsolete uploads excluded from selected evidence

brief | delete-scratch instruction conflicts with required fixed-path evidence/scripts and retained raw MP4 handoff | retain requested handoff artifacts; remove app state/cache and worktrees
