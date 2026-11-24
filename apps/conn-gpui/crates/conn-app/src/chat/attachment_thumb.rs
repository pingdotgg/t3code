//! Image attachment thumbnails: the composer chip and sent user messages.
//!
//! Web Conn shows the image itself (`ComposerAttachmentStrip.tsx`, `TimelineUserMessageRow.tsx`:
//! `object-cover` in a rounded, bordered cell). A staged file already has its bytes; a sent
//! message holds only the attachment id, so [`AttachmentImageState`] downloads it through
//! `assets.createUrl` and a signed `GET` (`Connection::fetch_attachment_bytes`).

use std::sync::Arc;

use conn_client::Connection;
use conn_theme::Tokens;
use gpui_kit::{
    AnyElement, App, ClickEvent, Context, Image, ImageFormat, ImageSource, InteractiveElement as _,
    IntoElement as _, ObjectFit, ParentElement as _, SharedString, StatefulInteractiveElement as _,
    Styled as _, StyledImage as _, Window, div, img, px,
};

use super::icons;
use crate::a11y::ConnA11yExt as _;
use crate::theme::{hsla, hsla_alpha};

/// The GPUI image format for an attachment MIME type; `None` when GPUI cannot decode it.
pub(super) fn image_format_for_mime(mime_type: &str) -> Option<ImageFormat> {
    match mime_type.to_ascii_lowercase().as_str() {
        "image/png" => Some(ImageFormat::Png),
        "image/jpeg" | "image/jpg" => Some(ImageFormat::Jpeg),
        "image/webp" => Some(ImageFormat::Webp),
        "image/gif" => Some(ImageFormat::Gif),
        "image/bmp" => Some(ImageFormat::Bmp),
        "image/tiff" => Some(ImageFormat::Tiff),
        "image/svg+xml" => Some(ImageFormat::Svg),
        _ => None,
    }
}

/// An image GPUI can paint from `bytes`, or `None` for a non-image or unsupported type.
pub(super) fn preview_image(mime_type: &str, bytes: Vec<u8>) -> Option<Arc<Image>> {
    let format = image_format_for_mime(mime_type)?;
    Some(Arc::new(Image::from_bytes(format, bytes)))
}

/// Width over height of an image, from the header of `bytes` (no pixel decode). `None` when
/// the format is not one the `image` crate reads (SVG, BMP, TIFF) or the header is bad.
pub(super) fn image_aspect_ratio(bytes: &[u8]) -> Option<f32> {
    let (width, height) = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()?;
    aspect_ratio(width, height)
}

/// Width over height, or `None` for a zero side.
fn aspect_ratio(width: u32, height: u32) -> Option<f32> {
    (width > 0 && height > 0).then(|| width as f32 / height as f32)
}

/// The height of a box `width` wide that holds a picture of `aspect` (width over height)
/// without bands. An unknown ratio gets the 4:3 loading box.
#[cfg(test)]
fn box_height(width: f32, aspect: Option<f32>) -> f32 {
    width / aspect.unwrap_or(LOADING_ASPECT)
}

/// The box of a single image until its own ratio is known.
const LOADING_ASPECT: f32 = 4.0 / 3.0;

/// Where one downloaded attachment image stands.
#[derive(Clone)]
pub(super) enum AttachmentImageLoad {
    Loading,
    /// The picture and its width over height, when the header told.
    Ready(Arc<Image>, Option<f32>),
    Failed,
}

/// Holds the download of one attachment image. The chat observes it and repaints when it ends.
pub(super) struct AttachmentImageState {
    pub(super) load: AttachmentImageLoad,
}

impl AttachmentImageState {
    pub(super) fn fetch(
        connection: Connection,
        attachment_id: String,
        mime_type: String,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        cx.spawn(async move |this, cx| {
            let result = connection.fetch_attachment_bytes(&attachment_id).await;
            let load = match result {
                Ok(bytes) => {
                    let aspect = image_aspect_ratio(&bytes);
                    preview_image(&mime_type, bytes).map_or(AttachmentImageLoad::Failed, |image| {
                        AttachmentImageLoad::Ready(image, aspect)
                    })
                }
                Err(_) => AttachmentImageLoad::Failed,
            };
            let _ = this.update(cx, |state, cx| {
                state.load = load;
                cx.notify();
            });
        })
        .detach();
        Self {
            load: AttachmentImageLoad::Loading,
        }
    }
}

/// How a thumbnail sizes itself inside its parent.
#[derive(Clone, Copy)]
pub(super) enum ThumbFit {
    /// Fills a fixed-size parent, cropped (`object-cover`).
    Cover,
    /// Takes the parent's full width; the height follows the picture's own width over height
    /// (Nick, #343, #345). `None` until the ratio is known.
    FullWidth(Option<f32>),
}

/// `image` in its parent, or the muted image icon while there is none. The picture paints its
/// own `radius`: GPUI's `overflow_hidden` clips to the rectangle, not to rounded corners (#342).
/// The parent sets border and `overflow_hidden`, and the size for [`ThumbFit::Cover`].
pub(super) fn thumbnail(
    image: Option<Arc<Image>>,
    tokens: &Tokens,
    radius: f32,
    fit: ThumbFit,
) -> AnyElement {
    let muted = hsla(tokens.muted_foreground);
    let placeholder = move || {
        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .child(icons::icon(icons::IMAGE, 16.0, muted))
            .into_any_element()
    };
    match (image, fit) {
        (Some(image), ThumbFit::Cover) => img(ImageSource::Image(image))
            .size_full()
            .rounded(px(radius))
            .object_fit(ObjectFit::Cover)
            .with_fallback(placeholder)
            .into_any_element(),
        // GPUI's `img` with a percent width takes the picture's natural height, not the scaled
        // one, so `Contain` left bands above and below (#345). A box with the ratio sets the
        // height from the width; the picture fills it.
        (Some(image), ThumbFit::FullWidth(Some(aspect))) => div()
            .w_full()
            .aspect_ratio(aspect)
            .child(
                img(ImageSource::Image(image))
                    .size_full()
                    .rounded(px(radius))
                    .object_fit(ObjectFit::Contain)
                    .with_fallback(placeholder),
            )
            .into_any_element(),
        // A format whose size we cannot read: the picture's own layout.
        (Some(image), ThumbFit::FullWidth(None)) => img(ImageSource::Image(image))
            .w_full()
            .rounded(px(radius))
            .object_fit(ObjectFit::Contain)
            .with_fallback(placeholder)
            .into_any_element(),
        (None, ThumbFit::Cover) => div()
            .size_full()
            .rounded(px(radius))
            .bg(hsla_alpha(tokens.muted, 0.60))
            .child(placeholder())
            .into_any_element(),
        // Loading: a 4:3 box at full width until the picture's own ratio is known.
        (None, ThumbFit::FullWidth(_)) => div()
            .w_full()
            .aspect_ratio(LOADING_ASPECT)
            .rounded(px(radius))
            .bg(hsla_alpha(tokens.muted, 0.60))
            .child(placeholder())
            .into_any_element(),
    }
}

/// A staged image in the composer strip (`ComposerAttachmentStrip.tsx`): a `64px` square,
/// `rounded-lg`, `border-border/80`, `object-cover`, with the remove button on its corner.
pub(super) fn staged_image_chip(
    local_id: u64,
    name: &str,
    image: Arc<Image>,
    uploading: bool,
    failed: bool,
    tokens: &Tokens,
    on_remove: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let muted = hsla(tokens.muted_foreground);
    let scrim = hsla_alpha(tokens.background, 0.85);
    let mut chip = div()
        .id(SharedString::from(format!("composer-att-{local_id}")))
        .a11y_group(
            format!("composer.attachment.{local_id}"),
            format!("Attachment {name}"),
        )
        .relative()
        .flex_none()
        .size(px(64.0))
        .overflow_hidden()
        .rounded(px(8.0))
        .border_1()
        .border_color(if failed {
            hsla(tokens.destructive)
        } else {
            hsla_alpha(tokens.border, 0.80)
        })
        // 8px outer radius, so the picture inside the 1px border takes 7px.
        .child(thumbnail(Some(image), tokens, 7.0, ThumbFit::Cover));
    if uploading || failed {
        chip = chip.child(
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .bg(hsla_alpha(tokens.background, 0.55))
                .text_size(px(11.0))
                .text_color(if failed {
                    hsla(tokens.destructive)
                } else {
                    muted
                })
                .child(if failed { "Failed" } else { "Uploading…" }),
        );
    }
    chip.child(
        div()
            .id(SharedString::from(format!("composer-att-rm-{local_id}")))
            .a11y_button(
                SharedString::from(format!("composer.att.rm.{local_id}")),
                "Remove attachment",
            )
            .absolute()
            .top(px(4.0))
            .right(px(4.0))
            .flex()
            .items_center()
            .justify_center()
            .size(px(16.0))
            .rounded(px(4.0))
            .bg(scrim)
            .cursor_pointer()
            .on_click(on_remove)
            .child(icons::icon("superhero/close.svg", 11.0, muted)),
    )
    .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_types_map_to_gpui_formats() {
        assert_eq!(image_format_for_mime("image/png"), Some(ImageFormat::Png));
        assert_eq!(image_format_for_mime("IMAGE/JPG"), Some(ImageFormat::Jpeg));
        assert_eq!(image_format_for_mime("image/webp"), Some(ImageFormat::Webp));
        assert_eq!(image_format_for_mime("application/pdf"), None);
        assert!(preview_image("text/plain", vec![1, 2, 3]).is_none());
        assert!(preview_image("image/png", vec![1, 2, 3]).is_some());
    }

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        image::DynamicImage::new_rgb8(width, height)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .expect("encode png");
        bytes
    }

    #[test]
    fn landscape_box_is_short() {
        // The #345 screenshot, 848x358: 500px wide gives about 211px, not a 4:3 box.
        let aspect = image_aspect_ratio(&png(848, 358));
        assert!((box_height(500.0, aspect) - 500.0 * 358.0 / 848.0).abs() < 0.01);
        assert!(box_height(500.0, aspect) < 500.0 * 3.0 / 4.0);
    }

    #[test]
    fn portrait_box_is_tall() {
        let aspect = image_aspect_ratio(&png(300, 600));
        assert!((box_height(400.0, aspect) - 800.0).abs() < 0.01);
    }

    #[test]
    fn unknown_size_keeps_the_loading_box() {
        assert_eq!(image_aspect_ratio(&[1, 2, 3]), None);
        assert_eq!(aspect_ratio(0, 10), None);
        assert_eq!(aspect_ratio(10, 0), None);
        assert!((box_height(400.0, None) - 300.0).abs() < 1e-3);
    }
}
