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

/// Where one downloaded attachment image stands.
#[derive(Clone)]
pub(super) enum AttachmentImageLoad {
    Loading,
    Ready(Arc<Image>),
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
                Ok(bytes) => preview_image(&mime_type, bytes)
                    .map_or(AttachmentImageLoad::Failed, AttachmentImageLoad::Ready),
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

/// Fills its parent with `image` (`object-cover`), or the muted image icon while there is none.
/// The parent sets size, radius, border and `overflow_hidden`.
pub(super) fn thumbnail(image: Option<Arc<Image>>, tokens: &Tokens) -> AnyElement {
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
    match image {
        Some(image) => img(ImageSource::Image(image))
            .size_full()
            .object_fit(ObjectFit::Cover)
            .with_fallback(placeholder)
            .into_any_element(),
        None => div()
            .size_full()
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
        .child(thumbnail(Some(image), tokens));
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
}
