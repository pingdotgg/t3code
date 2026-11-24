//! Sent image thumbnails without GPUI: the pixel size to decode at, the crop and downscale, a
//! byte-bounded LRU, and the queue that limits loads running at once.
//!
//! GPUI decodes an `ImageSource::Image` once at full size and keeps the pixels until something
//! removes them, so twelve 4000×3000 photos held about 549 MiB. The chat paints only the pixels
//! a tile shows, decoded at tile size, and keeps them in [`ByteLru`].

use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::Hash;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};

use image::RgbaImage;

/// Decoded thumbnail pixels the chat keeps at most: about 15 full-width tiles at 2x. The rows
/// on screen plus the list's overdraw must fit, or visible tiles would evict each other.
pub(super) const THUMB_BUDGET_BYTES: usize = 64 * 1024 * 1024;

/// Pixels one entry may hold: a quarter of the budget, so four of the
/// largest entries fit at once and never push each other out.
pub(super) const ENTRY_MAX_BYTES: usize = THUMB_BUDGET_BYTES / 4;

/// Thumbnail loads (download and decode) that run at once. Each holds one downloaded file and
/// one full-size decode, so this bounds the memory spike when many images arrive together.
pub(super) const LOAD_CONCURRENCY: usize = 2;

/// How long a thumbnail load waits for the server: the signed-URL call, then the whole
/// download. Past them the load fails, so a stalled server never holds a permit for good.
pub(super) const LOAD_DEADLINES: conn_client::FetchDeadlines = conn_client::FetchDeadlines {
    rpc: std::time::Duration::from_secs(15),
    download: std::time::Duration::from_secs(30),
};

/// A size in device pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) struct TargetPx {
    pub(super) width: u32,
    pub(super) height: u32,
}

impl TargetPx {
    /// `width`×`height` logical px at `scale`, rounded up. A zero side leaves that side free.
    pub(super) fn from_logical(width: f32, height: f32, scale: f32) -> Self {
        let device = |side: f32| (side.max(0.0) * scale.max(1.0)).ceil() as u32;
        Self {
            width: device(width),
            height: device(height),
        }
    }
}

/// Logical width and height of one tile in a grid of `columns` equal `aspect` (width over
/// height) tiles, `gap` apart and inset `gap` from both sides of a `container` wide box.
pub(super) fn grid_tile_px(container: f32, gap: f32, columns: usize, aspect: f32) -> (f32, f32) {
    let columns = columns.max(1) as f32;
    let width = ((container - 2.0 * gap - (columns - 1.0) * gap) / columns).max(0.0);
    (width, width / aspect)
}

/// The centered part of a `width`×`height` picture that a cover crop into a box of `target`'s
/// shape shows, as `(x, y, width, height)`. A free side in `target` keeps the whole picture.
pub(super) fn visible_region(width: u32, height: u32, target: TargetPx) -> (u32, u32, u32, u32) {
    if target.width == 0 || target.height == 0 || width == 0 || height == 0 {
        return (0, 0, width, height);
    }
    let (w, h) = (u64::from(width), u64::from(height));
    let (tw, th) = (u64::from(target.width), u64::from(target.height));
    if w * th > h * tw {
        let crop = ((h * tw + th / 2) / th).clamp(1, w) as u32;
        ((width - crop) / 2, 0, crop, height)
    } else {
        let crop = ((w * th + tw / 2) / tw).clamp(1, h) as u32;
        (0, (height - crop) / 2, width, crop)
    }
}

/// The size to scale a `width`×`height` region to: just covering `target`, never up, and no
/// more than `max_bytes` of 4-byte pixels.
pub(super) fn scaled_size(
    width: u32,
    height: u32,
    target: TargetPx,
    max_bytes: usize,
) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (width, height);
    }
    let mut scale = (f64::from(target.width) / f64::from(width))
        .max(f64::from(target.height) / f64::from(height))
        .min(1.0);
    let bytes = f64::from(width) * f64::from(height) * 4.0 * scale * scale;
    let capped = bytes > max_bytes as f64;
    if capped {
        scale *= (max_bytes as f64 / bytes).sqrt();
    }
    // Round up to keep covering the target; round down under the cap to stay within it.
    let round = |side: f64| if capped { side.floor() } else { side.ceil() };
    let side = |length: u32| (round(f64::from(length) * scale) as u32).clamp(1, length);
    let (mut width, mut height) = (side(width), side(height));
    // Rounding up can pass the cap by a row; the final whole pixels must fit it.
    while width as usize * height as usize * 4 > max_bytes && (width > 1 || height > 1) {
        let shrink = (max_bytes as f64 / (f64::from(width) * f64::from(height) * 4.0)).sqrt();
        width = ((f64::from(width) * shrink).floor() as u32).max(1);
        height = ((f64::from(height) * shrink).floor() as u32).max(1);
    }
    (width, height)
}

/// Crops `frame` to what a `target` tile shows and scales it down to fit (channel order kept).
pub(super) fn fit_frame(frame: &RgbaImage, target: TargetPx, max_bytes: usize) -> RgbaImage {
    let (x, y, width, height) = visible_region(frame.width(), frame.height(), target);
    let (scaled_width, scaled_height) = scaled_size(width, height, target, max_bytes);
    let region = image::imageops::crop_imm(frame, x, y, width, height);
    if (scaled_width, scaled_height) == (width, height) {
        region.to_image()
    } else {
        image::imageops::resize(
            &*region,
            scaled_width,
            scaled_height,
            image::imageops::FilterType::Triangle,
        )
    }
}

/// A thumbnail in GPUI's `RenderImage` pixel order (BGRA, straight alpha, as GPUI's own
/// decode). Always a still: a GIF shows its first frame.
pub(super) struct Thumbnail {
    pub(super) pixels: RgbaImage,
    /// Width over height of the upright picture before the crop.
    pub(super) aspect: Option<f32>,
}

impl Thumbnail {
    /// Crops and scales an upright `picture` for `target`. `to_bgra` swaps RGBA input.
    pub(super) fn fit(picture: &RgbaImage, target: TargetPx, to_bgra: bool) -> Self {
        let (width, height) = picture.dimensions();
        let aspect = (width > 0 && height > 0).then(|| width as f32 / height as f32);
        let mut pixels = fit_frame(picture, target, ENTRY_MAX_BYTES);
        if to_bgra {
            for pixel in pixels.as_chunks_mut::<4>().0 {
                pixel.swap(0, 2);
            }
        }
        Self { pixels, aspect }
    }

    /// Decoded bytes: what GPUI keeps for it.
    pub(super) fn byte_len(&self) -> usize {
        self.pixels.as_raw().len()
    }
}

/// Decodes PNG, JPEG, WebP or the first frame of a GIF into a thumbnail for `target`, turning
/// the picture upright from its EXIF orientation as GPUI does. `None` for other formats, bad
/// data, or once `cancel` is set (checked between stages). Slow: call it off the UI thread.
pub(super) fn decode_thumbnail(
    bytes: &[u8],
    target: TargetPx,
    cancel: &AtomicBool,
) -> Option<Thumbnail> {
    use image::ImageDecoder as _;
    let cancelled = || cancel.load(Ordering::Relaxed);
    let reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let format = reader.format()?;
    if !matches!(
        format,
        image::ImageFormat::Png
            | image::ImageFormat::Jpeg
            | image::ImageFormat::WebP
            | image::ImageFormat::Gif
    ) || cancelled()
    {
        return None;
    }
    let mut decoder = reader.into_decoder().ok()?;
    let orientation = decoder.orientation().ok()?;
    let mut picture = image::DynamicImage::from_decoder(decoder).ok()?;
    if cancelled() {
        return None;
    }
    picture.apply_orientation(orientation);
    let picture = picture.into_rgba8();
    if cancelled() {
        return None;
    }
    Some(Thumbnail::fit(&picture, target, true))
}

/// A thumbnail for downloaded `bytes` of `mime_type`. PNG, JPEG, WebP and a GIF's first frame
/// decode here. Only SVG, BMP and TIFF, which this build of `image` cannot read, go to
/// `gpui_first_frame` (GPUI's own decoder, which decodes every frame of a GIF); anything else
/// that fails to decode is `None` and shows the missing-image tile.
pub(super) fn thumbnail_for(
    mime_type: &str,
    bytes: Vec<u8>,
    target: TargetPx,
    cancel: &AtomicBool,
    gpui_first_frame: impl FnOnce(Vec<u8>) -> Option<RgbaImage>,
) -> Option<Thumbnail> {
    if let Some(thumb) = decode_thumbnail(&bytes, target, cancel) {
        return Some(thumb);
    }
    let gpui_only = matches!(
        mime_type.to_ascii_lowercase().as_str(),
        "image/svg+xml" | "image/bmp" | "image/tiff"
    );
    if !gpui_only || cancel.load(Ordering::Relaxed) {
        return None;
    }
    let first = gpui_first_frame(bytes)?;
    (!cancel.load(Ordering::Relaxed)).then(|| Thumbnail::fit(&first, target, false))
}

/// A least-recently-used map whose entries cost bytes. Inserting past the budget evicts the
/// oldest costly entries, but never one drawn in this frame or the last ([`Self::get`] marks
/// it drawn): while more is on screen than the budget holds, the map runs over it, and
/// [`Self::begin_frame`] trims it back once those entries are no longer drawn. Free entries
/// (loads in flight, failures) are never evicted.
pub(super) struct ByteLru<K, V> {
    entries: HashMap<K, Slot<V>>,
    budget: usize,
    total: usize,
    clock: u64,
    frame: u64,
}

struct Slot<V> {
    value: V,
    cost: usize,
    used: u64,
    drawn: u64,
}

impl<K: Eq + Hash + Clone, V> ByteLru<K, V> {
    pub(super) fn new(budget: usize) -> Self {
        Self {
            entries: HashMap::new(),
            budget,
            total: 0,
            clock: 0,
            frame: 0,
        }
    }

    /// Starts a frame: entries not drawn in the frame just ended lose their pin, and the map
    /// trims back to its budget. Returns the values it pushed out.
    #[must_use]
    pub(super) fn begin_frame(&mut self) -> Vec<V> {
        self.frame += 1;
        self.evict_to_budget(None)
    }

    /// The entry under `key`, marked as used and drawn in this frame.
    pub(super) fn get(&mut self, key: &K) -> Option<&V> {
        self.clock += 1;
        let slot = self.entries.get_mut(key)?;
        slot.used = self.clock;
        slot.drawn = self.frame;
        Some(&slot.value)
    }

    pub(super) fn peek(&self, key: &K) -> Option<&V> {
        self.entries.get(key).map(|slot| &slot.value)
    }

    /// Puts `value` under `key` (replacing what was there), drawn in this frame, and returns
    /// the values it pushed out.
    #[must_use]
    pub(super) fn insert(&mut self, key: K, value: V, cost: usize) -> Vec<V> {
        self.clock += 1;
        let slot = Slot {
            value,
            cost,
            used: self.clock,
            drawn: self.frame,
        };
        let mut evicted = Vec::new();
        if let Some(old) = self.entries.insert(key.clone(), slot) {
            self.total -= old.cost;
            evicted.push(old.value);
        }
        self.total += cost;
        evicted.extend(self.evict_to_budget(Some(&key)));
        evicted
    }

    /// Evicts the least recently used costly entries that are not pinned (drawn in this frame
    /// or the last) and not `keep`, until the map fits its budget or nothing else may go.
    fn evict_to_budget(&mut self, keep: Option<&K>) -> Vec<V> {
        let mut evicted = Vec::new();
        while self.total > self.budget {
            let oldest = self
                .entries
                .iter()
                .filter(|(other, slot)| {
                    slot.cost > 0 && slot.drawn + 1 < self.frame && Some(*other) != keep
                })
                .min_by_key(|(_, slot)| slot.used)
                .map(|(other, _)| other.clone());
            let Some(oldest) = oldest else { break };
            if let Some(slot) = self.entries.remove(&oldest) {
                self.total -= slot.cost;
                evicted.push(slot.value);
            }
        }
        evicted
    }

    #[must_use]
    pub(super) fn remove(&mut self, key: &K) -> Option<V> {
        let slot = self.entries.remove(key)?;
        self.total -= slot.cost;
        Some(slot.value)
    }

    /// Empties the map and returns every value.
    #[must_use]
    pub(super) fn clear(&mut self) -> Vec<V> {
        self.total = 0;
        self.entries.drain().map(|(_, slot)| slot.value).collect()
    }

    #[cfg(test)]
    pub(super) fn total_bytes(&self) -> usize {
        self.total
    }
}

/// Thumbnail loads, by request id. At most `limit` hold a permit at once, and a load keeps
/// its permit until its download and decode have returned ([`Self::exited`]), even after it
/// was cancelled, so cancelled work never overlaps with more than `limit` loads. The rest wait
/// in order. A load whose tile was not drawn since the last [`Self::sweep`] is cancelled.
pub(super) struct LoadQueue<K, J> {
    limit: usize,
    permits: usize,
    running: HashMap<u64, K>,
    pending: VecDeque<(u64, K, J)>,
    seen: HashSet<K>,
}

impl<K: Eq + Hash + Clone, J> LoadQueue<K, J> {
    pub(super) fn new(limit: usize) -> Self {
        Self {
            limit: limit.max(1),
            permits: 0,
            running: HashMap::new(),
            pending: VecDeque::new(),
            seen: HashSet::new(),
        }
    }

    /// Asks to load `key` as request `id`. Returns the load when a permit is free and it
    /// should start now.
    #[must_use]
    pub(super) fn request(&mut self, id: u64, key: K, job: J) -> Option<(u64, K, J)> {
        self.seen.insert(key.clone());
        if self.permits < self.limit {
            self.permits += 1;
            self.running.insert(id, key.clone());
            Some((id, key, job))
        } else {
            self.pending.push_back((id, key, job));
            None
        }
    }

    /// Marks `key` as still drawn, so the next sweep keeps its load.
    pub(super) fn touch(&mut self, key: &K) {
        if !self.seen.contains(key) {
            self.seen.insert(key.clone());
        }
    }

    /// The work of started load `id` returned, cancelled or not: frees its permit and returns
    /// the loads that start now.
    #[must_use]
    pub(super) fn exited(&mut self, id: u64) -> Vec<(u64, K, J)> {
        self.running.remove(&id);
        self.permits = self.permits.saturating_sub(1);
        let mut started = Vec::new();
        while self.permits < self.limit {
            let Some((id, key, job)) = self.pending.pop_front() else {
                break;
            };
            self.permits += 1;
            self.running.insert(id, key.clone());
            started.push((id, key, job));
        }
        started
    }

    /// Cancels every load not drawn since the last sweep and returns them. A cancelled running
    /// load keeps its permit until it exits.
    #[must_use]
    pub(super) fn sweep(&mut self) -> Vec<(u64, K)> {
        let seen = std::mem::take(&mut self.seen);
        let mut cancelled = Vec::new();
        self.running.retain(|id, key| {
            let keep = seen.contains(key);
            if !keep {
                cancelled.push((*id, key.clone()));
            }
            keep
        });
        self.pending.retain(|(id, key, _)| {
            let keep = seen.contains(key);
            if !keep {
                cancelled.push((*id, key.clone()));
            }
            keep
        });
        cancelled
    }

    /// Forgets every load (reconnect) and returns the running ids to cancel. Their permits
    /// stay held until they exit.
    #[must_use]
    pub(super) fn clear(&mut self) -> Vec<u64> {
        self.pending.clear();
        self.seen.clear();
        self.running.drain().map(|(id, _)| id).collect()
    }

    #[cfg(test)]
    fn live_permits(&self) -> usize {
        self.permits
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHAT_BUBBLE_MAX_PX: f32 = 736.0 * 0.8;

    fn one_column_tile_at_2x() -> TargetPx {
        let (width, height) = grid_tile_px(CHAT_BUBBLE_MAX_PX, 3.0, 1, 4.0 / 3.0);
        TargetPx::from_logical(width, height, 2.0)
    }

    #[test]
    fn target_follows_tile_size_and_scale() {
        let one = grid_tile_px(CHAT_BUBBLE_MAX_PX, 3.0, 1, 4.0 / 3.0);
        let four = grid_tile_px(CHAT_BUBBLE_MAX_PX, 3.0, 4, 4.0 / 3.0);
        assert!((one.0 - (CHAT_BUBBLE_MAX_PX - 6.0)).abs() < 1e-3);
        assert!((one.1 - one.0 * 0.75).abs() < 1e-3);
        // Four columns: three 3px gutters and two 3px insets share the width.
        assert!((four.0 - (CHAT_BUBBLE_MAX_PX - 15.0) / 4.0).abs() < 1e-3);
        let at_1x = TargetPx::from_logical(four.0, four.1, 1.0);
        let at_2x = TargetPx::from_logical(four.0, four.1, 2.0);
        assert_eq!(at_1x.width, four.0.ceil() as u32);
        assert_eq!(at_2x.width, (four.0 * 2.0).ceil() as u32);
        assert_eq!(at_2x.height, (four.1 * 2.0).ceil() as u32);
        assert!(
            TargetPx::from_logical(four.0, four.1, 0.0).width == at_1x.width,
            "a scale below 1 decodes at 1x"
        );
    }

    #[test]
    fn visible_region_is_the_centered_cover_crop() {
        let tile = TargetPx {
            width: 400,
            height: 300,
        };
        // Tall: the middle 4:3 band. Wide: the middle 4:3 slice. Same shape: all of it.
        assert_eq!(visible_region(1080, 8000, tile), (0, 3595, 1080, 810));
        assert_eq!(visible_region(8000, 1000, tile), (3333, 0, 1333, 1000));
        assert_eq!(visible_region(800, 600, tile), (0, 0, 800, 600));
        // A free height (a full-width picture) keeps everything.
        let full_width = TargetPx {
            width: 400,
            height: 0,
        };
        assert_eq!(visible_region(1080, 8000, full_width), (0, 0, 1080, 8000));
    }

    #[test]
    fn scaled_size_covers_without_upscaling_and_caps_bytes() {
        let target = TargetPx {
            width: 286,
            height: 214,
        };
        assert_eq!(scaled_size(1333, 1000, target, usize::MAX), (286, 215));
        assert_eq!(scaled_size(100, 80, target, usize::MAX), (100, 80));
        let full_width = TargetPx {
            width: 1000,
            height: 0,
        };
        assert_eq!(scaled_size(4000, 3000, full_width, usize::MAX), (1000, 750));
        // A tall full-width screenshot scales down until it fits the byte cap.
        let (width, height) = scaled_size(1080, 8000, full_width, ENTRY_MAX_BYTES);
        assert!(width as usize * height as usize * 4 <= ENTRY_MAX_BYTES);
        assert!(((width as f32 / height as f32) - 1080.0 / 8000.0).abs() < 0.01);
    }

    #[test]
    fn tall_screenshots_cache_only_the_visible_tile() {
        // The re-check case: a 1080x8000 screenshot kept 33 MiB outside its 4:3 crop.
        let target = one_column_tile_at_2x();
        let fitted = fit_frame(&RgbaImage::new(1080, 8000), target, ENTRY_MAX_BYTES);
        let (width, height) = fitted.dimensions();
        assert_eq!(width, 1080, "narrower than the tile, so no upscale");
        assert!((width as f32 / height as f32 - 4.0 / 3.0).abs() < 0.01);
        let cost = fitted.as_raw().len();
        assert!(cost <= target.width as usize * target.height as usize * 4);
        // Two visible together fit the budget and never evict each other.
        let mut cache = ByteLru::new(THUMB_BUDGET_BYTES);
        assert!(cache.insert("a", (), cost).is_empty());
        assert!(cache.insert("b", (), cost).is_empty());
    }

    #[test]
    fn large_photos_stay_within_the_budget() {
        // The review case: 4000x3000 photos, one per row at 2x, the largest tile there is.
        let target = one_column_tile_at_2x();
        let (x, y, w, h) = visible_region(4000, 3000, target);
        assert!(
            x <= 1 && y == 0,
            "a 4:3 photo loses at most a rounding column"
        );
        let (w, h) = scaled_size(w, h, target, ENTRY_MAX_BYTES);
        let cost = w as usize * h as usize * 4;
        // Twelve of them held about 549 MiB at full size; as tiles they take under 50 MiB.
        assert!(cost * 12 < 50 * 1024 * 1024);
        let mut cache = ByteLru::new(THUMB_BUDGET_BYTES);
        let mut evicted = 0;
        // One photo per frame as they scroll past.
        for id in 0..40 {
            evicted += cache.begin_frame().len();
            evicted += cache.insert(id, (), cost).len();
            assert!(cache.total_bytes() <= THUMB_BUDGET_BYTES);
        }
        assert!(evicted > 0);
        assert!(cache.peek(&39).is_some(), "the newest stays");
        assert!(cache.peek(&0).is_none(), "the oldest went first");
    }

    #[test]
    fn rounding_never_passes_the_entry_cap() {
        // The re-check case: a 1199x3624 picture at full width and 2x rounded up past 16 MiB.
        let target = TargetPx::from_logical(CHAT_BUBBLE_MAX_PX, 0.0, 2.0);
        let (width, height) = scaled_size(1199, 3624, target, ENTRY_MAX_BYTES);
        assert!(width as usize * height as usize * 4 <= ENTRY_MAX_BYTES);
        assert!(width >= target.width - 2, "only the overshoot is taken off");
    }

    #[test]
    fn gif_thumbnails_are_the_first_frame_still() {
        let colors = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]];
        let frames =
            colors.map(|color| image::Frame::new(RgbaImage::from_pixel(8, 6, image::Rgba(color))));
        let mut bytes = Vec::new();
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
            encoder.encode_frames(frames).expect("encode gif");
        }
        let tile = TargetPx {
            width: 8,
            height: 6,
        };
        let thumb = decode_thumbnail(&bytes, tile, &AtomicBool::new(false)).expect("decodes");
        assert_eq!(thumb.pixels.dimensions(), (8, 6));
        assert_eq!(thumb.byte_len(), 8 * 6 * 4, "charged like any still");
        let first = thumb.pixels.get_pixel(4, 3).0;
        assert!(
            first[2] > 200 && first[0] < 60,
            "the red first frame: {first:?}"
        );
    }

    /// A 64x32 JPEG, red on the left and blue on the right, with EXIF orientation 6 (turn 90°
    /// clockwise to show it upright).
    fn rotated_jpeg() -> Vec<u8> {
        let picture = RgbaImage::from_fn(64, 32, |x, _| {
            if x < 32 {
                image::Rgba([255, 0, 0, 255])
            } else {
                image::Rgba([0, 0, 255, 255])
            }
        });
        let mut jpeg = Vec::new();
        image::DynamicImage::ImageRgba8(picture)
            .into_rgb8()
            .write_to(&mut Cursor::new(&mut jpeg), image::ImageFormat::Jpeg)
            .expect("encode jpeg");
        // Big-endian TIFF with one IFD entry: Orientation (0x0112), SHORT, 1, value 6.
        let tiff: [u8; 26] = [
            b'M', b'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0,
            0,
        ];
        let length = (2 + 6 + tiff.len()) as u16;
        let mut app1 = vec![0xFF, 0xE1];
        app1.extend_from_slice(&length.to_be_bytes());
        app1.extend_from_slice(b"Exif\0\0");
        app1.extend_from_slice(&tiff);
        jpeg.splice(2..2, app1);
        jpeg
    }

    #[test]
    fn decode_turns_the_picture_upright_in_bgra() {
        let free = TargetPx {
            width: 1000,
            height: 0,
        };
        let thumb =
            decode_thumbnail(&rotated_jpeg(), free, &AtomicBool::new(false)).expect("decodes");
        let pixels = &thumb.pixels;
        // Turned clockwise: 32 wide, 64 tall, the red left half now on top.
        assert_eq!(pixels.dimensions(), (32, 64));
        assert!((thumb.aspect.unwrap_or_default() - 0.5).abs() < 1e-4);
        // BGRA: red has its weight in byte 2, blue in byte 0.
        let red = pixels.get_pixel(16, 12).0;
        let blue = pixels.get_pixel(16, 52).0;
        assert!(red[2] > 200 && red[0] < 60, "top is red: {red:?}");
        assert!(blue[0] > 200 && blue[2] < 60, "bottom is blue: {blue:?}");
        assert!(decode_thumbnail(&[1, 2, 3], free, &AtomicBool::new(false)).is_none());
        // Cancelled work stops before decoding.
        assert!(decode_thumbnail(&rotated_jpeg(), free, &AtomicBool::new(true)).is_none());
    }

    #[test]
    fn lru_evicts_the_least_recently_used() {
        let mut cache = ByteLru::new(100);
        assert!(cache.insert("a", 1, 40).is_empty());
        assert!(cache.insert("b", 2, 40).is_empty());
        // Two frames on, neither is pinned; `a` is drawn again.
        assert!(cache.begin_frame().is_empty());
        assert!(cache.begin_frame().is_empty());
        assert_eq!(cache.get(&"a"), Some(&1));
        assert_eq!(
            cache.insert("c", 3, 40),
            vec![2],
            "b was used last longest ago"
        );
        assert_eq!(cache.total_bytes(), 80);
        // Replacing an entry hands back the old value and settles the total.
        assert_eq!(cache.insert("a", 4, 10), vec![1]);
        assert_eq!(cache.total_bytes(), 50);
        assert_eq!(cache.remove(&"a"), Some(4));
        assert_eq!(cache.total_bytes(), 40);
    }

    #[test]
    fn lru_keeps_free_entries_and_an_oversized_newest() {
        let mut cache = ByteLru::new(100);
        assert!(cache.insert("loading", 0, 0).is_empty());
        assert!(cache.insert("small", 1, 60).is_empty());
        assert!(cache.begin_frame().is_empty());
        assert!(cache.begin_frame().is_empty());
        assert_eq!(cache.insert("huge", 2, 500), vec![1]);
        assert_eq!(cache.peek(&"huge"), Some(&2));
        assert_eq!(cache.peek(&"loading"), Some(&0));
        assert_eq!(cache.clear().len(), 2);
        assert_eq!(cache.total_bytes(), 0);
    }

    #[test]
    fn visible_tiles_past_the_budget_settle_without_reloading() {
        // The re-check case: 280 tiles on screen together need more than the budget.
        let cost = 246 * 1024;
        let tiles = 280;
        assert!(tiles * cost > THUMB_BUDGET_BYTES);
        let mut cache = ByteLru::new(THUMB_BUDGET_BYTES);
        let mut loads = 0;
        for _frame in 0..5 {
            assert!(
                cache.begin_frame().is_empty(),
                "nothing on screen is evicted"
            );
            for tile in 0..tiles {
                if cache.get(&tile).is_none() {
                    loads += 1;
                    assert!(cache.insert(tile, (), cost).is_empty());
                }
            }
        }
        assert_eq!(loads, tiles, "each tile loaded once");
        assert!(
            cache.total_bytes() > THUMB_BUDGET_BYTES,
            "over budget while drawn"
        );
        // They scroll away: one frame later the map is back within its budget.
        assert!(cache.begin_frame().is_empty());
        let evicted = cache.begin_frame();
        assert!(!evicted.is_empty());
        assert!(cache.total_bytes() <= THUMB_BUDGET_BYTES);
    }

    #[test]
    fn a_damaged_gif_never_reaches_the_gpui_decoder() {
        // A GIF header and screen, then an image block that ends at once.
        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&[8, 0, 6, 0, 0, 0, 0, 0x2C, 0, 0, 0, 0, 8, 0, 6, 0, 0, 2]);
        let tile = TargetPx {
            width: 8,
            height: 6,
        };
        let cancel = AtomicBool::new(false);
        let mut reached = false;
        let thumb = thumbnail_for("image/gif", gif, tile, &cancel, |_| {
            reached = true;
            None
        });
        assert!(thumb.is_none(), "the missing-image tile");
        assert!(!reached, "GIF never decodes all its frames in GPUI");
        // A BMP, which this build cannot read, does go to GPUI.
        let mut reached = false;
        let _ = thumbnail_for("image/bmp", vec![b'B', b'M', 0, 0], tile, &cancel, |_| {
            reached = true;
            None
        });
        assert!(reached);
    }

    #[test]
    fn loads_run_two_at_a_time_in_order() {
        let mut loads = LoadQueue::new(LOAD_CONCURRENCY);
        assert_eq!(loads.request(1, "a", ()), Some((1, "a", ())));
        assert_eq!(loads.request(2, "b", ()), Some((2, "b", ())));
        assert_eq!(loads.request(3, "c", ()), None);
        assert_eq!(loads.request(4, "d", ()), None);
        assert_eq!(loads.exited(1), vec![(3, "c", ())]);
        assert_eq!(loads.exited(2), vec![(4, "d", ())]);
        assert!(loads.exited(3).is_empty());
        assert_eq!(loads.live_permits(), 1);
    }

    #[test]
    fn cancelled_loads_hold_their_permits_until_their_work_exits() {
        let mut loads = LoadQueue::new(2);
        assert!(loads.request(1, "a", ()).is_some());
        assert!(loads.request(2, "b", ()).is_some());
        assert!(loads.request(3, "c", ()).is_none());
        assert!(loads.request(4, "d", ()).is_none());
        // Every request counts as drawn until the first sweep.
        assert!(loads.sweep().is_empty());
        // `a` and `b` scroll away while their downloads still run.
        loads.touch(&"c");
        loads.touch(&"d");
        let mut cancelled = loads.sweep();
        cancelled.sort_unstable();
        assert_eq!(cancelled, [(1, "a"), (2, "b")]);
        // Their work still holds both permits: nothing replaces them yet.
        assert_eq!(loads.live_permits(), 2);
        assert!(loads.request(5, "e", ()).is_none());
        assert_eq!(loads.live_permits(), 2);
        // Each one that returns admits exactly one waiting load.
        assert_eq!(loads.exited(1), vec![(3, "c", ())]);
        assert_eq!(loads.live_permits(), 2);
        assert_eq!(loads.exited(2), vec![(4, "d", ())]);
        assert_eq!(loads.exited(3), vec![(5, "e", ())]);
        assert_eq!(loads.live_permits(), 2);
    }

    #[test]
    fn a_reconnect_keeps_permits_until_old_work_exits() {
        let mut loads = LoadQueue::new(2);
        assert!(loads.request(1, "a", ()).is_some());
        assert!(loads.request(2, "b", ()).is_some());
        let mut running = loads.clear();
        running.sort_unstable();
        assert_eq!(running, [1, 2]);
        assert!(loads.request(3, "a", ()).is_none());
        assert_eq!(loads.exited(1), vec![(3, "a", ())]);
        assert_eq!(loads.live_permits(), 2);
    }
}
