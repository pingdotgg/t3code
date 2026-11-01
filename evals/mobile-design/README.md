# mobile-design

Scores the design of the T3 Code iOS app on iPhone, iPhone Duo and iPad. Code cannot judge design, so a council of models scores screenshots. This eval makes those screenshots the same way every round, and writes the brief that every round asks.

A run captures:

- **Scenes**: every screen in `SCENES` (`cases.ts`), on each pose in `POSES`. The poses are iPhone 17 Pro dark and light, the largest accessibility text size and landscape; iPhone Duo closed and open; and iPad Pro 13 in landscape and portrait. Every pose captures every scene, except the large-text and landscape passes, which capture a few. A scene's `source` names the complaint it guards, when there is one.
- **Desktop pairs**: the same data in the desktop web app at 1440×900, next to the iPad and iPhone captures.
- **Flows**: common tasks walked step by step on the dark iPhone, with the taps and distinct screens each took.

The data comes from the showcase fixture (`scripts/mobile-showcase-environment.ts`): three environments, seeded threads, and live threads run by a scripted Codex provider (`scripts/mobile-showcase-provider.ts`). That provider is how a capture shows a stream in progress, tool calls, an approval, a question and background work without a real model.

## Run it

Mobile capture needs macOS with Xcode, and a simulator runtime with the iPhone Duo device type (Xcode 27.1 or later). Desktop capture needs the `shot` skill. Run both on the same Mac: on Linux, `/etc/machine-info` names the machine in the desktop captures.

1. From the repo root, run `vp i`.
2. From `evals/`, capture and build the pack:

   ```bash
   pnpm mobile-design --out runs/<name> --capture mobile --capture desktop
   ```

   The first run builds the showcase app, which takes about 10 minutes. Add `--skip-build` to reuse it. The capture creates its own simulators, named `T3 Design …`, and deletes them when it finishes.

3. Run the council. The run writes `runs/<name>/council.json` with the brief and the panel: Claude Opus 5.5 and Codex GPT-6.1 Sol, both at `xhigh`. Give each member the brief at `runs/<name>/pack/brief.md`, read-only, with one `delegate_task` each. Add `--panel opus,sol,muse` to add Muse Wonder Full for rounds about copy.
4. Save each reply as `runs/<name>/scores/<member>.md`, then:

   ```bash
   pnpm mobile-design --out runs/<name> --summarize --baseline runs/<earlier>
   ```

   `summary.md` has the median per axis and device class, each reviewer's scores, the change against the baseline, and each reviewer's top five fixes.

To split the work across Macs, for example when only one has the Duo runtime, run each with its own `--pose` list, then copy the `captures/` folders into one run, join the `shots` lists in their `captures.json`, and build the pack with `--pack`.

Other flags: `--pose <id>` and `--case <scene id>` capture a subset, `--no-flows` skips the flows, `--pack` rebuilds the pack from earlier captures. `captures/captures.json` lists any scene that did not reach its ready state; look at those screenshots before you send the pack.

## Blind review

The pack holds only screenshots, the brief and the flow table. The commit under review is in `run.json`, outside the pack. Do not tell reviewers which build is new.

## Add a scene or flow

Add it to `SCENES` or `FLOWS` in `cases.ts`, with its `source`. Steps open deep links (`t3code://…`) or tap by accessibility label. When a scene needs a new state, add it to the fixture: a seeded thread in `SHOWCASE_THREADS`, or a live thread in `SHOWCASE_LIVE_THREADS` with the steps the scripted provider plays.

## Reference screenshots

`references/README.md` lists the Codex and Claude iOS screenshots the comparison axis needs. A maintainer captures them on a device; every image in that folder goes into the pack.

## Time and cost

A full capture on an idle M-series Mac takes about 90 minutes: about 30 minutes per device class, plus 5 for desktop pairs. On a busy host it can take twice that. A council round is two `xhigh` reviews of about 115 images.
