//! Image attachment thumbnails: the composer chip and sent user messages.
//!
//! Web Conn shows the image itself (`ComposerAttachmentStrip.tsx`, `TimelineUserMessageRow.tsx`:
//! `object-cover` in a rounded, bordered cell). A staged file already has its bytes; a sent
//! message holds only the attachment id, so the chat downloads it through `assets.createUrl`
//! and a signed `GET` (`Connection::fetch_attachment_bytes_within`) and keeps a thumbnail decoded at
//! tile size ([`super::thumb_cache`]).

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use conn_theme::Tokens;
use gpui_kit::{
    AnyElement, App, ClickEvent, Image, ImageFormat, ImageSource, InteractiveElement as _,
    IntoElement as _, ObjectFit, ParentElement as _, RenderImage, SharedString,
    StatefulInteractiveElement as _, Styled as _, StyledImage as _, SvgRenderer, Window, div, img,
    px,
};

use super::icons;
use super::thumb_cache::{TargetPx, grid_tile_px, thumbnail_for};
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
#[cfg(test)]
pub(super) fn image_aspect_ratio(bytes: &[u8]) -> Option<f32> {
    let (width, height) = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()?;
    aspect_ratio(width, height)
}

/// Width over height, or `None` for a zero side.
#[cfg(test)]
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

/// A sent image in the chat's thumbnail cache.
pub(super) enum SentImage {
    /// The download or decode with this request number is waiting or running.
    Loading(u64),
    /// Pixels decoded at tile size, and the picture's width over height.
    Ready(Arc<RenderImage>, Option<f32>),
    Failed,
}

impl SentImage {
    /// What to paint, once there is something.
    pub(super) fn source(&self) -> Option<(ImageSource, Option<f32>)> {
        match self {
            Self::Ready(image, aspect) => Some((ImageSource::Render(image.clone()), *aspect)),
            Self::Loading(_) | Self::Failed => None,
        }
    }

    /// Frees the window textures once the cache let this go. Deferred, so a window that is
    /// painting right now is back in the app and loses its texture too.
    pub(super) fn release(self, cx: &mut App) {
        if let Self::Ready(image, _) = self {
            cx.defer(move |cx| cx.drop_image(image, None));
        }
    }
}

/// One thumbnail load: what to download.
pub(super) struct ThumbJob {
    pub(super) attachment_id: String,
    pub(super) mime_type: String,
}

/// Turns downloaded `bytes` into a still thumbnail entry and its cost in decoded bytes
/// ([`thumbnail_for`]): only SVG, BMP and TIFF go through GPUI's own decoder, then the same
/// crop and scale, so every entry is a texture the chat owns and frees.
/// Stops early once `cancel` is set. Slow: run it off the UI thread.
pub(super) fn load_sent_image(
    mime_type: &str,
    bytes: Vec<u8>,
    target: TargetPx,
    svg_renderer: SvgRenderer,
    cancel: &AtomicBool,
) -> (SentImage, usize) {
    let thumb = thumbnail_for(mime_type, bytes, target, cancel, |bytes| {
        let format = image_format_for_mime(mime_type)?;
        let decoded = Image::from_bytes(format, bytes)
            .to_image_data(svg_renderer)
            .ok()?;
        let size = decoded.size(0);
        image::RgbaImage::from_raw(
            u32::try_from(size.width.0).ok()?,
            u32::try_from(size.height.0).ok()?,
            decoded.as_bytes(0)?.to_vec(),
        )
    });
    match thumb {
        Some(thumb) => {
            let cost = thumb.byte_len();
            let image = RenderImage::new(vec![image::Frame::new(thumb.pixels)]);
            (SentImage::Ready(Arc::new(image), thumb.aspect), cost)
        }
        None => (SentImage::Failed, 0),
    }
}

/// The widest a sent bubble gets: 80% of the capped chat column. Thumbnails decode for this
/// width, so resizing the window never decodes again.
const BUBBLE_MAX_PX: f32 = super::CHAT_CONTENT_MAX_WIDTH_PX * 0.8;

/// The pixel size to decode a gallery tile at, in a gallery of `columns` at `scale`.
pub(super) fn gallery_tile_target(columns: usize, scale: f32) -> TargetPx {
    let (width, height) = grid_tile_px(
        BUBBLE_MAX_PX,
        GALLERY_INSET_PX,
        columns,
        GALLERY_TILE_ASPECT,
    );
    TargetPx::from_logical(width, height, scale)
}

/// The pixel size to decode a queued or file bubble's image at: one image takes the bubble's
/// width, several take `cell` logical px each.
pub(super) fn chip_target(single: bool, cell: (f32, f32), scale: f32) -> TargetPx {
    if single {
        TargetPx::from_logical(BUBBLE_MAX_PX, 0.0, scale)
    } else {
        TargetPx::from_logical(cell.0, cell.1, scale)
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
    image: Option<ImageSource>,
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
        (Some(image), ThumbFit::Cover) => img(image)
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
                img(image)
                    .size_full()
                    .rounded(px(radius))
                    .object_fit(ObjectFit::Contain)
                    .with_fallback(placeholder),
            )
            .into_any_element(),
        // A format whose size we cannot read: the picture's own layout.
        (Some(image), ThumbFit::FullWidth(None)) => img(image)
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

/// Gap between gallery tiles and the inset of the gallery inside a sent image bubble.
pub(super) const GALLERY_INSET_PX: f32 = 3.0;
/// Corner radius where two tiles meet or a tile meets an open cell.
const GALLERY_TILE_RADIUS_PX: f32 = 3.0;
/// Width over height of every gallery tile.
const GALLERY_TILE_ASPECT: f32 = 4.0 / 3.0;
const GALLERY_MAX_COLUMNS: usize = 4;

/// Columns of a sent image gallery: one per image, at most four.
pub(super) fn gallery_columns(image_count: usize) -> usize {
    image_count.clamp(1, GALLERY_MAX_COLUMNS)
}

/// The outside corner of the gallery: the bubble radius less the inset around the gallery.
fn gallery_outer_radius_px() -> f32 {
    super::BUBBLE_RADIUS_PX - GALLERY_INSET_PX
}

/// Corner radii of one gallery tile, in px.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct TileRadii {
    pub(super) top_left: f32,
    pub(super) top_right: f32,
    pub(super) bottom_right: f32,
    pub(super) bottom_left: f32,
}

/// Radii of tile `index` of `count` in a grid of `columns`. A tile on a corner of the gallery
/// takes the outer radius (web masks the grid with `overflow: hidden`); every other corner is
/// the small tile radius. A ragged last row leaves its right end open, so the tile above that
/// gap keeps the small radius at its bottom right.
pub(super) fn tile_radii(index: usize, count: usize, columns: usize) -> TileRadii {
    let outer = gallery_outer_radius_px();
    let row = index / columns;
    let column = index % columns;
    let last_row = count.div_ceil(columns).saturating_sub(1);
    let pick = |on_corner: bool| {
        if on_corner {
            outer
        } else {
            GALLERY_TILE_RADIUS_PX
        }
    };
    let (top, bottom) = (row == 0, row == last_row);
    let (left, right) = (column == 0, column == columns - 1);
    TileRadii {
        top_left: pick(top && left),
        top_right: pick(top && right),
        bottom_right: pick(bottom && right),
        bottom_left: pick(bottom && left),
    }
}

/// Splits `items` into runs of equal `kind`, keeping their order: `(kind, start..end)`.
pub(super) fn runs_by<T>(
    items: &[T],
    kind: impl Fn(&T) -> bool,
) -> Vec<(bool, std::ops::Range<usize>)> {
    let mut runs: Vec<(bool, std::ops::Range<usize>)> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let kind = kind(item);
        match runs.last_mut() {
            Some((last, range)) if *last == kind => range.end = index + 1,
            _ => runs.push((kind, index..index + 1)),
        }
    }
    runs
}

/// A 4:3 gallery tile that fills its grid cell: the picture centered and cropped to cover, with
/// `radii` on its visible corners. GPUI's `img` clips a cover-scaled picture to the element
/// bounds first and rounds that visible quad, so a portrait or landscape picture keeps its
/// round corners. The tile paints no border, and the picture is absolutely placed so its
/// natural size never feeds the grid row height.
pub(super) fn gallery_tile(
    image: Option<ImageSource>,
    tokens: &Tokens,
    radii: TileRadii,
) -> AnyElement {
    let muted = hsla(tokens.muted_foreground);
    let fill = hsla_alpha(tokens.muted, 0.60);
    let placeholder = move || {
        div()
            .size_full()
            .rounded_tl(px(radii.top_left))
            .rounded_tr(px(radii.top_right))
            .rounded_br(px(radii.bottom_right))
            .rounded_bl(px(radii.bottom_left))
            .bg(fill)
            .flex()
            .items_center()
            .justify_center()
            .child(icons::icon(icons::IMAGE, 16.0, muted))
            .into_any_element()
    };
    match image {
        Some(image) => img(image)
            .absolute()
            .inset_0()
            .size_full()
            .rounded_tl(px(radii.top_left))
            .rounded_tr(px(radii.top_right))
            .rounded_br(px(radii.bottom_right))
            .rounded_bl(px(radii.bottom_left))
            .object_fit(ObjectFit::Cover)
            .with_fallback(placeholder)
            .into_any_element(),
        None => div()
            .absolute()
            .inset_0()
            .child(placeholder())
            .into_any_element(),
    }
}

/// The 4:3 cell of a gallery tile; [`gallery_tile`] fills it.
pub(super) fn gallery_cell(
    id: impl Into<gpui_kit::ElementId>,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .relative()
        .min_w_0()
        .aspect_ratio(GALLERY_TILE_ASPECT)
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
        .child(thumbnail(
            Some(ImageSource::Image(image)),
            tokens,
            7.0,
            ThumbFit::Cover,
        ));
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
    fn gallery_has_one_column_per_image_up_to_four() {
        let columns: Vec<usize> = [0, 1, 2, 3, 4, 5, 9].map(gallery_columns).into();
        assert_eq!(columns, [1, 1, 2, 3, 4, 4, 4]);
    }

    #[test]
    fn only_gallery_corners_take_the_outer_radius() {
        let (outer, inner) = (11.0, 3.0);
        let radii = |top_left, top_right, bottom_right, bottom_left| TileRadii {
            top_left,
            top_right,
            bottom_right,
            bottom_left,
        };
        // (index, count): one tile, a full row, the middle of a row.
        assert_eq!(
            tile_radii(0, 1, gallery_columns(1)),
            radii(outer, outer, outer, outer)
        );
        assert_eq!(tile_radii(0, 2, 2), radii(outer, inner, inner, outer));
        assert_eq!(tile_radii(1, 3, 3), radii(inner, inner, inner, inner));
        assert_eq!(tile_radii(2, 3, 3), radii(inner, outer, outer, inner));
        // Five images: a full row of four, then one tile at the left. The open cells at the
        // bottom right leave the fourth tile's bottom right square.
        assert_eq!(tile_radii(0, 5, 4), radii(outer, inner, inner, inner));
        assert_eq!(tile_radii(3, 5, 4), radii(inner, outer, inner, inner));
        assert_eq!(tile_radii(4, 5, 4), radii(inner, inner, inner, outer));
        // Eight images fill two rows, so the last tile closes the bottom right.
        assert_eq!(tile_radii(7, 8, 4), radii(inner, inner, outer, inner));
        // Six images: the sixth tile sits under the second, away from every corner.
        assert_eq!(tile_radii(5, 6, 4), radii(inner, inner, inner, inner));
    }

    #[test]
    fn mixed_message_runs_share_one_column_count() {
        // image, file, image, image: three images make three columns for every run.
        let kinds = [true, false, true, true];
        let columns = gallery_columns(kinds.iter().filter(|kind| **kind).count());
        assert_eq!(columns, 3);
        let (outer, inner) = (11.0, 3.0);
        let radii = |top_left, top_right, bottom_right, bottom_left| TileRadii {
            top_left,
            top_right,
            bottom_right,
            bottom_left,
        };
        // A lone tile in a three-column grid is left aligned: its right edge is internal.
        assert_eq!(tile_radii(0, 1, columns), radii(outer, inner, inner, outer));
        // The two-tile run starts at the left edge and ends one column short of the right.
        assert_eq!(tile_radii(0, 2, columns), radii(outer, inner, inner, outer));
        assert_eq!(tile_radii(1, 2, columns), radii(inner, inner, inner, inner));
    }

    #[test]
    fn attachments_keep_their_order_in_runs() {
        let kinds = [true, true, false, false, true];
        assert_eq!(
            runs_by(&kinds, |kind| *kind),
            [(true, 0..2), (false, 2..4), (true, 4..5)]
        );
        assert!(runs_by(&[] as &[bool], |kind| *kind).is_empty());
    }

    #[test]
    fn unknown_size_keeps_the_loading_box() {
        assert_eq!(image_aspect_ratio(&[1, 2, 3]), None);
        assert_eq!(aspect_ratio(0, 10), None);
        assert_eq!(aspect_ratio(10, 0), None);
        assert!((box_height(400.0, None) - 300.0).abs() < 1e-3);
    }
}
