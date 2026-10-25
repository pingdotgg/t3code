---
name: demo-video
description: Make a captioned demo video of T3 Code from real screen recordings, with fframes. Covers writing a storyboard, installing fframes, filming T3 Code and nested agentctl Sandboxes on the desktop, cutting and speeding up takes, and composing and rendering 1080p. Use when asked for a demo video, a walkthrough or a feature video.
---

# Demo video

This is how the first T3 Code × agentctl walkthrough was made: 3½ minutes at 1080p, silent with
captions, every app shot a real recording. [storyboard.md](storyboard.md) is its storyboard and
shot list, and [template/](template) is its complete fframes project, the starting point for the
next one. fframes is only the tool: the video carries no fframes branding or outro. For fframes
itself, its command line and API, read fframes' own `fframes-video` skill, which
[scripts/fframes-skill](scripts/fframes-skill) downloads for the version the template pins.

The pipeline:

1. Agree on a storyboard with the developer.
2. Have a subagent install fframes and fetch its skill, once per Sandbox.
3. Prepare what you film: the released app, its own data, and nested Sandboxes. Do a dry run.
4. Record takes of the desktop with [scripts/rec](scripts/rec) and [scripts/glide](scripts/glide).
5. Find cut points with [scripts/sheet](scripts/sheet), and cut sped-up segments with
   [scripts/cut.sh](scripts/cut.sh).
6. Compose the scenes and shots in the project, review stills, render.

Work in a folder of the video's own, outside every checkout: `~/video` by default, or another
one exported as `VIDEO_DIR` for the scripts if `~/video` already holds earlier work.

```
~/video/
  project/        the fframes project, copied from template/
  fframes-video/  fframes' own skill, from scripts/fframes-skill
  footage/        raw takes from scripts/rec
  footage/seg/    segments from scripts/cut.sh, which the shots play
  sheets/         contact sheets from scripts/sheet
  app/  t3home/   the T3 Code release you film and its own T3 home
```

## 1. Storyboard first

Write the storyboard before installing or filming anything and get the developer's answers: who
watches, how long, what the "in practice" part shows, audio (silent with captions is the default:
you cannot record a voice and must not pick unlicensed music), and where the result goes. Fill in
the blank storyboard at the top of [storyboard.md](storyboard.md); the walkthrough's below it is
the example. Say before filming which parts are drawn (titles, diagrams, a typed terminal, a
manifest) and which are recordings.

## 2. Install fframes

Give this section to a subagent while you prepare the filming, and have it report the build and a
frame it rendered and read.

fframes renders with Skia on Vulkan. Without a GPU, Mesa's lavapipe in `mesa-vulkan-drivers` runs
Vulkan in software, at 30–50 fps for 1080p frames with footage. The fonts come from the image's
`fonts-inter` and `fonts-jetbrains-mono`.

```sh
sudo apt-get install -y mesa-vulkan-drivers vulkan-tools libvulkan-dev clang libclang-dev \
  nasm yasm ninja-build pkg-config libx264-dev libx265-dev libvpx-dev libopus-dev \
  libasound2-dev libfreetype-dev libfontconfig-dev

mkdir -p ~/video && cp -r template ~/video/project && cd ~/video/project
mkdir -p media
cp /usr/share/fonts/opentype/inter/Inter-{Regular,Medium,SemiBold,Bold}.otf \
  /usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-{Regular,Medium,Bold}.ttf media/
cargo build --release
```

The first build compiles FFmpeg from source, a few minutes: `template/.cargo/config.toml` sets
`FFMPEG_FORCE_BUILD`, because the prebuilt FFmpeg links an x264 Ubuntu does not ship. The
`fframes` crates are pinned exactly in `template/Cargo.toml`. `target/` grows to about 4 GB;
later builds take seconds.

Every command runs from the project with:

```sh
unset DISPLAY                                    # nothing opens a window on the desktop
export TMPDIR=~/video/project/.tmp               # renders leave chunk files here and never delete them
mkdir -p "$TMPDIR"
B=./target/release/demo-video
```

Check the install with `$B timeline` and `$B frame 1s`, then read the PNG in `frames/`.

Then fetch fframes' own skill, matching the pinned version:

```sh
sh scripts/fframes-skill          # → ~/video/fframes-video/SKILL.md and references/
```

Read its `SKILL.md` for the command line (time specs, the review loop) and `references/api.md`
when writing scenes; its `$R` is `$B` here. Use this section's install, not its own. Where it
and this setup differ, as checked at fframes 1.2.0 (check again when bumping the pin):

- It says the first build downloads prebuilt FFmpeg; here it is built from source, as above.
- Its footage example, `video_frame.href()`, does not compile, and `start_from` is a delay rather
  than an in-point. Play footage through the kit's `Shot`, whose `footage_frame` does it right.
- Never run `preview`: it opens a window on `:1`, where you are filming.

## 3. Prepare what you film

- **Film the released app, with its own data.** `~/.t3` may be the developer's live T3 home. Run
  the fork's latest release with `T3CODE_HOME=~/video/t3home`, so a dev build's "Dev" label and the
  live data both stay out of the video:

  ```sh
  mkdir -p ~/video/app && cd ~/video/app && gh release download -R martinothamar/t3code -p 'T3-Code-*-x86_64.AppImage'
  chmod +x T3-Code-*.AppImage
  setsid env T3CODE_HOME=~/video/t3home APPIMAGE_EXTRACT_AND_RUN=1 ./T3-Code-*.AppImage >t3.log 2>&1 &
  ```

  A fresh T3 home starts with onboarding, a good clean first frame. Skip the project import.

- **Sandboxes are nested Agents.** Log the nested `agentd` in as your instructions' Nested Agents
  section describes, run `agentctl ssh-config install`, keep manifests outside the checkout, and
  sign in the GitHub login `default` as the steps for testing a sync's build describe. Size them
  for the demo: the Altinn desktop Agent with localtest needed 4 CPUs and 6 GiB, more than the
  usual 2 CPUs and 3 GiB beside this Agent, so ask the developer.

- **Dry-run every take unrecorded.** It finds what fails (an agent that picks another tool, a
  service that does not start) and warms image caches, so the real take is shorter. Then reset what
  shows: delete dry-run threads, stop services the take starts, close windows on nested desktops.
  Before each take, check that only demo data is on screen: no real projects, threads,
  repositories, names or paths.

- **Say what you are about to do on the desktop** before you do it; the developer may be watching
  over VNC.

## 4. Record

```sh
export VIDEO_DIR=~/video                   # the video's folder, for every script
sh scripts/rec start take-thread-1         # writes $VIDEO_DIR/footage/take-thread-1.mp4
python3 scripts/glide 826 360 click 0.8    # screenshot coordinates, as `desktop` uses
xdotool type --delay 22 "Show me your desktop in the browser here: …"
xdotool key Return
sh scripts/rec stop
```

- One take per storyboard section, kept running through waits: cutting is cheap, retakes are not.
- `glide` moves the pointer in an eased curve; `desktop click` teleports it. Park the pointer
  somewhere neutral while an agent works.
- `xdotool type --delay 22` types at a readable pace; `desktop type` pastes at once.
- Record in the order that reuses state, not the video's order. The walkthrough filmed the thread
  in the dry-run Sandbox, then stop/start/delete on it, then creating a fresh one.
- Take a screenshot at each step boundary to know where things are; the recording does not care.
- Contact sheets find the cut points. Read a whole take's sheet, then one per second around each
  event; every frame carries its source second, the number `cut.sh` takes:

  ```sh
  sh scripts/sheet take-thread-1            # one frame every 4 s → $VIDEO_DIR/sheets/take-thread-1.jpg
  sh scripts/sheet take-thread-1 86 118     # 86–118 s, one frame per second
  ```

## 5. Cut

`sh scripts/cut.sh TAKE SEGMENT START END SPEED` writes `footage/seg/SEGMENT.mp4` and
prints its length. Speed up waiting (provisioning 8×, an installer 2.5×), keep clicks and results
at 1–1.5×, and keep each segment under about 15 seconds so a caption can describe it.

## 6. Compose

Rewrite `src/lib.rs`, the video's content; `src/kit.rs` is the reusable part, changed only to
fix or extend the kit. `video()` in `lib.rs` lists the scenes in order, built from the kit's:

| Scene           | Shows                                                                        |
| --------------- | ---------------------------------------------------------------------------- |
| `TitleCard`     | Title, subtitle and a chip; always first                                     |
| `TerminalScene` | `Line`s (comments, typed commands, output) in a terminal; its length follows |
| `CodeCard`      | A file's lines, the ones marked `true` highlighted                           |
| `Shot`          | One footage segment in a window card                                         |
| `StepsCard`     | Numbered steps and links; always last                                        |

A `Shot` carries its segment's `len` from `cut.sh`, a chapter label, the speed it was cut at,
`Cam(t, zoom, x, y)` keyframes eased between, captions as `(start, end, text)`, highlight rings and
`fade_out`. Camera and ring coordinates are source pixels of the recording: a screenshot's
coordinates times `width / sentWidth` from `desktop --json display`. Consecutive scenes
cross-fade over `XFADE`; a shot's footage plays exactly once, and captions of consecutive shots
swap rather than overlap. The kit crops the recording desktop's taskbar off the bottom.

Anything else is a scene of the video's own, like the walkthrough's `DiagramScene`: a struct in
`lib.rs` implementing `fframes::Scene` with the kit's helpers (`scene_opacity`, `ease_out`,
`window_opacity`, `caption`, `window_chrome`) and palette.

Review with fframes-video's loop before rendering, reading the stills and contact sheets it
writes. Then:

```sh
$B render -o renders/raw.mp4                          # 3½ minutes renders in about 80 s
ffmpeg -i renders/raw.mp4 -an -c copy ~/video/demo.mp4   # fframes always adds a silent audio track
rm -rf "$TMPDIR"/fframes-*
```

Give the developer the path; the chat embeds a local video with `![title](/absolute/path.mp4)`.

## Gotchas

- **Floating preview controls.** The pill with "Open in right panel" appears only on hover, and
  stayed hidden for the simulated pointer. Open the right panel with the toolbar's panel button.
- **Agents pick their own tools.** The Altinn instructions point the agent at `playwright-cli`;
  ask for "your browser tool" by name, with the URL, to get T3 Code's browser and its popup.
- **Interrupted image pulls corrupt Podman storage** inside a Sandbox, and pulls then fail with
  `readlink /var/lib/containers/storage/overlay/l: invalid argument`. In a throwaway Sandbox, run
  `sudo podman system reset --force`.
- **Footage** is read at runtime from `FFRAMES_FOOTAGE_DIR`, `footage/seg` beside the project by
  default, so replacing a segment needs no rebuild.
