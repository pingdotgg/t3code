//! Inline code chips in Markdown text, drawn like Conn's `.chat-markdown :not(pre) > code`.
//!
//! Conn's CSS gives an inline `code` span `font-size: 0.85em`, `padding: 0.1em 0.35em`, a 1px
//! transparent border, `border-radius: 0.25rem` and a `foreground` 10% background. GPUI's text
//! runs carry neither a size nor a corner radius, so a span cannot be drawn as one run of the
//! paragraph. Instead the paragraph reserves the chip's room with a run of invisible no-break
//! spaces, and [`InlineCodeText`] paints the rounded background and the code, at 0.85em, on top
//! of that room, using the paragraph's own text layout for the positions. The surrounding text
//! wraps around the chip as it would around a word.

use std::ops::Range;

use gpui_kit::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, Hsla, InspectorElementId,
    IntoElement, LayoutId, Pixels, ShapedLine, SharedString, TextAlign, TextLayout, TextRun,
    Window, fill, point, px, size,
};

/// `font-size: 0.85em`.
pub(super) const CODE_EM: f32 = 0.85;
/// `padding: 0.1em 0.35em`, in em of the code's own size.
const PAD_Y_EM: f32 = 0.1;
const PAD_X_EM: f32 = 0.35;
/// `border: 1px solid transparent`: it takes room, and the background paints under it.
const BORDER_PX: f32 = 1.0;
/// `border-radius: 0.25rem`.
const RADIUS_PX: f32 = 4.0;
/// The invisible character that reserves the chip's width: it neither wraps nor collapses.
const NBSP: char = '\u{a0}';

/// Horizontal room a chip adds on each side of its text (`0.35em` padding + 1px border).
pub(super) fn chip_pad_x(code_px: f32) -> f32 {
    PAD_X_EM * code_px + BORDER_PX
}

/// Vertical room a chip adds above and below the code's font box (`0.1em` padding + border).
fn chip_pad_y(code_px: f32) -> f32 {
    PAD_Y_EM * code_px + BORDER_PX
}

/// Number of no-break spaces (`space_px` wide each) that reserve `width` px, at least one.
pub(super) fn nbsp_count(width: f32, space_px: f32) -> usize {
    if space_px <= 0.0 {
        return 1;
    }
    (width / space_px).round().max(1.0) as usize
}

/// Line height to paint the code with so its baseline lands on the body text's baseline: GPUI
/// centres a line's ascent + descent inside its line height, so the two fonts need different
/// line heights to share a baseline.
pub(super) fn code_line_height(
    body_line_height: f32,
    body_ascent: f32,
    body_descent: f32,
    code_ascent: f32,
    code_descent: f32,
) -> f32 {
    body_line_height + body_ascent - body_descent - code_ascent + code_descent
}

/// Where a chip goes in a paragraph, planned while the text is built.
pub(super) struct ChipPlan {
    /// Byte range of the reserved no-break spaces in the paragraph text.
    pub(super) range: Range<usize>,
    /// How many reserved spaces, and the width of one.
    pub(super) nbsp: usize,
    pub(super) space_px: f32,
    /// The code, shaped at `0.85em` in the mono font.
    pub(super) shaped: ShapedLine,
    pub(super) color: Hsla,
    pub(super) code_px: f32,
}

/// What [`InlineCodeText`] paints: the paragraph element, its text layout and its chips.
pub(super) struct Built {
    pub(super) inner: AnyElement,
    pub(super) layout: TextLayout,
    pub(super) chips: Vec<ChipPlan>,
}

/// A paragraph with inline code chips. The paragraph is built on first layout, when the window's
/// text system can measure the code.
pub(super) struct InlineCodeText {
    build: Option<Box<dyn FnOnce(&mut Window) -> Built>>,
    background: Hsla,
    built: Option<Built>,
}

impl InlineCodeText {
    pub(super) fn new(
        background: Hsla,
        build: impl FnOnce(&mut Window) -> Built + 'static,
    ) -> Self {
        Self {
            build: Some(Box::new(build)),
            background,
            built: None,
        }
    }
}

/// `ShapedLine` of `text` in `font` at `size`, one run of `color`.
pub(super) fn shape(
    window: &Window,
    text: &str,
    font: gpui_kit::Font,
    size: Pixels,
    color: Hsla,
) -> ShapedLine {
    let text = SharedString::from(text.to_owned());
    let run = TextRun {
        len: text.len(),
        font,
        color,
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    window.text_system().shape_line(text, size, &[run], None)
}

/// The chip's text in `chip.shaped` from byte `from`, as many whole characters as fit `width`.
/// At least one character, so a chip split across lines always makes progress.
fn chars_that_fit(shaped: &ShapedLine, from: usize, width: f32) -> usize {
    let text = shaped.text.as_ref();
    let start_x = f32::from(shaped.x_for_index(from));
    let mut end = from;
    for (offset, ch) in text[from..].char_indices() {
        let next = from + offset + ch.len_utf8();
        if end > from && f32::from(shaped.x_for_index(next)) - start_x > width {
            break;
        }
        end = next;
    }
    end
}

/// The lines a chip's `nbsp` reserved spaces (from byte `start`) sit on, as `(x, y, count)` of
/// the first space on each line. A chip wraps whole to the next line unless it is wider than the
/// line, so this is one fragment in the usual case.
///
/// Each space is placed by where it *ends*: GPUI's `position_for_index` counts a line's end index
/// as part of that line, so the start of a space at the head of a wrapped line would be reported
/// at the end of the line before. A chip wrapped to a new line then showed its first space as a
/// stub on the old line ("b" / "itbucket.accessToken").
fn chip_fragments(
    start: usize,
    nbsp: usize,
    space_px: f32,
    position_for_index: impl Fn(usize) -> Option<gpui_kit::Point<Pixels>>,
) -> Vec<(Pixels, Pixels, usize)> {
    let mut fragments: Vec<(Pixels, Pixels, usize)> = Vec::new();
    for k in 0..nbsp {
        let Some(end) = position_for_index(start + (k + 1) * NBSP.len_utf8()) else {
            continue;
        };
        match fragments.last_mut() {
            Some((_, y, count)) if *y == end.y => *count += 1,
            _ => fragments.push((px(f32::from(end.x) - space_px), end.y, 1)),
        }
    }
    fragments
}

impl InlineCodeText {
    /// Paints each chip's rounded background and its code over the reserved spaces.
    fn paint_chips(&self, built: &Built, window: &mut Window, cx: &mut App) {
        let style = window.text_style();
        let body_px = style.font_size.to_pixels(window.rem_size());
        let body = shape(
            window,
            "x",
            gpui_kit::Font {
                family: ".SystemUIFont".into(),
                features: gpui_kit::FontFeatures::default(),
                fallbacks: None,
                weight: gpui_kit::FontWeight::NORMAL,
                style: gpui_kit::FontStyle::Normal,
            },
            body_px,
            Hsla::default(),
        );
        let (body_ascent, body_descent) = (f32::from(body.ascent), f32::from(body.descent));
        let line_height = built.layout.line_height();

        for chip in &built.chips {
            let (ascent, descent) = (
                f32::from(chip.shaped.ascent),
                f32::from(chip.shaped.descent),
            );
            let pad = chip_pad_x(chip.code_px);
            let box_height = ascent + descent + 2.0 * chip_pad_y(chip.code_px);
            let text_line_height = px(code_line_height(
                f32::from(line_height),
                body_ascent,
                body_descent,
                ascent,
                descent,
            ));
            // The code's baseline is the body's: `(line height + ascent - descent) / 2` down.
            let baseline = (f32::from(line_height) + body_ascent - body_descent) / 2.0;

            // One fragment per line the reserved spaces wrap onto (usually one).
            let fragments = chip_fragments(chip.range.start, chip.nbsp, chip.space_px, |index| {
                built.layout.position_for_index(index)
            });
            let last = fragments.len().saturating_sub(1);
            let mut cursor = 0;
            for (index, &(x, y, count)) in fragments.iter().enumerate() {
                let width = count as f32 * chip.space_px;
                window.paint_quad(
                    fill(
                        Bounds {
                            origin: point(x, y + px(baseline - ascent - chip_pad_y(chip.code_px))),
                            size: size(px(width), px(box_height)),
                        },
                        self.background,
                    )
                    .corner_radii(px(RADIUS_PX)),
                );

                let code_len = chip.shaped.text.len();
                if fragments.len() == 1 {
                    let text_x = x + px((width - f32::from(chip.shaped.width())) / 2.0);
                    if let Err(err) = chip.shaped.paint(
                        point(text_x, y),
                        text_line_height,
                        TextAlign::Left,
                        None,
                        window,
                        cx,
                    ) {
                        log::debug!("inline code paint failed: {err}");
                    }
                } else if cursor < code_len {
                    // A chip wider than the line: the code continues on each fragment.
                    let room = width
                        - if index == 0 { pad } else { 0.0 }
                        - if index == last { pad } else { 0.0 };
                    let end = if index == last {
                        code_len
                    } else {
                        chars_that_fit(&chip.shaped, cursor, room)
                    };
                    let piece = &chip.shaped.text[cursor..end];
                    let line = shape(
                        window,
                        piece,
                        gpui_kit::Font {
                            family: crate::theme::MONO_FONT.into(),
                            features: gpui_kit::FontFeatures::default(),
                            fallbacks: None,
                            weight: gpui_kit::FontWeight::NORMAL,
                            style: gpui_kit::FontStyle::Normal,
                        },
                        px(chip.code_px),
                        chip.color,
                    );
                    let text_x = x + px(if index == 0 { pad } else { 0.0 });
                    if let Err(err) = line.paint(
                        point(text_x, y),
                        text_line_height,
                        TextAlign::Left,
                        None,
                        window,
                        cx,
                    ) {
                        log::debug!("inline code paint failed: {err}");
                    }
                    cursor = end;
                }
            }
        }
    }
}

impl Element for InlineCodeText {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut built = match self.build.take() {
            Some(build) => build(window),
            None => match self.built.take() {
                Some(built) => built,
                None => {
                    return (
                        window.request_layout(gpui_kit::Style::default(), [], cx),
                        (),
                    );
                }
            },
        };
        let layout_id = built.inner.request_layout(window, cx);
        self.built = Some(built);
        (layout_id, ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _state: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        if let Some(built) = self.built.as_mut() {
            built.inner.prepaint(window, cx);
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _state: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Some(mut built) = self.built.take() else {
            return;
        };
        self.paint_chips(&built, window, cx);
        built.inner.paint(window, cx);
        self.built = Some(built);
    }
}

impl IntoElement for InlineCodeText {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Conn's chip at the body's 14px: 11.9px code, 4.165px + 1px padding either side.
    #[test]
    fn chip_metrics_follow_the_web_css() {
        let code_px = 14.0 * CODE_EM;
        assert!((code_px - 11.9).abs() < 1e-4);
        assert!((chip_pad_x(code_px) - (0.35 * 11.9 + 1.0)).abs() < 1e-4);
        assert!((chip_pad_y(code_px) - (0.1 * 11.9 + 1.0)).abs() < 1e-4);
    }

    #[test]
    fn the_reserved_room_is_within_half_a_space_of_the_chip() {
        for width in [20.0_f32, 63.5, 101.2, 400.0] {
            let n = nbsp_count(width, 3.9);
            assert!(
                ((n as f32) * 3.9 - width).abs() <= 3.9 / 2.0 + 1e-3,
                "{width}"
            );
        }
        assert_eq!(nbsp_count(0.0, 3.9), 1);
        assert_eq!(nbsp_count(10.0, 0.0), 1);
    }

    /// A chip that fits a line wraps whole to the next one: its reserved spaces are one fragment on
    /// that line, never a one-space stub at the end of the line before. A chip wider than the line
    /// splits across lines but keeps every space.
    #[gpui_kit::test]
    fn a_chip_wraps_whole_and_splits_only_when_wider_than_the_line(
        cx: &mut gpui_kit::TestAppContext,
    ) {
        use gpui_kit::test::TestWindowExt as _;
        use gpui_kit::{Context, IntoElement, Render};

        struct Probe;
        impl Render for Probe {
            fn render(
                &mut self,
                window: &mut Window,
                _cx: &mut Context<'_, Self>,
            ) -> impl IntoElement {
                let font = gpui_kit::Font {
                    family: ".SystemUIFont".into(),
                    features: gpui_kit::FontFeatures::default(),
                    fallbacks: None,
                    weight: gpui_kit::FontWeight::NORMAL,
                    style: gpui_kit::FontStyle::Normal,
                };
                let line_width = 200.0_f32;
                let line_height = 20.0_f32;
                let space = shape(
                    window,
                    &NBSP.to_string().repeat(16),
                    font.clone(),
                    px(14.0),
                    Hsla::default(),
                );
                let space_px = f32::from(space.width()) / 16.0;
                // About 60% of the line, so a chip of 60% of the line cannot follow it on that line.
                let lead = "mmmmmmmmmm ";
                let fragments_for = |window: &mut Window, nbsp: usize| {
                    let text = format!("{lead}{} tail", NBSP.to_string().repeat(nbsp));
                    let run = TextRun {
                        len: text.len(),
                        font: font.clone(),
                        color: Hsla::default(),
                        background_color: None,
                        underline: None,
                        strikethrough: None,
                    };
                    let lines = window
                        .text_system()
                        .shape_text(
                            SharedString::from(text),
                            px(14.0),
                            &[run],
                            Some(px(line_width)),
                            None,
                        )
                        .expect("shapes");
                    chip_fragments(lead.len(), nbsp, space_px, |index| {
                        lines[0].position_for_index(index, px(line_height))
                    })
                };

                // Fits a line (60% of it) but not the rest of the first line after the lead.
                let fits = (0.6 * line_width / space_px) as usize;
                let whole = fragments_for(window, fits);
                assert_eq!(whole.len(), 1, "one fragment: {whole:?}");
                assert_eq!(whole[0].2, fits, "all spaces on one line");
                assert!(
                    f32::from(whole[0].1) > 0.0,
                    "wrapped below the first line: {whole:?}"
                );
                assert!(
                    f32::from(whole[0].0).abs() < 1.0,
                    "starts at the line's left edge: {whole:?}"
                );

                // Wider than a line: it splits, no space lost.
                let wide = (1.6 * line_width / space_px) as usize;
                let split = fragments_for(window, wide);
                assert!(split.len() >= 2, "{split:?}");
                assert_eq!(split.iter().map(|f| f.2).sum::<usize>(), wide);
                gpui_kit::div()
            }
        }

        let (_, vcx) = cx.add_window_view(|_, _| Probe);
        vcx.update(|window, cx| window.render_frame(cx));
    }

    /// With the line height from `code_line_height`, GPUI's centring puts both baselines together.
    #[test]
    fn code_and_body_share_a_baseline() {
        let (lh, body_a, body_d, code_a, code_d) = (22.75_f32, 13.2, 3.4, 12.1, 3.6);
        let baseline = |line_height: f32, a: f32, d: f32| (line_height - a - d) / 2.0 + a;
        let code_lh = code_line_height(lh, body_a, body_d, code_a, code_d);
        assert!((baseline(lh, body_a, body_d) - baseline(code_lh, code_a, code_d)).abs() < 1e-4);
    }
}
