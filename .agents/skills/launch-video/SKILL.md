---
name: launch-video
description: Make a short launch video (1920x1080 MP4 plus an outro PNG) that demos a T3 Code feature in a mock of the app, for an X/Twitter announcement or release thread. Use when asked for a launch video, demo video, feature teaser or announcement clip, or to add a video to a release tweet.
---

# Launch videos

A launch video is a 20–30 second mock of T3 Code: a cursor drives the app through one
story, the camera zooms on each beat, a caption names it, and an outro card closes.
It is pure HTML/CSS rendered frame by frame in headless Chromium, so it is
deterministic and every pixel is under your control. `template/story.html` is a
finished one (browser tunnels and port forwarding, 0.1.11); start from it.

## Workflow

1. **Learn the feature.** Read the PRs and the components it touches. Write down the
   one thing a user can now do that they couldn't before, in the user's words.
2. **Write the story** before any code: who the user is, what they want, and two or
   three beats that get them there. Show it to the maintainer if the angle is a guess.
3. **Create a working directory outside the repo:**
   `.agents/skills/launch-video/scripts/new.sh ~/launch-videos/<slug>`
4. **Build `story.html`** by editing the template (see Anatomy).
5. **Probe** with contact sheets at every beat, fix, repeat:
   `scripts/sheet.sh ~/launch-videos/<slug> 1,4.5,8,12,16,21,26` then Read `sheet.png`.
   The times are video seconds (after `Kit.timeline`), not the animation seconds the CSS
   uses. Read the full-size frames in `probe/` to check small text. A probe takes about
   2 s a frame.
6. **Render:** `scripts/render.sh ~/launch-videos/<slug> t3code-<slug>` gives
   `t3code-<slug>.mp4` and `outro.png`. A 30 s video takes about 3 minutes.
7. **Hand back** with the video and outro embedded (`![...](/abs/path.mp4)`), the
   caption copy, and anything in the story you assumed rather than verified.

The scripts need this repo's `node_modules` (`vp i`) for `playwright-core`, any
Chromium in the Playwright cache (or `CHROME=/path`), and `ffmpeg` on PATH.

## What the maintainers asked for

These came from review of the 0.1.11 videos. Each one was a real correction.

- **It must look like the real app.** Rebuild screens from the real components in
  `apps/web/src/components`: their English strings, layout, spacing and lucide icons.
  Strings live in `apps/web/src/i18n/translations/en.json` under hashed keys, so grep by
  the text, or read the literal in the component. A screen the template doesn't have needs a reference
  first: read the component, and capture it running (`test-t3-app`) when layout matters.
  "Quite far off how it actually looks" was the first round's verdict.
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

## Anatomy of story.html

Everything runs on one clock in **animation seconds**. Every animation uses
`animation-delay` for its start time and `both` fill, so seeking to any time renders
that moment exactly. No JS timers, no transitions, no `infinite`.

- **Canvas** 1600×900 CSS px, rendered at device scale 1.2 to 1920×1080.
- **`.win` / `.stage`**: the app window. The stage is 2000×1000 scaled .76 so the app
  renders at a realistic density. Reuse its sidebar, header, composer, details popover
  and browser panel; delete the parts the story doesn't need (the database window, the
  browser page) along with their CSS and timeline rules. The template's chat column is
  laid out for an open right panel; with the panel closed, centre it in the stage.
- **`.cam`**: the camera. One `@keyframes camera` of `translate() scale()` holds, one per
  beat. Percentages are of the `.cam` animation's duration. With `transform-origin: 0 0`,
  canvas point (x, y) lands on screen at (tx + s·x, ty + s·y). To centre a point at
  scale s: tx = 800 − s·x, ty = 450 − s·y (aim a little higher, since captions cover
  y ≥ 806 and the shade starts near 710). A stage point (x, y) is canvas
  (40 + .76·x, 26 + .76·y).
- **Typing**: a `clip-path` reveal with `steps(<characters>)`.
- **Cursor**: `Kit.cursor("#cur", steps)` in `window.placeCursor`. Steps are
  `{ t, at, dx, dy, click, hidden }` in animation seconds; `at` is a selector (or
  `[x, y]`) measured at `window.layoutTime` with the camera at rest. Set `layoutTime`
  to a moment when every cursor target is laid out at its final position. Targets are
  measured only once, so animate a target's entrance with opacity, not a transform. When
  a beat moves content (a panel opens and the chat column shifts), pick a `layoutTime`
  where the target sits where the cursor meets it, or give that step `[x, y]`.
- **Captions** `.cap`: bottom of the canvas, a numbered chip, a bold lead phrase and a
  muted rest. Short enough to read in two seconds.
- **Pacing**: `Kit.timeline([[realSeconds, animFrom, animTo], ...])` maps video time to
  animation time; `animFrom == animTo` holds a frame. It also sets the video length.
- **Outro** `.outro`: logo, a two-line headline, "Available now in **T3 Code** `<version>`",
  `t3.codes`. Change the headline and version, keep the rest. Hold it about 3 s.

When a beat moves, retime it in the CSS delays, the cursor steps and the camera
keyframes together, then re-probe.

## Delivery checklist

- [ ] 1920×1080, 30 fps, 20–30 s (`render.sh` prints it).
- [ ] Every beat checked in a contact sheet and at full size.
- [ ] No unannounced feature, real person or real thread on screen.
- [ ] `outro.png` exported and embedded in the reply with the video.
