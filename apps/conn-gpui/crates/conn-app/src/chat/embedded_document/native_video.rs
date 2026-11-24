//! The inline player for video Chromium cannot decode (H.264 MP4): AVFoundation decodes it
//! ([`AvPlayer`]), GPUI paints each frame, and the controls are GPUI elements, so the video sits
//! in the chat like any other card and launches nothing outside the app.
//!
//! Controls: play, pause and replay (the button), a seek slider, the time, and mute. Clicking the
//! picture also plays and pauses.

use std::fmt;
use std::time::Duration;

use conn_theme::Rgba;
use gpui_kit::component::slider::{Slider, SliderEvent, SliderState};
use gpui_kit::prelude::*;
use gpui_kit::{
    Bounds, Context, Div, Entity, EventEmitter, FontWeight, Hsla, IntoElement, ParentElement,
    Pixels, Render, Stateful, Styled, Subscription, Task, Window, canvas, div, point, px, size,
};
use objc2_core_foundation::CFRetained;
use objc2_core_video::{CVPixelBuffer, CVPixelBufferGetHeight, CVPixelBufferGetWidth};

use super::av_player::{AvPlayer, ItemState, Snapshot};
use crate::a11y::ConnA11yExt as _;
use crate::chat::color::hsla;
use crate::chat::icons;

const UI_TEXT_PX: f32 = 12.0;
const UI_LINE_HEIGHT_PX: f32 = 16.0;
const BAR_HEIGHT_PX: f32 = 40.0;
const BUTTON_PX: f32 = 28.0;
/// The seek slider runs over this many steps whatever the video's length, so it never has to be
/// rebuilt when the duration becomes known.
const SLIDER_STEPS: f32 = 1000.0;
/// How often the player is polled while it plays, loads or is being scrubbed, and otherwise.
const ACTIVE_POLL: Duration = Duration::from_millis(16);
const IDLE_POLL: Duration = Duration::from_millis(250);
/// A paused video this close to its end counts as ended.
const END_SLACK_SECONDS: f64 = 0.15;

const PLAY: &str = "superhero/play.svg";
const PAUSE: &str = "superhero/pause.svg";
const REPLAY: &str = "superhero/redo.svg";
const SPEAKER: &str = "superhero/speaker.svg";
const MUTED: &str = "superhero/mute.svg";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum NativeVideoEvent {
    /// The video cannot be played; the owner shows its error.
    Failed,
}

pub(super) struct NativeVideo {
    ax_id: String,
    player: Option<AvPlayer>,
    frame: Option<CFRetained<CVPixelBuffer>>,
    state: Snapshot,
    ended: bool,
    scrubbing: bool,
    visible: bool,
    slider: Entity<SliderState>,
    _slider_events: Subscription,
    _poll: Option<Task<()>>,
}

impl fmt::Debug for NativeVideo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NativeVideo")
            .field("ax_id", &self.ax_id)
            .finish_non_exhaustive()
    }
}

impl EventEmitter<NativeVideoEvent> for NativeVideo {}

/// `m:ss`, or `h:mm:ss` from an hour.
fn format_time(seconds: f64) -> String {
    let total = if seconds.is_finite() {
        seconds.max(0.0) as u64
    } else {
        0
    };
    let (hours, minutes, secs) = (total / 3600, total / 60 % 60, total % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{secs:02}")
    } else {
        format!("{minutes}:{secs:02}")
    }
}

/// The largest `width`×`height` picture that fits `bounds`, centred.
fn fit(bounds: Bounds<Pixels>, width: f32, height: f32) -> Bounds<Pixels> {
    let (box_width, box_height) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
    if width <= 0.0 || height <= 0.0 || box_width <= 0.0 || box_height <= 0.0 {
        return bounds;
    }
    let scale = (box_width / width).min(box_height / height);
    let (fitted_width, fitted_height) = (width * scale, height * scale);
    Bounds::new(
        point(
            bounds.origin.x + px((box_width - fitted_width) / 2.0),
            bounds.origin.y + px((box_height - fitted_height) / 2.0),
        ),
        size(px(fitted_width), px(fitted_height)),
    )
}

fn icon_button(id: String, label: &'static str, icon: &'static str, color: Hsla) -> Stateful<Div> {
    div()
        .id(id.clone())
        .a11y_button(id, label)
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(BUTTON_PX))
        .rounded(px(BUTTON_PX / 2.0))
        .cursor_pointer()
        .child(icons::icon(icon, 16.0, color))
}

impl NativeVideo {
    /// Wraps an opened player, paused. The owner builds it with [`AvPlayer::open`] so it can show
    /// that error itself.
    pub(super) fn new(player: AvPlayer, ax_id: String, cx: &mut Context<'_, Self>) -> Self {
        let slider = cx.new(|_| SliderState::new().min(0.0).max(SLIDER_STEPS).step(1.0));
        let subscription = cx.subscribe(&slider, |this, _slider, event: &SliderEvent, cx| {
            this.on_slider(event, cx);
        });
        let state = player.snapshot();
        let poll = cx.spawn(async move |this, cx| {
            let mut wait = ACTIVE_POLL;
            loop {
                cx.background_executor().timer(wait).await;
                match this.update(cx, |video, cx| video.tick(cx)) {
                    Ok(next) => wait = next,
                    Err(_) => break,
                }
            }
        });
        Self {
            ax_id,
            player: Some(player),
            frame: None,
            state,
            ended: false,
            scrubbing: false,
            visible: true,
            slider,
            _slider_events: subscription,
            _poll: Some(poll),
        }
    }

    /// A hidden video pauses and stops decoding for display.
    pub(super) fn set_visible(&mut self, visible: bool, cx: &mut Context<'_, Self>) {
        if self.visible == visible {
            return;
        }
        self.visible = visible;
        if !visible && let Some(player) = &self.player {
            player.pause();
        }
        cx.notify();
    }

    fn fail(&mut self, cx: &mut Context<'_, Self>) {
        self.player = None;
        self.frame = None;
        cx.emit(NativeVideoEvent::Failed);
        cx.notify();
    }

    /// Reads the player, takes a new frame if there is one, and repaints if anything changed.
    /// Returns how soon to look again.
    fn tick(&mut self, cx: &mut Context<'_, Self>) -> Duration {
        let Some(player) = &self.player else {
            return IDLE_POLL;
        };
        let snapshot = player.snapshot();
        if snapshot.item == ItemState::Failed {
            self.fail(cx);
            return IDLE_POLL;
        }
        let ready = snapshot.item == ItemState::Ready;
        let mut changed = false;
        if self.visible
            && ready
            && let Some(frame) = player.next_frame(self.frame.is_none())
        {
            self.frame = Some(frame);
            changed = true;
        }
        let ended = ready
            && !snapshot.playing
            && snapshot
                .duration
                .is_some_and(|duration| snapshot.current >= duration - END_SLACK_SECONDS);
        if snapshot != self.state || ended != self.ended {
            changed = true;
        }
        self.state = snapshot;
        self.ended = ended;
        if changed {
            cx.notify();
        }
        if !self.visible {
            IDLE_POLL
        } else if snapshot.playing || !ready || self.scrubbing || self.frame.is_none() {
            ACTIVE_POLL
        } else {
            IDLE_POLL
        }
    }

    fn toggle(&mut self, cx: &mut Context<'_, Self>) {
        let Some(player) = &self.player else {
            return;
        };
        let playing = if self.ended {
            player.seek(0.0);
            player.play();
            self.state.current = 0.0;
            true
        } else if self.state.playing {
            player.pause();
            false
        } else {
            player.play();
            true
        };
        // Show the new state at once; the next poll corrects it.
        self.state.playing = playing;
        self.ended = false;
        cx.notify();
    }

    fn toggle_mute(&mut self, cx: &mut Context<'_, Self>) {
        let Some(player) = &self.player else {
            return;
        };
        player.set_muted(!self.state.muted);
        self.state.muted = !self.state.muted;
        cx.notify();
    }

    fn on_slider(&mut self, event: &SliderEvent, cx: &mut Context<'_, Self>) {
        let (value, released) = match event {
            SliderEvent::Change(value) => (value.end(), false),
            SliderEvent::Release(value) => (value.end(), true),
        };
        self.scrubbing = !released;
        let (Some(player), Some(duration)) = (&self.player, self.state.duration) else {
            return;
        };
        let target = f64::from((value / SLIDER_STEPS).clamp(0.0, 1.0)) * duration;
        player.seek(target);
        self.state.current = target;
        self.ended = false;
        cx.notify();
    }
}

impl Render for NativeVideo {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        // Keep the seek slider on the playhead, except while the reader holds it.
        if !self.scrubbing
            && let Some(duration) = self.state.duration
        {
            let at =
                ((self.state.current / duration) as f32 * SLIDER_STEPS).clamp(0.0, SLIDER_STEPS);
            let slider = self.slider.clone();
            if (slider.read(cx).value().end() - at).abs() > 0.5 {
                slider.update(cx, |slider, cx| slider.set_value(at, window, cx));
            }
        }

        let ax = self.ax_id.clone();
        let white = hsla(Rgba::new(1.0, 1.0, 1.0, 0.92));
        let dim = hsla(Rgba::new(1.0, 1.0, 1.0, 0.7));
        let bar_bg = hsla(Rgba::new(0.0, 0.0, 0.0, 0.55));
        let hover = hsla(Rgba::new(1.0, 1.0, 1.0, 0.16));

        let (play_icon, play_label) = if self.ended {
            (REPLAY, "Replay")
        } else if self.state.playing {
            (PAUSE, "Pause")
        } else {
            (PLAY, "Play")
        };

        let frame = self.frame.clone();
        let picture = canvas(
            |bounds, _, _| bounds,
            move |bounds, _, window, _cx| {
                if let Some(frame) = frame {
                    let (width, height) = (
                        CVPixelBufferGetWidth(&frame) as f32,
                        CVPixelBufferGetHeight(&frame) as f32,
                    );
                    window.paint_surface(fit(bounds, width, height), frame);
                }
            },
        )
        .size_full();

        let duration = self.state.duration;
        let time = format!(
            "{} / {}",
            format_time(self.state.current),
            duration.map_or_else(|| "--:--".to_owned(), format_time)
        );

        let controls = div()
            .id(format!("{ax}.controls"))
            .a11y_group(format!("{ax}.controls"), "Video controls")
            .occlude()
            .absolute()
            .left_0()
            .right_0()
            .bottom_0()
            .h(px(BAR_HEIGHT_PX))
            .px(px(8.0))
            .flex()
            .items_center()
            .gap(px(8.0))
            .bg(bar_bg)
            .child(
                icon_button(format!("{ax}.play"), play_label, play_icon, white)
                    .hover(move |style| style.bg(hover))
                    .on_click(cx.listener(|this, _, _, cx| this.toggle(cx))),
            )
            .child(
                div()
                    .flex_none()
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(dim)
                    .child(time),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(Slider::new(&self.slider).accessibility_label("Seek")),
            )
            .child(
                icon_button(
                    format!("{ax}.mute"),
                    if self.state.muted { "Unmute" } else { "Mute" },
                    if self.state.muted { MUTED } else { SPEAKER },
                    white,
                )
                .hover(move |style| style.bg(hover))
                .on_click(cx.listener(|this, _, _, cx| this.toggle_mute(cx))),
            );

        let loading = self.frame.is_none().then(|| {
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(dim)
                .child("Loading video…")
        });

        div()
            .id(ax.clone())
            .a11y_group(ax.clone(), "Video")
            .relative()
            .size_full()
            .overflow_hidden()
            .bg(hsla(Rgba::new(0.0, 0.0, 0.0, 1.0)))
            .child(
                div()
                    .id(format!("{ax}.picture"))
                    .absolute()
                    .inset_0()
                    .cursor_pointer()
                    .on_click(cx.listener(|this, _, _, cx| this.toggle(cx)))
                    .child(picture),
            )
            .children(loading)
            .child(controls)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_format_as_players_do() {
        assert_eq!(format_time(0.0), "0:00", "zero");
        assert_eq!(format_time(65.9), "1:05", "seconds truncate");
        assert_eq!(format_time(3725.0), "1:02:05", "hours");
        assert_eq!(format_time(f64::NAN), "0:00", "NaN is zero");
        assert_eq!(format_time(-4.0), "0:00", "negative is zero");
    }

    #[test]
    fn pictures_fit_and_centre_in_the_box() {
        let bounds = Bounds::new(point(px(10.0), px(20.0)), size(px(400.0), px(200.0)));
        let wide = fit(bounds, 1920.0, 1080.0);
        assert!(
            (f32::from(wide.size.height) - 200.0).abs() < 0.01,
            "height-bound"
        );
        assert!(
            (f32::from(wide.size.width) - 355.555_56).abs() < 0.01,
            "16:9 width"
        );
        assert!(
            (f32::from(wide.origin.x) - (10.0 + (400.0 - 355.555_56) / 2.0)).abs() < 0.01,
            "centred across",
        );
        let tall = fit(bounds, 100.0, 400.0);
        assert_eq!(f32::from(tall.size.height), 200.0, "tall fits the height");
        assert_eq!(
            fit(bounds, 0.0, 0.0),
            bounds,
            "an unknown size fills the box"
        );
    }
}
