//! A sent video, played by Chromium inside the isolated surface.
//!
//! The page is a trusted wrapper with one `<video controls playsinline>` and no iframe. A video
//! element runs no script, so the page has nothing for an attacker to reach and gets no request
//! channel: it only reports `metadata` and `error` back. The signed URL is set by script after
//! the wrapper loads and is never traced or logged.
//!
//! Chromium's open-source build has no H.264, so the common MP4 ends in an `error`. On macOS the
//! card then plays the same signed URL with AVFoundation ([`NativeVideo`]), inline, in place of
//! the Chromium surface. Formats Chromium decodes never leave it.

use std::fmt;

use conn_client::Connection;
use conn_theme::{Rgba, Tokens};
use gpui_kit::prelude::*;
use gpui_kit::{
    Context, Entity, FontWeight, IntoElement, ParentElement, Render, Styled, Subscription, Task,
    Window, div, px,
};
use serde_json::Value;

#[cfg(target_os = "macos")]
use super::av_player::AvPlayer;
#[cfg(target_os = "macos")]
use super::native_video::{NativeVideo, NativeVideoEvent};
use super::view::{IsolatedSurface, SecretUrl, SurfaceEvent};
use crate::a11y::ConnA11yExt as _;
use crate::chat::color::hsla;

const UI_TEXT_PX: f32 = 13.0;
const UI_LINE_HEIGHT_PX: f32 = 20.0;

/// What the attachment record says about the video.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EmbeddedVideoFacts {
    pub(crate) attachment_id: String,
    pub(crate) name: String,
    pub(crate) mime_type: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum VideoState {
    /// Waiting for a connection or for the server to sign a URL.
    Minting,
    /// The page has the URL and is loading it.
    Loading,
    Ready,
    Failed(String),
}

/// One sent video. Size it from outside: the card fills its parent.
pub(crate) struct EmbeddedVideoCard {
    facts: EmbeddedVideoFacts,
    tokens: Tokens,
    connection: Option<Connection>,
    surface: Entity<IsolatedSurface>,
    _surface_events: Subscription,
    page_loaded: bool,
    src: Option<SecretUrl>,
    applied: bool,
    state: VideoState,
    /// Bumped by every mint, so an answer to an older one is dropped.
    generation: u64,
    mint_task: Option<Task<()>>,
    /// The AVFoundation player that took over from Chromium, once Chromium could not play it.
    #[cfg(target_os = "macos")]
    native: Option<Entity<NativeVideo>>,
    #[cfg(target_os = "macos")]
    _native_events: Option<Subscription>,
}

impl fmt::Debug for EmbeddedVideoCard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EmbeddedVideoCard")
            .field("attachment_id", &self.facts.attachment_id)
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

fn video_page(prefix: &str) -> String {
    let prefix = Value::String(prefix.to_owned()).to_string();
    format!(
        r#"<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src http: https: blob:">
<style>html,body{{margin:0;height:100%;overflow:hidden;background:#000}}video{{display:block;width:100%;height:100%;object-fit:contain;background:#000}}</style>
<video id="v" controls playsinline preload="metadata"></video>
<script>
(() => {{
  const prefix = {prefix};
  const video = document.getElementById("v");
  const send = (message) => console.log(prefix + JSON.stringify(message));
  video.addEventListener("loadedmetadata", () => send({{ t: "metadata", width: video.videoWidth, height: video.videoHeight }}));
  video.addEventListener("error", () => send({{ t: "error", code: video.error ? video.error.code : 0 }}));
  Object.defineProperty(window, "__connVideo", {{ value: Object.freeze({{
    load(src) {{
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.src = src;
      video.load();
    }},
    pause() {{ video.pause(); }},
  }}) }});
}})();
</script>"#
    )
}

/// Whether a message is a `metadata` line with a real picture size. Audio-only media reports 0.
fn is_picture_metadata(message: &Value) -> bool {
    let Some(object) = message.as_object() else {
        return false;
    };
    let dimension = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_u64)
            .is_some_and(|value| (1..=100_000).contains(&value))
    };
    object.get("t").and_then(Value::as_str) == Some("metadata")
        && dimension("width")
        && dimension("height")
}

fn is_error(message: &Value) -> bool {
    message.get("t").and_then(Value::as_str) == Some("error")
}

impl EmbeddedVideoCard {
    pub(crate) fn new(
        facts: EmbeddedVideoFacts,
        tokens: Tokens,
        connection: Option<Connection>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let surface_tokens = tokens.clone();
        let ax_id = format!("chat.video.{}.page", facts.attachment_id);
        let surface = cx
            .new(|cx| IsolatedSurface::new(video_page, ax_id, "Video", surface_tokens, window, cx));
        let subscription = cx.subscribe(&surface, |this, _surface, event: &SurfaceEvent, cx| {
            this.on_surface_event(event, cx);
        });
        let mut card = Self {
            facts,
            tokens,
            connection,
            surface,
            _surface_events: subscription,
            page_loaded: false,
            src: None,
            applied: false,
            state: VideoState::Minting,
            generation: 0,
            mint_task: None,
            #[cfg(target_os = "macos")]
            native: None,
            #[cfg(target_os = "macos")]
            _native_events: None,
        };
        card.start_mint(cx);
        card
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.surface
            .update(cx, |surface, cx| surface.set_tokens(tokens.clone(), cx));
        self.tokens = tokens;
        cx.notify();
    }

    /// A hidden video stops painting and pauses.
    pub(crate) fn set_visible(&mut self, visible: bool, cx: &mut Context<'_, Self>) {
        #[cfg(target_os = "macos")]
        {
            if let Some(native) = &self.native {
                native.update(cx, |native, cx| native.set_visible(visible, cx));
                return;
            }
        }
        let applied = self.applied;
        self.surface.update(cx, |surface, cx| {
            if !visible && applied {
                surface.run_js("__connVideo.pause()");
            }
            surface.set_visible(visible, cx);
        });
    }

    fn start_mint(&mut self, cx: &mut Context<'_, Self>) {
        self.state = VideoState::Minting;
        let Some(connection) = self.connection.clone() else {
            return;
        };
        self.generation += 1;
        let generation = self.generation;
        let (id, name, mime) = (
            self.facts.attachment_id.clone(),
            self.facts.name.clone(),
            self.facts.mime_type.clone(),
        );
        self.mint_task = Some(cx.spawn(async move |this, cx| {
            let minted = connection.attachment_video_url(&id, &name, &mime).await;
            let outcome = minted
                .map(|url| url.to_string())
                .map_err(|err| err.to_string());
            let _ = this.update(cx, |card, cx| card.finish_mint(generation, outcome, cx));
        }));
    }

    fn finish_mint(
        &mut self,
        generation: u64,
        outcome: Result<String, String>,
        cx: &mut Context<'_, Self>,
    ) {
        if generation != self.generation {
            return;
        }
        match outcome {
            Ok(url) => {
                self.src = Some(SecretUrl(url));
                self.applied = false;
                self.state = VideoState::Loading;
                self.apply_src(cx);
            }
            Err(_) => self.state = VideoState::Failed("Unable to load the video.".to_owned()),
        }
        cx.notify();
    }

    /// Gives the wrapper the URL once both it and the URL exist.
    fn apply_src(&mut self, cx: &mut Context<'_, Self>) {
        if !self.page_loaded || self.applied {
            return;
        }
        let Some(src) = &self.src else {
            return;
        };
        let code = format!("__connVideo.load({})", Value::String(src.0.clone()));
        self.surface.update(cx, |surface, _| surface.run_js(&code));
        self.applied = true;
    }

    fn on_surface_event(&mut self, event: &SurfaceEvent, cx: &mut Context<'_, Self>) {
        match event {
            SurfaceEvent::PageLoaded => {
                // A fresh page holds nothing, so it needs the URL again.
                self.page_loaded = true;
                self.applied = false;
                self.apply_src(cx);
            }
            SurfaceEvent::Message(message) => {
                if is_picture_metadata(message) {
                    self.state = VideoState::Ready;
                    cx.notify();
                } else if is_error(message) {
                    // Chromium could not play it (most often H.264); macOS can.
                    if !self.start_native(cx) {
                        self.state = VideoState::Failed("This video can't be played.".to_owned());
                    }
                    cx.notify();
                }
            }
            SurfaceEvent::UserInput => {}
        }
    }

    /// Plays the signed URL with AVFoundation in place of Chromium. `false` when this platform
    /// has no such player, there is no URL yet, or the player would not open.
    #[cfg(target_os = "macos")]
    fn start_native(&mut self, cx: &mut Context<'_, Self>) -> bool {
        if self.native.is_some() {
            return true;
        }
        let Some(src) = &self.src else {
            return false;
        };
        let Ok(player) = AvPlayer::open(&src.0) else {
            return false;
        };
        let ax_id = format!("chat.video.{}.native", self.facts.attachment_id);
        let native = cx.new(|cx| NativeVideo::new(player, ax_id, cx));
        self._native_events = Some(cx.subscribe(
            &native,
            |this, _native, event: &NativeVideoEvent, cx| match event {
                NativeVideoEvent::Failed => this.on_native_failed(cx),
            },
        ));
        self.native = Some(native);
        // Chromium keeps its page but stops painting and playing.
        self.surface.update(cx, |surface, cx| {
            surface.run_js("__connVideo.pause()");
            surface.set_visible(false, cx);
        });
        self.state = VideoState::Ready;
        true
    }

    #[cfg(not(target_os = "macos"))]
    fn start_native(&mut self, _cx: &mut Context<'_, Self>) -> bool {
        false
    }

    #[cfg(target_os = "macos")]
    fn on_native_failed(&mut self, cx: &mut Context<'_, Self>) {
        self.native = None;
        self._native_events = None;
        self.state = VideoState::Failed("This video can't be played.".to_owned());
        cx.notify();
    }

    /// Starts over with a fresh signed URL and a fresh page.
    fn retry(&mut self, cx: &mut Context<'_, Self>) {
        #[cfg(target_os = "macos")]
        {
            if self.native.take().is_some() {
                self._native_events = None;
                self.surface
                    .update(cx, |surface, cx| surface.set_visible(true, cx));
            }
        }
        self.page_loaded = false;
        self.src = None;
        self.applied = false;
        self.surface.update(cx, |surface, _| surface.reload_page());
        self.start_mint(cx);
        cx.notify();
    }
}

impl Render for EmbeddedVideoCard {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let muted = hsla(self.tokens.muted_foreground);
        let foreground = hsla(self.tokens.foreground);
        let id = self.facts.attachment_id.clone();

        let overlay = match &self.state {
            VideoState::Ready => None,
            VideoState::Minting | VideoState::Loading => Some(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child("Loading video…"),
            ),
            VideoState::Failed(message) => Some(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .flex_col()
                    .gap(px(10.0))
                    .items_center()
                    .justify_center()
                    .bg(hsla(Rgba::new(0.0, 0.0, 0.0, 1.0)))
                    .child(
                        div()
                            .text_size(px(UI_TEXT_PX))
                            .line_height(px(UI_LINE_HEIGHT_PX))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(foreground)
                            .child(message.clone()),
                    )
                    .child(
                        div()
                            .id(format!("chat.video.{id}.retry"))
                            .a11y_button(
                                format!("chat.video.{id}.retry"),
                                "Retry loading the video",
                            )
                            .h(px(28.0))
                            .px(px(12.0))
                            .flex()
                            .items_center()
                            .rounded(px(9999.0))
                            .bg(hsla(self.tokens.shell_tile))
                            .border_1()
                            .border_color(hsla(self.tokens.shell_tile_border))
                            .text_size(px(UI_TEXT_PX))
                            .text_color(foreground)
                            .cursor_pointer()
                            .on_click(cx.listener(|this, _, _, cx| this.retry(cx)))
                            .child("Retry"),
                    ),
            ),
        };

        // Chromium's surface, or the AVFoundation player that took over from it.
        #[cfg(target_os = "macos")]
        let player = match &self.native {
            Some(native) => native.clone().into_any_element(),
            None => self.surface.clone().into_any_element(),
        };
        #[cfg(not(target_os = "macos"))]
        let player = self.surface.clone().into_any_element();

        div()
            .id(format!("chat.video.{id}"))
            .a11y_group(format!("chat.video.{id}"), "Video")
            .relative()
            .size_full()
            .overflow_hidden()
            .bg(hsla(Rgba::new(0.0, 0.0, 0.0, 1.0)))
            .child(player)
            .children(overlay)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn picture_metadata_needs_positive_integers() {
        assert!(
            is_picture_metadata(&json!({ "t": "metadata", "width": 1280, "height": 720 })),
            "a real size",
        );
        assert!(
            !is_picture_metadata(&json!({ "t": "metadata", "width": 0, "height": 720 })),
            "audio-only media reports 0",
        );
        assert!(
            !is_picture_metadata(&json!({ "t": "metadata", "width": 1e12, "height": 5 })),
            "an absurd size is refused",
        );
        assert!(
            !is_picture_metadata(&json!({ "t": "error", "width": 1, "height": 1 })),
            "only metadata lines count",
        );
    }

    #[test]
    fn the_page_holds_no_url_and_one_video() {
        let page = video_page("__CONN_DOC_x__:");
        assert!(
            page.contains("<video id=\"v\" controls playsinline"),
            "controls and playsinline"
        );
        assert!(
            !page.contains("http://") && !page.contains("<iframe"),
            "no URL, no iframe"
        );
        assert!(
            page.contains("\"__CONN_DOC_x__:\""),
            "the prefix is a JSON string"
        );
    }

    #[test]
    fn secret_urls_do_not_print() {
        assert_eq!(
            format!("{:?}", SecretUrl("http://h/x?sig=1".to_owned())),
            "SecretUrl(..)",
            "debug hides the url",
        );
    }
}
