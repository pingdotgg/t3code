---
name: launch-video
description: Make a short launch video (1920x1080 MP4 plus an outro PNG) that demos a T3 Code feature, built from the real app with added motion, for an X/Twitter announcement or release thread. Use when asked for a launch video, demo video, feature teaser or announcement clip, or to add a video to a release tweet.
---

# Launch videos

A launch video is 20–30 seconds: the app goes through one story in two or three beats,
the camera punches in on each, a caption names it, and an outro card closes. Frames are
rendered one by one in headless Chromium, so the result is deterministic.

There are two ways to build one:

- **Real app (default).** A staging script runs the real server and web client with fictional
  data and the free replay agent, drives the flow in a browser, and freezes the page at each
  beat into `beats/<name>.html`. The story stacks those frozen pages and adds the motion: the
  camera, cursor, pops, glows, typing and captions. The UI is whatever the app draws today, so
  re-staging on main updates the video. `stagings/linked-environments/` is a finished example.
- **Mock.** `template/story.html` is a hand-built HTML copy of the app (the 0.1.11 tunnels
  video). Use it only for what a staging can't produce, such as another app on the desktop or
  a desktop-only screen. It drifts as the app changes.

## Workflow (real app)

1. **Learn the feature.** Read the PRs and the components it touches. Write down the one
   thing a user can now do that they couldn't before, in the user's words.
2. **Write the story** before any code: who the user is, what they want, and two or three
   beats that get them there. Show it to the maintainer if the angle is a guess.
3. **Stage it.** Copy `stagings/linked-environments/` to `stagings/<slug>/`.
   - `serve.mjs` builds fresh homes under `.t3/launch/<slug>/` with `scripts/stage-env.mjs`.
     Each home gets a fictional machine label, the replay agent, and no paid provider.
     It starts the servers, creates projects, writes `<out>/stage.json` and keeps running.
     Run it in the background.
   - `drive.mjs` opens the web client with `openBrowser()` (1440×720, dark, release
     branding) and walks the flow. It calls `beat(name)` at each moment the video needs.
     Re-run it as often as you like against the same servers.
   - Agent turns: pass `claude: [turns]` to `prepareHome` and the real Claude provider runs
     `scripts/fake-claude.mjs` as its CLI, so the video shows Claude's logo, models, thinking
     and tool rows. Each turn is `{ match, steps }`: `think`, `text`, `bash` (+ `output`, `ms`),
     `wait`, `edit` (+ `old`, `new`) and `write` (+ `content`), which change the file for real
     so diffs and checkpoints show them, and `tool` (+ `input`), which calls that T3 MCP tool
     for real, e.g. `delegate_task`; with `server` and `output` it plays another MCP server's
     tool instead. `<var:name>` is filled from the JSON file at `FAKE_CLAUDE_VARS`, for ids
     that change every run. `bash` with `run: true` executes the command in the session's cwd
     (to push a branch or open a pull request with a forge CLI); `as: "name"` keeps its output,
     or the `pick` regex match in it, as `<var:name>` for the turn's later steps. A workflow
     `agent` step with `returns` finishes on `submit: { ... }`, which hands it that value
     through `t3_submit_output`. `fake-claude.log` in the home records the protocol, for debugging.
   - Titles, commit messages and branch names come from `claude -p --json-schema`: answer them
     with `{ match, json }` turns, where `match` is tested against the schema plus the prompt
     (`'"title"'`, `'"subject"[\\s\\S]*products\\.ts'`). Unanswered ones fail in the app.
   - An MCP server that needs a sign-in: pass `claude: { turns, servers: [{ name, authUrl }] }`.
     The fake answers Claude's `mcp_status`, `mcp_authenticate` and `mcp_oauth_callback_url`,
     and remembers the sign-in across processes like the real CLI.
   - `createProject(env, title, files, { repos: ["api", "web"] })` makes a plain folder of
     several repositories. Staged repos commit as a fictional author. Keep staging homes
     outside this checkout (e.g. `<out>/home`): a project folder inside it shows this
     checkout's branch.
   - Data a real flow can't produce cheaply goes into the app's own stores, never into pixels.
     `insertPeerLinks` writes link rows into a stopped server; `serveDescriptors` makes fake
     machines answer the reachability probe. The client's saved environments and routes live
     in IndexedDB (`t3code:connection-runtime` / `catalog` / `document`): write the document
     from the page after its first load, then reload. Route kinds come from hostnames
     (`*.localhost` is LAN, `*.ts.net` Tailscale); Chrome's
     `--host-resolver-rules=MAP *.tail-demo.ts.net 127.0.0.1` makes fake tailnet names work.
   - Gestures: hold the mouse down, move in steps, and `saveBeat` mid-drag to freeze the
     app's own drag line and highlight; animate between those beats with `Kit.reveal`.
   - A capped, scrolling modal freezes at different scroll offsets per beat. Freeze at a
     viewport tall enough that nothing scrolls, and size `.app` to match.
   - Without `claude`, turns go to the dev replay agent (`apps/server/scripts/dev-replay-agent.ts`),
     which shows as an ACP provider.
4. **Create the story:** `scripts/new.sh ~/launch-videos/<slug>`, then copy the beats in, or
   pass that directory as the staging's `<out>`. Add one `<iframe data-beat>` per beat and
   write `setup()` and `placeCursor()` (see Anatomy).
5. **Find targets** in a beat: `scripts/find.mjs <dir>/beats/<name>.html "<text>"` prints
   selectors and boxes for the elements containing that text and their ancestors.
6. **Probe** with contact sheets at every beat, fix, repeat:
   `scripts/sheet.sh ~/launch-videos/<slug> 1,4.5,8,12,16,21,26` then Read `sheet.png`.
   The times are video seconds (after `Kit.timeline`), not animation seconds. Read the
   full-size frames in `probe/` to check small text. A probe takes about 2 s a frame.
7. **Render:** `scripts/render.sh ~/launch-videos/<slug> t3code-<slug>` gives
   `t3code-<slug>.mp4` and `outro.png`. A 30 s video takes 3–6 minutes.
8. **Hand back** with the video and outro embedded (`![...](/abs/path.mp4)`), the caption
   copy, any `Kit.text` edits, and anything you assumed rather than verified.

The scripts need this repo's `node_modules` (`vp i`) for `playwright-core`, any Chromium in
the Playwright cache (or `CHROME=/path`), and `ffmpeg` on PATH. Stop `serve.mjs` with your
harness's task stop; it ends its servers' process groups.

### Staging traps

- **Machine names and icons.** `T3CODE_ENVIRONMENT_LABEL` and `T3CODE_ENVIRONMENT_MACHINE_KIND`
  (laptop, desktop, cloud, linux, mac-mini, mac-studio) override what the server detects.
  `prepareHome({ label, machine })` records them and `startEnvironment` and `cli()` pass them
  on; the CLI needs them too, because a link introduces the machine by its label.
- **Linked environments** refuse loopback addresses ("this machine"), and plain http works
  only on tailnet names. `serve.mjs` links to this machine's tailnet DNS name.
- **Leaks.** Grep the beats for the real hostname, username and tailnet name before
  rendering. `snapshot.mjs` drops hidden inputs' values (they hold local paths).
- **Timeline rows** (`[data-timeline-row-id]`) are placed by a transform; `rise`/`pop` on one
  replaces it and the row vanishes. Animate an element inside the row.
- **The app's own animations** (a running tool's shine) are frozen into the beat and seeked
  with the story, which can leave text invisible. Cancel them in `setup()`:
  `iframe.contentDocument.getAnimations().forEach((a) => a.cancel())`.
- **Timing.** A replayed turn streams in real time (each frame delay caps at 2 s). Make a
  recording long enough for the drive to catch the state you need, and freeze beats on a
  timer when the UI summarises (a running command shows only "Running pnpm").
- **Agent wake-ups.** When a delegated child finishes, the parent agent gets a new turn. Give
  its recording a second turn, or the first replays and delegates again.

## What the maintainers asked for

These came from review of the 0.1.11 videos. Each one was a real correction.

- **It must look like the real app.** "Quite far off how it actually looks" was the first
  round's verdict on a mock. Stage the real app; mock only what can't be staged, rebuilt from
  the real component (strings live in `apps/web/src/i18n/translations/en.json` under hashed
  keys, so grep by the text).
- **Punchier than the app.** Extra motion is welcome (pops, glows, punch-ins, typing), as
  long as every pixel it moves is the real UI.
- **Readable on a phone.** Captions are 40px; zoom the camera 1.5–1.9× onto whatever the
  beat is about. If text is under ~14px after zoom, zoom further or cut it.
- **Slow enough to follow.** Slow the key interactions to 0.6–0.8× and hold 0.8–1.5 s after
  each payoff. A viewer must see the result before the next beat starts.
- **A realistic example.** The demo has to be something a user would really do. A local
  terminal querying a forwarded port was rejected ("why not use the in-app terminal?");
  a desktop database client was the right example.
- **Distinct features read as distinct.** Two features get two numbered captions and two
  clearly separate payoffs, never one blended beat.
- **Brand.** Production logo only (`logo-prod.png`, from `assets/prod/`), never the blue
  dev icon. The app's dark palette (below); orange only where the app uses it.
- **Only announced things.** Before showing a screen, check it ships enabled. Feature-flagged
  or separately announced work (for 0.1.11: GitHub sign-in and PR tooling, the mobile app)
  stays out, even as background UI. A video whose subject is an opt-in Labs feature is
  fine when the maintainer asked for it; say where to turn it on in the caption or tweet,
  and ask whether the outro should call it a beta. Ask when unsure.
- **Fictional demo data.** Project `acme/mugshot`, machine `devbox`, made-up people with
  `@example.com`. No real people, teams, emails, repos or the user's own threads.
- **Timing is checked, not assumed.** Typing must finish before the cursor clicks, a
  tooltip must appear before it is read, and card text must not overflow. The contact
  sheet catches these; full-size probe frames catch the rest.

## Look

From `apps/web/src/index.css`, dark theme:

- Background `#000` with a faint primary glow at the top (`rgba(52,107,241,.13)`).
- Text `#f1f3f7`, secondary `#a3a3a3`, UI muted `#8e8e93`, dim `#636368`.
- Borders `#1d1d20` or white at 8%; surfaces `#0e0e0f` to `#191a1d`; chips `#191a1d`.
- Primary `#346bf1`, light primary `#6e9bfb`, success `#4ade80`, destructive `#e5484d`.
- Orange `#f07a4a` only for the agent ✳ next to a Claude model and provider marks.
- Fonts: Inter (UI) and JetBrains Mono as `JB` (code, ports, versions, URLs).

## Anatomy of a real-app story

Everything runs on one clock in **animation seconds**. capture.mjs serves the directory over
HTTP, loads the beats, calls `setup()`, seeks to `layoutTime`, calls `placeCursor()`, then
seeks every animation (in the story and inside each beat) to each frame's time.

- **Canvas** 1600×900 CSS px, rendered at device scale 1.2 to 1920×1080. Beats were frozen at
  1440×720 and `.app` scales them 1.0556× into the 1520×760 window, so beat point (x, y) is
  canvas (40 + 1.0556·x, 26 + 1.0556·y).
- **Targets** are `"<beat> >> <css>"` (or `"* >> <css>"` for every beat). Prefer the app's
  `data-*` and `aria-label` attributes; `find.mjs` prints them. A trailing `:text(words)`
  keeps the matches containing those words, e.g. `[role=menuitem]:text(From MacBook)`.
- **Beat size.** Each beat records the viewport it was frozen at (`kit-viewport` meta).
  Size `.app` and its iframes to match and scale them to the 1520×760 window
  (1440×720 → 1.0556, 1600×800 → .95).
- **`setup()`**: `Kit.beats([[name, at, fade?], ...])` gives each beat one visibility window.
  Then the motion, all at absolute times:
  `Kit.pop / rise / slide / stagger / type / press / punch / fadeIn / draw` animate elements inside
  a beat; `Kit.glow(target, at)` draws a ring on the story layer, so app overflow can't
  clip it; `Kit.anim` takes raw keyframes; `Kit.text` makes a static edit (say so at
  handback).
- **`placeCursor()`**: wrap in `Kit.measure` and call `Kit.camera(steps)` and
  `Kit.cursor("#cur", steps)` there. Both take `{ t, on|at: target, ... }` steps measured at
  `layoutTime` with the camera at rest. Pick a `layoutTime` after every entrance has
  finished. Camera steps centre `on` at screen height `y` (default 420, clear of the captions)
  at scale `s`; repeat a step to hold. Cursor clicks draw a ripple.
- **Captions** `.cap`: a numbered chip, a bold lead phrase and a muted rest. Short enough to
  read in two seconds. Play them with `Kit.captions([[selector, from, to], ...])`, which
  throws if two overlap; two captions crossfading read as garbled text.
- **Pacing**: `Kit.timeline([[realSeconds, animFrom, animTo], ...])` maps video time to
  animation time; `animFrom == animTo` holds a frame. It also sets the video length.
- **Outro** `.outro`: logo, a two-line headline, "Available now in **T3 Code** `<version>`",
  `t3.codes`. Change the headline and version, keep the rest. Hold it about 3 s.

Two animations on one property of one element fight (the later one wins for its whole
fill). Give an element one animation per property, as `Kit.beats` does for visibility.

### Mock stories

`template/story.html` uses the same kit (cursor, timeline) but draws the app in HTML on a
2000×1000 `.stage` scaled .76 (stage point (x, y) is canvas (40 + .76·x, 26 + .76·y)), with CSS
`@keyframes` and delays for motion and one `@keyframes camera` for the camera. Rebuild any
screen it lacks from the real component's strings, layout and lucide icons.

## Delivery checklist

- [ ] 1920×1080, 30 fps, 20–30 s (`render.sh` prints it).
- [ ] Every beat checked in a contact sheet and at full size.
- [ ] No unannounced feature, real person, real machine name or real thread on screen.
- [ ] `outro.png` exported and embedded in the reply with the video.
