//! A workspace's badge image: an uploaded picture cropped to a centred square and kept as a
//! 96px PNG data URL (`workspaceImageFromFile` in `apps/web/src/lib/workspaceImage.ts`), small
//! enough for the Orbit profile (`WORKSPACE_IMAGE_MAX_CHARS`).

use std::path::Path;
use std::sync::Arc;

use gpui_kit::{Image, ImageFormat};

/// `WORKSPACE_IMAGE_SIZE`: the badge is 30px (36px in the editor); 96px stays sharp at 3x.
const WORKSPACE_IMAGE_SIZE: u32 = 96;

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn encode_base64(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if i <= chunk.len() {
                out.push(char::from(ALPHABET[((n >> shift) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn decode_base64(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buffer = 0_u32;
    let mut bits = 0_u32;
    for c in input.trim_end_matches('=').bytes() {
        let value = ALPHABET.iter().position(|a| *a == c)?;
        buffer = (buffer << 6) | u32::try_from(value).ok()?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((buffer >> bits) & 0xff).ok()?);
        }
    }
    Some(out)
}

/// Reads an image file, crops it to a centred square and returns a 96px PNG data URL.
///
/// # Errors
/// Returns the sentence the editor shows: the file is not an image, or too large to keep.
pub(crate) fn data_url_from_file(path: &Path) -> Result<String, String> {
    let image = image::open(path).map_err(|_| "That image can't be read.".to_owned())?;
    data_url_from_image(&image)
}

pub(crate) fn data_url_from_image(image: &image::DynamicImage) -> Result<String, String> {
    let side = image.width().min(image.height());
    if side == 0 {
        return Err("That image can't be read.".to_owned());
    }
    let square = image.crop_imm(
        (image.width() - side) / 2,
        (image.height() - side) / 2,
        side,
        side,
    );
    let badge = square.resize_exact(
        WORKSPACE_IMAGE_SIZE,
        WORKSPACE_IMAGE_SIZE,
        image::imageops::FilterType::Lanczos3,
    );
    let mut png = std::io::Cursor::new(Vec::new());
    badge
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|_| "That image can't be read.".to_owned())?;
    let url = format!("data:image/png;base64,{}", encode_base64(png.get_ref()));
    if conn_desktop::orbit::workspace_editor::is_workspace_image(&url) {
        Ok(url)
    } else {
        Err("That image can't be used.".to_owned())
    }
}

/// The image GPUI paints for a stored data URL, or `None` for one it cannot read.
#[must_use]
pub(crate) fn image_of_data_url(url: &str) -> Option<Arc<Image>> {
    let (format, body) = if let Some(rest) = url.strip_prefix("data:image/png;base64,") {
        (ImageFormat::Png, rest)
    } else if let Some(rest) = url.strip_prefix("data:image/jpeg;base64,") {
        (ImageFormat::Jpeg, rest)
    } else {
        (
            ImageFormat::Webp,
            url.strip_prefix("data:image/webp;base64,")?,
        )
    };
    Some(Arc::new(Image::from_bytes(format, decode_base64(body)?)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips_every_remainder() {
        for len in 0..9 {
            let bytes: Vec<u8> = (0..len)
                .map(|i| u8::try_from(i * 37 % 251).unwrap_or(0))
                .collect();
            let text = encode_base64(&bytes);
            assert_eq!(decode_base64(&text).expect("decodes"), bytes, "{len} bytes");
        }
        assert_eq!(encode_base64(b"Man"), "TWFu");
        assert_eq!(encode_base64(b"Ma"), "TWE=");
        assert!(decode_base64("not base64!").is_none());
    }

    #[test]
    fn a_wide_picture_becomes_a_small_square_png_the_workspace_may_keep() {
        let wide = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            400,
            200,
            image::Rgba([200, 30, 30, 255]),
        ));
        let url = data_url_from_image(&wide).expect("a data url");
        assert!(url.starts_with("data:image/png;base64,"));
        assert!(conn_desktop::orbit::workspace_editor::is_workspace_image(
            &url
        ));
        let back =
            decode_base64(url.trim_start_matches("data:image/png;base64,")).expect("decodes");
        let read = image::load_from_memory(&back).expect("a png");
        assert_eq!((read.width(), read.height()), (96, 96));
        assert!(image_of_data_url(&url).is_some());
    }

    #[test]
    fn a_stored_value_that_is_not_an_image_paints_nothing() {
        assert!(image_of_data_url("https://example.com/x.png").is_none());
        assert!(image_of_data_url("data:image/png;base64,@@@").is_none());
    }
}
