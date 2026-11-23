//! Lightweight turning-arc spinner for active tool calls and the Working row.
//!
//! Only schedules a repaint timer when actually rendered in the element tree, so idle
//! views incur zero timer wakeups and zero GPU repaints.

use std::cell::RefCell;
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use gpui_kit::{
    App, AppContext as _, Bounds, Element, ElementId, EntityId, GlobalElementId, HighlightStyle,
    Hsla, InspectorElementId, IntoElement, LayoutId, PathBuilder, Pixels, RenderOnce, SharedString,
    Styled as _, StyledText, TextAlign, TextLayout, Window, canvas, fill, point, px, size,
};

/// Full rotation period in seconds.
const TURN_SECONDS: f32 = 0.9;
/// ~30 fps refresh interval so spinners stay smooth without pegging high-refresh displays.
const FRAME_INTERVAL: Duration = Duration::from_millis(33);
/// Fraction of the ring drawn (three-quarters arc).
const ARC_SWEEP: f32 = 0.75;

/// Shimmer period matching Conn's `live-tool-shine 2.2s steps(30) infinite` (`index.css:620`).
const SHIMMER_PERIOD_MS: u128 = 2_200;
/// Half-width of the glowing highlight band in characters (~4.5rem band).
const SHIMMER_BAND_HALF_CHARS: f32 = 5.0;
/// Tick of the "Working for 44s" label. The shimmer itself asks for display frames while painted.
pub(super) const SHIMMER_STEP_INTERVAL: Duration = Duration::from_millis(1_000);

/// Number of alpha steps the highlight overlay is quantised to, so the one-glyph overlay lines
/// stay in GPUI's line layout cache from frame to frame.
const SHIMMER_ALPHA_LEVELS: f32 = 24.0;
/// Byte length of the `…` that `text_ellipsis` appends to a truncated line.
const ELLIPSIS_BYTES: usize = 3;

/// Renders `text` with Conn's left-to-right `live-tool-shine` shimmer sweeping a highlight band
/// from `base` (muted) up to `highlight` (foreground) and back.
///
/// The whole line is shaped once with a single `base` run, so GPUI's line layout cache hits on
/// every frame. Each frame only repaints the few glyphs inside the band, in `highlight` with an
/// alpha that follows the cosine falloff. Per-frame cost depends on the band, not the line length.
#[must_use]
pub(super) fn shimmer_text(text: &str, base: Hsla, highlight: Hsla) -> ShimmerText {
    ShimmerText::new(text, base, highlight, None)
}

/// Same as [`shimmer_text`] at a fixed `phase` (0..1) and without frame requests.
#[must_use]
#[cfg(test)]
pub(super) fn shimmer_text_at(text: &str, base: Hsla, highlight: Hsla, phase: f32) -> ShimmerText {
    ShimmerText::new(text, base, highlight, Some(phase))
}

/// Phase (0..1) of the sweep, continuous over [`SHIMMER_PERIOD_MS`].
fn clock_phase() -> f32 {
    static START: OnceLock<Instant> = OnceLock::new();
    let elapsed_ms = START.get_or_init(Instant::now).elapsed().as_millis();
    ((elapsed_ms % SHIMMER_PERIOD_MS) as f32) / (SHIMMER_PERIOD_MS as f32)
}

/// Cosine falloff of the band at `idx` (in characters) for a band centred on `center`.
fn band_weight(idx: f32, center: f32) -> f32 {
    let dist = (idx - center).abs() / SHIMMER_BAND_HALF_CHARS;
    if dist < 1.0 {
        0.5 * (1.0 + (dist * std::f32::consts::PI).cos())
    } else {
        0.0
    }
}

pub(super) struct ShimmerText {
    text: SharedString,
    highlight: Hsla,
    /// `Some` freezes the sweep (tests); `None` follows the clock and asks for frames.
    phase: Option<f32>,
    ascii: bool,
    char_count: usize,
    inner: StyledText,
    layout: TextLayout,
}

impl ShimmerText {
    fn new(text: &str, base: Hsla, highlight: Hsla, phase: Option<f32>) -> Self {
        let text = SharedString::from(text.to_owned());
        let inner = StyledText::new(text.clone()).with_highlights((!text.is_empty()).then(|| {
            (
                0..text.len(),
                HighlightStyle {
                    color: Some(base),
                    ..Default::default()
                },
            )
        }));
        let layout = inner.layout().clone();
        Self {
            ascii: text.is_ascii(),
            char_count: if text.is_ascii() {
                text.len()
            } else {
                text.chars().count()
            },
            text,
            highlight,
            phase,
            inner,
            layout,
        }
    }

    /// Repaints the glyphs inside the band in `highlight`, on top of the base line.
    fn paint_band(&self, window: &mut Window, cx: &mut App) {
        if self.char_count == 0 {
            return;
        }
        let phase = match self.phase {
            Some(phase) => phase,
            None => {
                if !cx.reduce_motion() {
                    window.request_animation_frame();
                }
                clock_phase()
            }
        };
        let band = SHIMMER_BAND_HALF_CHARS;
        let center = -band + phase * ((self.char_count as f32) + 2.0 * band);
        let first = (center - band).floor().max(0.0) as usize;
        let last = ((center + band).ceil().max(0.0) as usize).min(self.char_count - 1);
        if first > last {
            return;
        }

        // A truncated line shows a prefix of `text` followed by the ellipsis.
        let shown = self.layout.len();
        let shown = if shown < self.text.len() {
            shown.saturating_sub(ELLIPSIS_BYTES)
        } else {
            shown
        };

        let style = window.text_style();
        let font_size = style.font_size.to_pixels(window.rem_size());
        let line_height = self.layout.line_height();
        let mut chars = self
            .text
            .char_indices()
            .skip(if self.ascii { 0 } else { first });
        for idx in first..=last {
            let (byte, ch) = if self.ascii {
                (idx, char::from(self.text.as_bytes()[idx]))
            } else if let Some(entry) = chars.next() {
                entry
            } else {
                break;
            };
            if byte + ch.len_utf8() > shown {
                break;
            }
            let level = (band_weight(idx as f32, center) * SHIMMER_ALPHA_LEVELS).round();
            if level < 1.0 || ch.is_whitespace() {
                continue;
            }
            let Some(origin) = self.layout.position_for_index(byte) else {
                continue;
            };
            let glyph = SharedString::from(ch.to_string());
            let mut glyph_style = style.clone();
            glyph_style.color = Hsla {
                a: self.highlight.a * level / SHIMMER_ALPHA_LEVELS,
                ..self.highlight
            };
            let run = glyph_style.to_run(glyph.len());
            let line = window
                .text_system()
                .shape_line(glyph, font_size, &[run], None);
            if let Err(err) = line.paint(origin, line_height, TextAlign::Left, None, window, cx) {
                log::debug!("shimmer glyph paint failed: {err}");
            }
        }
    }
}

impl Element for ShimmerText {
    type RequestLayoutState = <StyledText as Element>::RequestLayoutState;
    type PrepaintState = <StyledText as Element>::PrepaintState;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        self.inner.request_layout(id, inspector_id, window, cx)
    }

    fn prepaint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        state: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        self.inner
            .prepaint(id, inspector_id, bounds, state, window, cx)
    }

    fn paint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        state: &mut Self::RequestLayoutState,
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.inner
            .paint(id, inspector_id, bounds, state, prepaint, window, cx);
        self.paint_band(window, cx);
    }
}

impl IntoElement for ShimmerText {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

thread_local! {
    /// Views that already have a pending spinner tick timer.
    static TICKING: RefCell<HashSet<EntityId>> = RefCell::new(HashSet::new());
}

/// Three-quarter turning arc spinner painted directly on a GPUI canvas.
#[derive(IntoElement)]
pub(super) struct TurningArc {
    side: f32,
    color: Hsla,
}

impl TurningArc {
    pub(super) fn new(side: f32, color: Hsla) -> Self {
        Self { side, color }
    }
}

impl RenderOnce for TurningArc {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let color = self.color;
        canvas(
            |_, _, _| {},
            move |bounds, _, window, cx| {
                paint_arc(bounds, color, window);
                schedule_next_frame(window, cx);
            },
        )
        .flex_none()
        .size(px(self.side))
    }
}

fn paint_arc(bounds: Bounds<Pixels>, color: Hsla, window: &mut Window) {
    static START: OnceLock<Instant> = OnceLock::new();
    let turned = (START.get_or_init(Instant::now).elapsed().as_secs_f32() / TURN_SECONDS).fract();

    let stroke_width = 1.6_f32;
    let side = f32::from(bounds.size.width).min(f32::from(bounds.size.height));
    let radius = ((side - 3.0) / 2.0).max(1.0);
    let center = bounds.center();
    let at = |angle: f32| {
        point(
            center.x + px(radius * angle.cos()),
            center.y + px(radius * angle.sin()),
        )
    };

    let start = turned * std::f32::consts::TAU;
    let end = start + ARC_SWEEP * std::f32::consts::TAU;
    let mut path = PathBuilder::stroke(px(stroke_width));
    path.move_to(at(start));
    path.arc_to(
        point(px(radius), px(radius)),
        px(0.0),
        ARC_SWEEP > 0.5,
        true,
        at(end),
    );
    if let Ok(built) = path.build() {
        window.paint_path(built, color);
    }

    // Round caps at both arc endpoints.
    for angle in [start, end] {
        let c = at(angle);
        let dot = Bounds {
            origin: point(c.x - px(stroke_width / 2.0), c.y - px(stroke_width / 2.0)),
            size: size(px(stroke_width), px(stroke_width)),
        };
        window.paint_quad(fill(dot, color).corner_radii(px(stroke_width / 2.0)));
    }
}

fn schedule_next_frame(window: &mut Window, cx: &mut App) {
    let view_id = window.current_view();
    let already_ticking = TICKING.with(|set| !set.borrow_mut().insert(view_id));
    if already_ticking {
        return;
    }
    let window_handle = window.window_handle();
    cx.spawn(async move |cx| {
        cx.background_executor().timer(FRAME_INTERVAL).await;
        TICKING.with(|set| {
            set.borrow_mut().remove(&view_id);
        });
        let _ = cx.update_window(window_handle, |_, _, cx| {
            cx.notify(view_id);
        });
    })
    .detach();
}

#[cfg(test)]
mod bench {
    use std::time::Instant;

    use gpui_kit::test::TestWindowExt as _;
    use gpui_kit::{
        AnyElement, Context, HighlightStyle, Hsla, IntoElement, ParentElement as _, Render, Rgba,
        Styled as _, StyledText, TestAppContext, Window, div, hsla, px,
    };

    use super::{SHIMMER_BAND_HALF_CHARS, band_weight, shimmer_text_at};

    /// The previous implementation: one highlight run per character, rebuilt every frame.
    fn legacy_shimmer_text_at(text: &str, base: Hsla, highlight: Hsla, phase: f32) -> StyledText {
        let char_count = text.chars().count();
        let base_rgba: Rgba = base.into();
        let hi_rgba: Rgba = highlight.into();
        let center = -SHIMMER_BAND_HALF_CHARS
            + phase * ((char_count as f32) + 2.0 * SHIMMER_BAND_HALF_CHARS);
        let mut highlights = Vec::with_capacity(char_count);
        for (idx, (byte_start, ch)) in text.char_indices().enumerate() {
            let weight = band_weight(idx as f32, center);
            let color: Hsla = Rgba {
                r: base_rgba.r + (hi_rgba.r - base_rgba.r) * weight,
                g: base_rgba.g + (hi_rgba.g - base_rgba.g) * weight,
                b: base_rgba.b + (hi_rgba.b - base_rgba.b) * weight,
                a: base_rgba.a + (hi_rgba.a - base_rgba.a) * weight,
            }
            .into();
            highlights.push((
                byte_start..byte_start + ch.len_utf8(),
                HighlightStyle {
                    color: Some(color),
                    ..Default::default()
                },
            ));
        }
        StyledText::new(text.to_owned()).with_highlights(highlights)
    }

    struct Bench {
        text: String,
        phase: f32,
        legacy: bool,
        wrap: bool,
    }

    impl Render for Bench {
        fn render(&mut self, _w: &mut Window, _cx: &mut Context<'_, Self>) -> impl IntoElement {
            let (base, hi) = (hsla(0.0, 0.0, 0.5, 1.0), hsla(0.0, 0.0, 1.0, 1.0));
            let label: AnyElement = if self.legacy {
                legacy_shimmer_text_at(&self.text, base, hi, self.phase).into_any_element()
            } else {
                shimmer_text_at(&self.text, base, hi, self.phase).into_any_element()
            };
            let row = div().w(px(600.0)).overflow_hidden().text_size(px(13.0));
            if self.wrap {
                row.child(label)
            } else {
                row.text_ellipsis().whitespace_nowrap().child(label)
            }
        }
    }

    /// Prints per-frame time (layout + paint) for the old and new shimmer at several line lengths.
    #[gpui_kit::test]
    fn shimmer_frame_cost_by_length(cx: &mut TestAppContext) {
        for (wrap, legacy) in [(false, true), (false, false), (true, true), (true, false)] {
            for len in [20usize, 200, 2_000, 20_000] {
                let text: String = "cargo test --workspace -- --nocapture "
                    .chars()
                    .cycle()
                    .take(len)
                    .collect();
                let (view, vcx) = cx.add_window_view(|_, _| Bench {
                    text,
                    phase: 0.0,
                    legacy,
                    wrap,
                });
                let frames = 120;
                vcx.update(|window, cx| window.render_frame(cx));
                let start = Instant::now();
                for i in 0..frames {
                    let phase = (i as f32) / (frames as f32);
                    view.update(vcx, |b, cx| {
                        b.phase = phase;
                        cx.notify();
                    });
                    vcx.update(|window, cx| window.render_frame(cx));
                }
                let per = start.elapsed().as_secs_f64() * 1000.0 / f64::from(frames);
                eprintln!(
                    "SHIMMER_BENCH impl={} mode={} len={len:>6} per_frame_ms={per:.3}",
                    if legacy { "old" } else { "new" },
                    if wrap { "wrap    " } else { "ellipsis" },
                );
            }
        }
    }

    #[test]
    fn band_weight_is_cosine_bell() {
        assert!((band_weight(10.0, 10.0) - 1.0).abs() < 1e-6);
        assert!(band_weight(10.0 + SHIMMER_BAND_HALF_CHARS, 10.0).abs() < 1e-6);
        assert!((band_weight(12.5, 10.0) - 0.5).abs() < 1e-6);
    }
}
