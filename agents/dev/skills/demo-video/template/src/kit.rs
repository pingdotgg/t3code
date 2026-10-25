//! The reusable part of a demo video: its look, the scenes most videos need, and the `Shot` that
//! plays a recording. A video's `lib.rs` lists its scenes with their content; change this file
//! only to fix or extend the kit.
//!
//! Layout is drawn on a 1920x1080 grid; `--scale`/`--draft` scale it automatically. Every scene
//! but the first starts XFADE seconds before the previous one ends, and the two cross-fade.

// A video uses only some of the kit.
#![allow(dead_code)]
use fframes::{
    AnimateRuntimeInput, AudioMap, Color, Duration, FFramesContext, FontQuery, Frame, Overlap,
    Scene, Scenes, Svgr, SyncVideoFrameInput, Video,
    animation::{AnimationRuntime, Easing},
    FFramesSyncedVideoFrame as _,
    usvgr::PreloadedImageData,
};
use std::sync::{Arc, LazyLock};

pub const WIDTH: usize = 1920;
pub const HEIGHT: usize = 1080;
pub const FPS: usize = 30;

/// Cross-fade length between scenes, seconds.
pub const XFADE: f32 = 0.5;

// Palette and fonts. The fonts must be in the project's `media/`.
pub const BG_TOP: &str = "#0b1020";
pub const BG_BOTTOM: &str = "#1b1240";
pub const TEXT: &str = "#f5f7ff";
pub const MUTED: &str = "#a6adc8";
pub const DIM: &str = "#6c7393";
pub const ACCENT: &str = "#7c9cff";
pub const ACCENT_2: &str = "#c084fc";
pub const GREEN: &str = "#4ade80";
pub const YELLOW: &str = "#facc15";
pub const SANS: &str = "Inter";
pub const MONO: &str = "JetBrains Mono";

static FADE: LazyLock<AnimationRuntime> =
    LazyLock::new(|| AnimationRuntime::new(XFADE, &Easing::EaseInOut));
static EASE_OUT: LazyLock<AnimationRuntime> =
    LazyLock::new(|| AnimationRuntime::new(0.6, &Easing::CubicBezier(0.16, 1.0, 0.3, 1.0)));
static CAPTION_FADE: LazyLock<AnimationRuntime> =
    LazyLock::new(|| AnimationRuntime::new(0.35, &Easing::EaseInOut));

// ---------------------------------------------------------------------------------------
// the video

/// A video made of `scenes`, in order, over the shared background.
pub struct DemoVideo {
    scenes: Vec<Box<dyn Scene>>,
}

impl DemoVideo {
    pub fn new(scenes: Vec<Box<dyn Scene>>) -> Self {
        Self { scenes }
    }
}

impl std::fmt::Debug for DemoVideo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DemoVideo").finish()
    }
}

impl Video for DemoVideo {
    const FPS: usize = FPS;
    const WIDTH: usize = WIDTH;
    const HEIGHT: usize = HEIGHT;
    const BACKGROUND_COLOR: Color = Color::BLACK;

    fn duration(&self) -> Duration<'_> {
        Duration::Auto
    }

    fn audio(&self) -> AudioMap<'_> {
        AudioMap::none()
    }

    fn define_scenes(&self) -> Scenes<'_> {
        Scenes::from(self.scenes.iter().map(|s| s.as_ref()).collect::<Vec<&dyn Scene>>())
    }

    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let glow_x = 1500.0 - (frame.seconds() * 7.0) % 1200.0;
        fframes::svgr!(
            <svg xmlns="http://www.w3.org/2000/svg" width={WIDTH} height={HEIGHT} viewBox="0 0 1920 1080">
                <defs>
                    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
                        <stop offset="0" stop-color={BG_TOP} />
                        <stop offset="1" stop-color={BG_BOTTOM} />
                    </linearGradient>
                    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
                        <stop offset="0" stop-color="#5b5bd6" stop-opacity="0.40" />
                        <stop offset="1" stop-color="#5b5bd6" stop-opacity="0" />
                    </radialGradient>
                    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
                        <feDropShadow dx="0" dy="30" stdDeviation="30" flood-color="#000" flood-opacity="0.55" />
                    </filter>
                </defs>
                <rect width="1920" height="1080" fill="url(#bg)" />
                <circle cx={glow_x} cy="240" r="760" fill="url(#glow)" />
                {ctx.render_scenes(&frame)}
            </svg>
        )
    }
}

// ---------------------------------------------------------------------------------------
// helpers for drawing scenes

/// Opacity of a scene `total` seconds long (its duration plus its own overlap): fades in over
/// the first XFADE seconds and out over the last XFADE seconds.
pub fn scene_opacity(frame: &Frame, total: f32, fade_in: bool, fade_out: bool) -> f32 {
    let mut o = 1.0_f32;
    if fade_in {
        o = o.min(frame.animate_runtime(AnimateRuntimeInput { on_second: 0.0, from: 0.0, to: 1.0, animation_runtime: &FADE }));
    }
    if fade_out {
        o = o.min(frame.animate_runtime(AnimateRuntimeInput { on_second: total - XFADE, from: 1.0, to: 0.0, animation_runtime: &FADE }));
    }
    o
}

/// 0 → 1 over 0.6 s from `start`, a snappy entrance.
pub fn ease_out(frame: &Frame, start: f32) -> f32 {
    frame.animate_runtime(AnimateRuntimeInput { on_second: start, from: 0.0, to: 1.0, animation_runtime: &EASE_OUT })
}

pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

fn ease_in_out(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    if t < 0.5 { 4.0 * t * t * t } else { 1.0 - (-2.0 * t + 2.0).powi(3) / 2.0 }
}

/// Opacity of something shown from `start` to `end` seconds, fading at both ends.
pub fn window_opacity(frame: &Frame, start: f32, end: f32) -> f32 {
    let fade_in: f32 = frame.animate_runtime(AnimateRuntimeInput { on_second: start, from: 0.0, to: 1.0, animation_runtime: &CAPTION_FADE });
    let fade_out: f32 = frame.animate_runtime(AnimateRuntimeInput { on_second: end - 0.35, from: 1.0, to: 0.0, animation_runtime: &CAPTION_FADE });
    fade_in.min(fade_out)
}

/// Frame `index` of a footage file, clamped to its last frame (`frames` long).
fn footage_frame(frame: &Frame, ctx: &FFramesContext<'_, '_>, file: &str, index: usize, frames: usize) -> Option<Arc<PreloadedImageData>> {
    let mut shifted = frame.clone();
    shifted.index = index.min(frames.saturating_sub(1));
    let input = SyncVideoFrameInput { start_from: 0.0, looping: false, editor_fallback_image: None };
    let video_frame = shifted.get_synced_video_frame(ctx, file, &input)?;
    Some(video_frame.into_image().href())
}

/// A caption pill centred at (960, y), sized to its text.
pub fn caption<'a>(frame: &mut Frame, ctx: &FFramesContext<'a, '_>, text: &'a str, y: f32, opacity: f32) -> Svgr<'a> {
    if opacity <= 0.0 {
        return Svgr::empty();
    }
    let font = FontQuery { family: SANS, size: 32, weight: 500, ..Default::default() };
    let w = frame.text_width(ctx, font, text).unwrap_or(text.len() * 16) as f32 + 72.0;
    fframes::svgr!(
        <g opacity={opacity}>
            <rect x={960.0 - w / 2.0} y={y - 34.0} width={w} height="68" rx="34" fill="#05060c" fill-opacity="0.78" stroke="#ffffff" stroke-opacity="0.08" />
            <text x="960" y={y + 11.0} text-anchor="middle" font-family={SANS} font-weight="500" font-size="32" fill={TEXT}>{text}</text>
        </g>
    )
}

/// Window chrome (shadow, body, title bar) with a title in the middle and an optional label
/// on the left.
pub fn window_chrome<'a>(x: f32, y: f32, w: f32, h: f32, title: &'a str, label: &'a str) -> Svgr<'a> {
    fframes::svgr!(
        <g>
            <rect x={x} y={y} width={w} height={h} rx="16" fill="#11131c" filter="url(#shadow)" />
            <rect x={x} y={y} width={w} height="44" rx="16" fill="#232634" />
            <rect x={x} y={y + 28.0} width={w} height="16" fill="#232634" />
            <circle cx={x + 26.0} cy={y + 22.0} r="7" fill="#ff5f57" />
            <circle cx={x + 50.0} cy={y + 22.0} r="7" fill="#febc2e" />
            <circle cx={x + 74.0} cy={y + 22.0} r="7" fill="#28c840" />
            <text x={x + 104.0} y={y + 29.0} font-family={SANS} font-weight="600" font-size="19" fill={ACCENT}>{label}</text>
            <text x={x + w / 2.0} y={y + 29.0} text-anchor="middle" font-family={SANS} font-weight="500" font-size="19" fill={MUTED}>{title}</text>
        </g>
    )
}

/// A heading centred at the top of a drawn scene.
fn heading<'a>(frame: &Frame, text: &'a str, y: f32, size: f32) -> Svgr<'a> {
    fframes::svgr!(
        <text x="960" y={y} text-anchor="middle" font-family={SANS} font-weight="700" font-size={size} fill={TEXT}
              opacity={ease_out(frame, 0.1)}>{text}</text>
    )
}

// ---------------------------------------------------------------------------------------
// TitleCard: the first scene

/// The opening title, subtitle and a chip. It must be the first scene: it fades out but not in.
#[derive(Debug)]
pub struct TitleCard {
    pub name: &'static str,
    pub title: &'static str,
    pub subtitle: &'static str,
    pub chip: &'static str,
    pub seconds: f32,
}

impl Scene for TitleCard {
    fn name(&self) -> &'static str {
        self.name
    }

    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(self.seconds)
    }

    fn render_frame<'a>(&'a self, mut frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let opacity = scene_opacity(&frame, self.seconds, false, true);
        let p1 = ease_out(&frame, 0.2);
        let p2 = ease_out(&frame, 0.55);
        let p3 = ease_out(&frame, 1.0);
        let chip_font = FontQuery { family: SANS, size: 24, weight: 600, ..Default::default() };
        let chip_w = (frame.text_width(ctx, chip_font, self.chip).unwrap_or(self.chip.len() * 13) as f32 + 64.0).max(400.0);
        fframes::svgr!(
            <g opacity={opacity}>
                <g opacity={p1} transform={format!("translate(0 {})", (1.0 - p1) * 50.0)}>
                    <text x="960" y="470" text-anchor="middle" font-family={SANS} font-weight="700" font-size="128" letter-spacing="-3" fill={TEXT}>
                        {self.title}
                    </text>
                </g>
                <g opacity={p2} transform={format!("translate(0 {})", (1.0 - p2) * 40.0)}>
                    <text x="960" y="560" text-anchor="middle" font-family={SANS} font-weight="500" font-size="46" fill={MUTED}>
                        {self.subtitle}
                    </text>
                </g>
                <g opacity={p3}>
                    <rect x={960.0 - chip_w / 2.0} y="640" width={chip_w} height="56" rx="28" fill="#1e2440" stroke={ACCENT} stroke-opacity="0.6" />
                    <text x="960" y="677" text-anchor="middle" font-family={SANS} font-weight="600" font-size="24" fill={ACCENT}>{self.chip}</text>
                </g>
            </g>
        )
    }
}

// ---------------------------------------------------------------------------------------
// TerminalScene: commands typing out in a terminal window

/// A terminal line: a dim comment, a command typed after a `$` prompt, or green output.
#[derive(Clone, Copy, Debug)]
pub enum Line {
    Comment(&'static str),
    Command(&'static str),
    Output(&'static str),
}

/// Typed characters per second, and pauses.
const CPS: f32 = 45.0;
const AFTER_COMMAND: f32 = 0.55;
const AFTER_COMMENT: f32 = 0.45;
const TERMINAL_START: f32 = 0.8;
/// How long the finished terminal stays up.
const TERMINAL_HOLD: f32 = 2.6;

/// Up to 12 `lines` appearing one after another; commands type out. Its length follows from them.
#[derive(Debug)]
pub struct TerminalScene {
    pub name: &'static str,
    pub heading: &'static str,
    pub window_title: &'static str,
    pub lines: &'static [Line],
    pub caption: &'static str,
}

impl TerminalScene {
    /// (start, end) of each line's appearance; commands type out between the two.
    fn schedule(&self) -> Vec<(f32, f32)> {
        let mut t = TERMINAL_START;
        self.lines
            .iter()
            .map(|line| {
                let start = t;
                let (end, next) = match line {
                    Line::Command(s) => {
                        let end = start + s.chars().count() as f32 / CPS;
                        (end, end + AFTER_COMMAND)
                    }
                    Line::Comment(_) => (start, start + AFTER_COMMENT),
                    Line::Output(_) => (start, start + 0.4),
                };
                t = next;
                (start, end)
            })
            .collect()
    }

    fn seconds(&self) -> f32 {
        self.schedule().last().map(|&(_, e)| e).unwrap_or(0.0) + TERMINAL_HOLD
    }
}

impl Scene for TerminalScene {
    fn name(&self) -> &'static str {
        self.name
    }

    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(self.seconds())
    }

    fn overlap(&self) -> Overlap {
        Overlap::Previous(XFADE)
    }

    fn render_frame<'a>(&'a self, mut frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let total = self.seconds() + XFADE;
        let opacity = scene_opacity(&frame, total, true, true);
        let t = frame.seconds();
        const FS: f32 = 27.0;
        const LH: f32 = 46.0;
        let x0 = 240.0;
        let y0 = 270.0;
        let schedule = self.schedule();

        let mut cursor = (x0, y0);
        let mut typing = false;
        let lines: Vec<Svgr> = self
            .lines
            .iter()
            .zip(schedule.iter())
            .enumerate()
            .filter(|(_, (_, (start, _)))| t >= *start)
            .map(|(i, (line, &(start, end)))| {
                let y = y0 + i as f32 * LH;
                match *line {
                    Line::Comment(s) => {
                        cursor = (x0, y + LH);
                        fframes::svgr!(<text x={x0} y={y} font-family={MONO} font-weight="400" font-size={FS} fill={DIM}>{s}</text>)
                    }
                    Line::Output(s) => {
                        cursor = (x0 + 2.0 * 0.6 * FS, y + LH);
                        fframes::svgr!(<text x={x0} y={y} font-family={MONO} font-weight="400" font-size={FS} fill={GREEN}>{s}</text>)
                    }
                    Line::Command(s) => {
                        let n = s.chars().count();
                        let typed = if t >= end { n } else { (((t - start) * CPS) as usize).min(n) };
                        let text: String = s.chars().take(typed).collect();
                        let text_x = x0 + 2.0 * 0.6 * FS;
                        typing = t < end;
                        cursor = if t < end { (text_x + typed as f32 * 0.6 * FS, y) } else { (text_x, y + LH) };
                        fframes::svgr!(
                            <g>
                                <text x={x0} y={y} font-family={MONO} font-weight="700" font-size={FS} fill={ACCENT}>"$"</text>
                                <text x={text_x} y={y} font-family={MONO} font-weight="400" font-size={FS} fill={TEXT}>{text}</text>
                            </g>
                        )
                    }
                }
            })
            .collect();
        // Next prompt after the last line, with a blinking cursor.
        let last_end = schedule.last().map(|&(_, e)| e).unwrap_or(0.0);
        let final_prompt = if t >= last_end + AFTER_COMMAND {
            let y = y0 + self.lines.len() as f32 * LH;
            cursor = (x0 + 2.0 * 0.6 * FS, y);
            fframes::svgr!(<text x={x0} y={y} font-family={MONO} font-weight="700" font-size={FS} fill={ACCENT}>"$"</text>)
        } else {
            Svgr::empty()
        };
        let blink_on = typing || ((t * 2.0) as usize) % 2 == 0;

        let cap_o = window_opacity(&frame, 0.5, total - 0.2);
        let cap = caption(&mut frame, ctx, self.caption, 990.0, cap_o);

        fframes::svgr!(
            <g opacity={opacity}>
                {heading(&frame, self.heading, 120.0, 56.0)}
                <g opacity={ease_out(&frame, 0.2)}>
                    {window_chrome(190.0, 170.0, 1540.0, 740.0, self.window_title, "")}
                    {lines}
                    {final_prompt}
                    <rect x={cursor.0} y={cursor.1 - FS * 0.8} width={FS * 0.55} height={FS} fill={TEXT} opacity={if blink_on { 0.85 } else { 0.0 }} />
                </g>
                {cap}
            </g>
        )
    }
}

// ---------------------------------------------------------------------------------------
// CodeCard: a file with its important lines highlighted

/// Up to 12 `lines` of a file; those marked `true` get highlighted and the rest dim.
#[derive(Debug)]
pub struct CodeCard {
    pub name: &'static str,
    pub heading: &'static str,
    pub file: &'static str,
    pub lines: &'static [(&'static str, bool)],
    pub caption: &'static str,
    pub seconds: f32,
}

impl Scene for CodeCard {
    fn name(&self) -> &'static str {
        self.name
    }

    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(self.seconds)
    }

    fn overlap(&self) -> Overlap {
        Overlap::Previous(XFADE)
    }

    fn render_frame<'a>(&'a self, mut frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let total = self.seconds + XFADE;
        let opacity = scene_opacity(&frame, total, true, true);
        let hl = ease_out(&frame, 2.4);
        const FS: f32 = 28.0;
        const LH: f32 = 46.0;
        let (x0, y0) = (340.0, 300.0);
        let first_hl = self.lines.iter().position(|(_, h)| *h).unwrap_or(0);
        let lines: Vec<Svgr> = self
            .lines
            .iter()
            .enumerate()
            .map(|(i, &(s, highlighted))| {
                let y = y0 + i as f32 * LH;
                let fill = if highlighted { TEXT } else { MUTED };
                let o = if highlighted { 1.0 } else { lerp(1.0, 0.55, hl) };
                fframes::svgr!(<text x={x0} y={y} font-family={MONO} font-weight="400" font-size={FS} fill={fill} opacity={o}>{s}</text>)
            })
            .collect();
        let hl_y = y0 + first_hl as f32 * LH - 34.0;
        let hl_h = (self.lines.len() - first_hl) as f32 * LH + 4.0;
        let cap_o = window_opacity(&frame, 0.6, total - 0.2);
        let cap = caption(&mut frame, ctx, self.caption, 990.0, cap_o);
        fframes::svgr!(
            <g opacity={opacity}>
                {heading(&frame, self.heading, 120.0, 56.0)}
                <g opacity={ease_out(&frame, 0.2)}>
                    {window_chrome(290.0, 190.0, 1340.0, 700.0, self.file, "")}
                    <rect x={x0 - 24.0} y={hl_y} width={(1220.0 * hl).max(1.0)} height={hl_h} rx="10" fill={YELLOW} fill-opacity="0.12" stroke={YELLOW} stroke-opacity={0.6 * hl} />
                    {lines}
                </g>
                {cap}
            </g>
        )
    }
}

// ---------------------------------------------------------------------------------------
// StepsCard: the last scene

/// Numbered steps, each a command and what it is for, and links below. It must be the last
/// scene: it fades in but not out.
#[derive(Debug)]
pub struct StepsCard {
    pub name: &'static str,
    pub heading: &'static str,
    pub steps: &'static [(&'static str, &'static str)],
    pub links: &'static [&'static str],
    pub seconds: f32,
}

impl Scene for StepsCard {
    fn name(&self) -> &'static str {
        self.name
    }

    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(self.seconds)
    }

    fn overlap(&self) -> Overlap {
        Overlap::Previous(XFADE)
    }

    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let opacity = scene_opacity(&frame, self.seconds + XFADE, true, false);
        let steps: Vec<Svgr> = self
            .steps
            .iter()
            .enumerate()
            .map(|(i, &(cmd, what))| {
                let p = ease_out(&frame, 0.5 + i as f32 * 0.35);
                let y = 360.0 + i as f32 * 150.0;
                fframes::svgr!(
                    <g opacity={p} transform={format!("translate({} 0)", (1.0 - p) * 40.0)}>
                        <circle cx="440" cy={y} r="34" fill="#1e2440" stroke={ACCENT} stroke-width="2" />
                        <text x="440" y={y + 12.0} text-anchor="middle" font-family={SANS} font-weight="700" font-size="32" fill={ACCENT}>{format!("{}", i + 1)}</text>
                        <text x="510" y={y - 4.0} font-family={MONO} font-weight="500" font-size="34" fill={TEXT}>{cmd}</text>
                        <text x="510" y={y + 38.0} font-family={SANS} font-weight="400" font-size="24" fill={MUTED}>{what}</text>
                    </g>
                )
            })
            .collect();
        let links: Vec<Svgr> = self
            .links
            .iter()
            .enumerate()
            .map(|(i, &link)| {
                fframes::svgr!(<text x="960" y={880.0 + i as f32 * 46.0} text-anchor="middle" font-family={MONO} font-weight="400" font-size="26" fill={MUTED}>{link}</text>)
            })
            .collect();
        fframes::svgr!(
            <g opacity={opacity}>
                {heading(&frame, self.heading, 200.0, 60.0)}
                {steps}
                <g opacity={ease_out(&frame, 1.8)}>{links}</g>
            </g>
        )
    }
}

// ---------------------------------------------------------------------------------------
// Shot: one footage segment in a window card

/// A camera keyframe: at scene second `t`, show `zoom`x around (`x`, `y`) in source pixels of
/// the recording.
#[derive(Debug, Clone, Copy)]
pub struct Cam(pub f32, pub f32, pub f32, pub f32);

/// Plays one segment from `FFRAMES_FOOTAGE_DIR` at 1x, from its first frame to its last.
#[derive(Debug)]
pub struct Shot {
    pub name: &'static str,
    pub file: &'static str,
    /// Length of the segment file, seconds, as `cut.sh` prints it.
    pub len: f32,
    /// Shown on the left of the window's title bar.
    pub chapter: &'static str,
    /// Speed-up already applied to the segment, shown as a badge when above 1.
    pub speed: f32,
    /// At least one; eased between, held before the first and after the last.
    pub cams: &'static [Cam],
    /// (start, end, text), kept inside the shot so consecutive shots' captions swap.
    pub captions: &'static [(f32, f32, &'static str)],
    /// Highlight rings: (start, end, x, y, w, h) in source pixels.
    pub rings: &'static [(f32, f32, f32, f32, f32, f32)],
    /// Fade out rather than stay under the next scene as it fades in; set it before a drawn
    /// scene or a new chapter.
    pub fade_out: bool,
}

/// Camera at scene second `t`: eased between keyframes, held outside them.
fn camera_at(cams: &[Cam], t: f32) -> (f32, f32, f32) {
    let first = cams[0];
    if t <= first.0 {
        return (first.1, first.2, first.3);
    }
    for w in cams.windows(2) {
        let (a, b) = (w[0], w[1]);
        if t <= b.0 {
            let p = ease_in_out((t - a.0) / (b.0 - a.0).max(0.001));
            return (lerp(a.1, b.1, p), lerp(a.2, b.2, p), lerp(a.3, b.3, p));
        }
    }
    let last = cams[cams.len() - 1];
    (last.1, last.2, last.3)
}

// The recording's place on the 1920x1080 grid, 0.96x of a 1600x900 recording. Only the top 870
// source pixels show: the bottom 30 are the recording desktop's own taskbar.
const SRC_W: f32 = 1600.0;
const SRC_VISIBLE_H: f32 = 870.0;
const CX: f32 = 192.0;
const CY: f32 = 112.0;
const CW: f32 = 1536.0;
const K: f32 = CW / SRC_W;
const CH: f32 = SRC_VISIBLE_H * K;
const IMG_H: f32 = 900.0 * K;

impl Scene for Shot {
    fn name(&self) -> &'static str {
        self.name
    }

    // Overlap makes the scene XFADE longer, so its own length leaves that out: the footage
    // plays exactly once.
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(self.len - XFADE)
    }

    fn overlap(&self) -> Overlap {
        Overlap::Previous(XFADE)
    }

    fn render_frame<'a>(&'a self, mut frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let total = self.len;
        let t = frame.seconds();
        let opacity = scene_opacity(&frame, total, true, self.fade_out);
        let frames = (self.len * FPS as f32).round() as usize;

        let screen = match footage_frame(&frame, ctx, self.file, frame.index, frames) {
            Some(href) => fframes::svgr!(<image x={CX} y={CY} width={CW} height={IMG_H} preserveAspectRatio="none" href={href} />),
            None => fframes::svgr!(<rect x={CX} y={CY} width={CW} height={CH} fill="#000" />),
        };

        let (zoom, sx, sy) = camera_at(self.cams, t);
        let fx = CX + sx * K;
        let fy = CY + sy * K;
        let (hw, hh) = (CW / 2.0 / zoom, CH / 2.0 / zoom);
        let fx = fx.clamp(CX + hw, CX + CW - hw);
        let fy = fy.clamp(CY + hh, CY + CH - hh);
        let camera = format!("translate({} {}) scale({})", CX + CW / 2.0 - zoom * fx, CY + CH / 2.0 - zoom * fy, zoom);

        let rings: Vec<Svgr> = self
            .rings
            .iter()
            .map(|&(s, e, x, y, w, h)| {
                let o = window_opacity(&frame, s, e);
                fframes::svgr!(
                    <rect x={CX + x * K} y={CY + y * K} width={w * K} height={h * K}
                          rx="8" fill="none" stroke={YELLOW} stroke-width={3.0 / zoom} opacity={o} />
                )
            })
            .collect();

        let caption_svgs: Vec<Svgr> = self
            .captions
            .iter()
            .map(|&(s, e, text)| {
                let o = window_opacity(&frame, s.max(0.35), e.min(total - 0.15));
                caption(&mut frame, ctx, text, 1022.0, o)
            })
            .collect();

        let badge = if self.speed > 1.0 {
            let label = format!("{}× speed", self.speed);
            fframes::svgr!(
                <g>
                    <rect x="1600" y="68" width="116" height="32" rx="16" fill={ACCENT} fill-opacity="0.18" stroke={ACCENT} stroke-opacity="0.5" />
                    <text x="1658" y="91" text-anchor="middle" font-family={SANS} font-weight="700" font-size="18" fill={ACCENT}>{label}</text>
                </g>
            )
        } else {
            Svgr::empty()
        };

        let clip_id = format!("clip-{}", self.name);
        let clip_url = format!("url(#{clip_id})");
        fframes::svgr!(
            <g opacity={opacity}>
                <defs>
                    <clipPath id={clip_id}>
                        <path d={format!("M{CX} {CY} H{} V{} Q{} {} {} {} H{} Q{CX} {} {CX} {} Z",
                            CX + CW, CY + CH - 16.0, CX + CW, CY + CH, CX + CW - 16.0, CY + CH, CX + 16.0, CY + CH, CY + CH - 16.0)} />
                    </clipPath>
                </defs>
                {window_chrome(CX, CY - 44.0, CW, CH + 44.0, "T3 Code", self.chapter)}
                {badge}
                <g clip-path={clip_url}>
                    <g transform={camera}>
                        {screen}
                        {rings}
                    </g>
                </g>
                {caption_svgs}
            </g>
        )
    }
}
