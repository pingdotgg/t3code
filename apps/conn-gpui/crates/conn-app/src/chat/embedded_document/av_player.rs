//! A small AVFoundation player, for the video Chromium's open-source build cannot decode.
//!
//! The CEF runtime ships without proprietary codecs, so the common H.264/AAC MP4 fails there with
//! "this video can't be played". macOS decodes it natively. This file is the whole binding:
//! an `AVPlayer` for time and audio, and an `AVPlayerItemVideoOutput` that hands out decoded
//! frames as `CVPixelBuffer`s, which GPUI paints itself (`Window::paint_surface`), so the video
//! clips, scrolls and layers like any other element and nothing launches outside the app.
//!
//! There is no `objc2-av-foundation` dependency: the few selectors used are sent directly. Every
//! `unsafe` block below is one such send, to an object this file created, on the main thread
//! (the type is `!Send`), with the argument and return types AVFoundation declares. The signed
//! URL goes straight into an `NSURL`; this file logs nothing.

use std::ffi::{CStr, CString};
use std::ptr::{self, NonNull};

use objc2::encode::{Encode, Encoding, RefEncode};
use objc2::msg_send;
use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2_core_foundation::CFRetained;
use objc2_core_video::CVPixelBuffer;

// Loads AVFoundation so its classes exist at run time.
#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {}

/// `kCVPixelFormatType_420YpCbCr8BiPlanarFullRange`, the only format GPUI's surface renderer takes.
const PIXEL_FORMAT_420F: u32 = 0x3432_3066;
const TIMESCALE: i32 = 600;
const CM_VALID: u32 = 1;
/// Positive infinity, negative infinity and indefinite: times that are not a number of seconds.
const CM_NOT_A_NUMBER: u32 = 4 | 8 | 16;

/// CoreMedia's `CMTime`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(C)]
struct CMTime {
    value: i64,
    timescale: i32,
    flags: u32,
    epoch: i64,
}

// SAFETY: `CMTime` is `{?=qiIq}` in CoreMedia and this struct has the same fields and layout.
unsafe impl Encode for CMTime {
    const ENCODING: Encoding = Encoding::Struct(
        "?",
        &[
            Encoding::LongLong,
            Encoding::Int,
            Encoding::UInt,
            Encoding::LongLong,
        ],
    );
}

// SAFETY: A pointer to `CMTime` is encoded as a pointer to its encoding.
unsafe impl RefEncode for CMTime {
    const ENCODING_REF: Encoding = Encoding::Pointer(&<Self as Encode>::ENCODING);
}

impl CMTime {
    const ZERO: Self = Self {
        value: 0,
        timescale: 1,
        flags: CM_VALID,
        epoch: 0,
    };
    const INVALID: Self = Self {
        value: 0,
        timescale: 0,
        flags: 0,
        epoch: 0,
    };

    fn from_seconds(seconds: f64) -> Self {
        let seconds = if seconds.is_finite() {
            seconds.max(0.0)
        } else {
            0.0
        };
        Self {
            value: (seconds * f64::from(TIMESCALE)).round() as i64,
            timescale: TIMESCALE,
            flags: CM_VALID,
            epoch: 0,
        }
    }

    /// The time in seconds, unless it is invalid, infinite or indefinite.
    fn seconds(self) -> Option<f64> {
        (self.flags & CM_VALID != 0 && self.flags & CM_NOT_A_NUMBER == 0 && self.timescale > 0)
            .then(|| self.value as f64 / f64::from(self.timescale))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum AvError {
    /// AVFoundation's classes are missing.
    Unavailable,
    /// The URL could not become an `NSURL`.
    BadUrl,
}

/// What the player's item is doing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ItemState {
    Loading,
    Ready,
    Failed,
}

/// The player's state at one instant.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Snapshot {
    pub(super) item: ItemState,
    /// Playing, or waiting for data to play.
    pub(super) playing: bool,
    pub(super) current: f64,
    pub(super) duration: Option<f64>,
    pub(super) muted: bool,
}

pub(super) struct AvPlayer {
    player: Retained<AnyObject>,
    item: Retained<AnyObject>,
    output: Retained<AnyObject>,
}

impl std::fmt::Debug for AvPlayer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AvPlayer").finish_non_exhaustive()
    }
}

fn class(name: &CStr) -> Result<&'static AnyClass, AvError> {
    AnyClass::get(name).ok_or(AvError::Unavailable)
}

fn ns_string(text: &str) -> Option<Retained<AnyObject>> {
    let text = CString::new(text).ok()?;
    let class = AnyClass::get(c"NSString")?;
    // SAFETY: `+[NSString stringWithUTF8String:]` takes a NUL-terminated C string that outlives
    // the call, and returns a string, or nil.
    unsafe { msg_send![class, stringWithUTF8String: text.as_ptr()] }
}

fn ns_number(value: u32) -> Option<Retained<AnyObject>> {
    let class = AnyClass::get(c"NSNumber")?;
    // SAFETY: `+[NSNumber numberWithUnsignedInt:]` takes an `unsigned int` and returns a number.
    unsafe { msg_send![class, numberWithUnsignedInt: value] }
}

fn ns_bool(value: bool) -> Option<Retained<AnyObject>> {
    let class = AnyClass::get(c"NSNumber")?;
    // SAFETY: `+[NSNumber numberWithBool:]` takes a `BOOL` and returns a number.
    unsafe { msg_send![class, numberWithBool: Bool::new(value)] }
}

fn ns_dictionary() -> Option<Retained<AnyObject>> {
    let class = AnyClass::get(c"NSMutableDictionary")?;
    // SAFETY: `+[NSMutableDictionary dictionary]` takes no arguments and returns a dictionary.
    unsafe { msg_send![class, dictionary] }
}

fn set(dictionary: &AnyObject, key: &str, value: &AnyObject) -> Option<()> {
    let key = ns_string(key)?;
    // SAFETY: `-[NSMutableDictionary setObject:forKey:]` takes two objects, and a string is a
    // valid key.
    let _: () = unsafe { msg_send![dictionary, setObject: value, forKey: &*key] };
    Some(())
}

/// The attributes for frames GPUI can paint: bi-planar 4:2:0 full range, in an IOSurface that
/// Metal can read.
fn pixel_buffer_attributes() -> Option<Retained<AnyObject>> {
    let attributes = ns_dictionary()?;
    set(
        &attributes,
        "PixelFormatType",
        &*ns_number(PIXEL_FORMAT_420F)?,
    )?;
    set(&attributes, "IOSurfaceProperties", &*ns_dictionary()?)?;
    set(&attributes, "MetalCompatibility", &*ns_bool(true)?)?;
    Some(attributes)
}

impl AvPlayer {
    /// Starts loading `url` (an `http(s)` URL, signed or not), paused.
    pub(super) fn open(url: &str) -> Result<Self, AvError> {
        let url_string = ns_string(url).ok_or(AvError::BadUrl)?;
        // SAFETY: `+[NSURL URLWithString:]` takes a string and returns a URL, or nil.
        let url: Option<Retained<AnyObject>> =
            unsafe { msg_send![class(c"NSURL")?, URLWithString: &*url_string] };
        let url = url.ok_or(AvError::BadUrl)?;

        // SAFETY: `+[AVURLAsset URLAssetWithURL:options:]` takes a URL and a dictionary or nil.
        let asset: Option<Retained<AnyObject>> = unsafe {
            msg_send![
                class(c"AVURLAsset")?,
                URLAssetWithURL: &*url,
                options: Option::<&AnyObject>::None
            ]
        };
        let asset = asset.ok_or(AvError::Unavailable)?;

        // SAFETY: `+[AVPlayerItem playerItemWithAsset:]` takes an asset and returns an item.
        let item: Option<Retained<AnyObject>> =
            unsafe { msg_send![class(c"AVPlayerItem")?, playerItemWithAsset: &*asset] };
        let item = item.ok_or(AvError::Unavailable)?;

        let attributes = pixel_buffer_attributes().ok_or(AvError::Unavailable)?;
        // SAFETY: `+alloc` returns an uninitialised instance of the class.
        let allocated: Allocated<AnyObject> =
            unsafe { msg_send![class(c"AVPlayerItemVideoOutput")?, alloc] };
        // SAFETY: `-[AVPlayerItemVideoOutput initWithPixelBufferAttributes:]` takes a dictionary
        // of pixel buffer attributes and initialises the allocation.
        let output: Option<Retained<AnyObject>> =
            unsafe { msg_send![allocated, initWithPixelBufferAttributes: &*attributes] };
        let output = output.ok_or(AvError::Unavailable)?;
        // SAFETY: `-[AVPlayerItem addOutput:]` takes an `AVPlayerItemOutput`.
        let _: () = unsafe { msg_send![&item, addOutput: &*output] };

        // SAFETY: `+[AVPlayer playerWithPlayerItem:]` takes an item and returns a player.
        let player: Option<Retained<AnyObject>> =
            unsafe { msg_send![class(c"AVPlayer")?, playerWithPlayerItem: &*item] };
        let player = player.ok_or(AvError::Unavailable)?;
        Ok(Self {
            player,
            item,
            output,
        })
    }

    pub(super) fn play(&self) {
        // SAFETY: `-[AVPlayer play]` takes no arguments.
        let _: () = unsafe { msg_send![&self.player, play] };
    }

    pub(super) fn pause(&self) {
        // SAFETY: `-[AVPlayer pause]` takes no arguments.
        let _: () = unsafe { msg_send![&self.player, pause] };
    }

    pub(super) fn set_muted(&self, muted: bool) {
        // SAFETY: `-[AVPlayer setMuted:]` takes a `BOOL`.
        let _: () = unsafe { msg_send![&self.player, setMuted: Bool::new(muted)] };
    }

    /// Jumps to `seconds`, exactly.
    pub(super) fn seek(&self, seconds: f64) {
        // SAFETY: `-[AVPlayer seekToTime:toleranceBefore:toleranceAfter:]` takes three `CMTime`s.
        let _: () = unsafe {
            msg_send![
                &self.player,
                seekToTime: CMTime::from_seconds(seconds),
                toleranceBefore: CMTime::ZERO,
                toleranceAfter: CMTime::ZERO
            ]
        };
    }

    fn current_time(&self) -> CMTime {
        // SAFETY: `-[AVPlayer currentTime]` takes no arguments and returns a `CMTime`.
        unsafe { msg_send![&self.player, currentTime] }
    }

    pub(super) fn snapshot(&self) -> Snapshot {
        // SAFETY: `-[AVPlayerItem status]` returns an `AVPlayerItemStatus` (`NSInteger`).
        let status: isize = unsafe { msg_send![&self.item, status] };
        // SAFETY: `-[AVPlayer timeControlStatus]` returns an `AVPlayerTimeControlStatus`
        // (`NSInteger`).
        let control: isize = unsafe { msg_send![&self.player, timeControlStatus] };
        // SAFETY: `-[AVPlayerItem duration]` takes no arguments and returns a `CMTime`.
        let duration: CMTime = unsafe { msg_send![&self.item, duration] };
        // SAFETY: `-[AVPlayer isMuted]` returns a `BOOL`.
        let muted: Bool = unsafe { msg_send![&self.player, isMuted] };
        Snapshot {
            item: match status {
                1 => ItemState::Ready,
                2 => ItemState::Failed,
                _ => ItemState::Loading,
            },
            // 0 is paused, 1 waiting to play at the set rate, 2 playing.
            playing: control != 0,
            current: self.current_time().seconds().unwrap_or(0.0),
            duration: duration.seconds().filter(|seconds| *seconds > 0.0),
            muted: muted.as_bool(),
        }
    }

    /// The decoded frame for the current time, if it is a new one. `force` returns whichever
    /// frame is current even if it was handed out before.
    pub(super) fn next_frame(&self, force: bool) -> Option<CFRetained<CVPixelBuffer>> {
        let now = self.current_time();
        if !force {
            // SAFETY: `-[AVPlayerItemVideoOutput hasNewPixelBufferForItemTime:]` takes a
            // `CMTime` and returns a `BOOL`.
            let fresh: Bool = unsafe { msg_send![&self.output, hasNewPixelBufferForItemTime: now] };
            if !fresh.as_bool() {
                return None;
            }
        }
        let mut display = CMTime::INVALID;
        // SAFETY: `-[AVPlayerItemVideoOutput copyPixelBufferForItemTime:itemTimeForDisplay:]`
        // takes a `CMTime` and a pointer to a `CMTime` it may write, which outlives the call,
        // and returns a pixel buffer, or NULL, that the caller owns.
        let buffer: *mut CVPixelBuffer = unsafe {
            msg_send![
                &self.output,
                copyPixelBufferForItemTime: now,
                itemTimeForDisplay: ptr::from_mut(&mut display)
            ]
        };
        // SAFETY: A non-NULL buffer from a `copy…` method carries +1, which `CFRetained` owns.
        NonNull::new(buffer).map(|buffer| unsafe { CFRetained::from_raw(buffer) })
    }
}

impl Drop for AvPlayer {
    fn drop(&mut self) {
        self.pause();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmtime_has_coremedia_encoding() {
        assert_eq!(
            CMTime::ENCODING.to_string(),
            "{?=qiIq}",
            "the struct encoding matches CMTime",
        );
    }

    #[test]
    fn cmtime_round_trips_seconds_and_rejects_non_numbers() {
        assert_eq!(CMTime::from_seconds(1.5).seconds(), Some(1.5), "1.5 s");
        assert_eq!(
            CMTime::from_seconds(-3.0).seconds(),
            Some(0.0),
            "negative clamps to 0"
        );
        assert_eq!(
            CMTime::from_seconds(f64::NAN).seconds(),
            Some(0.0),
            "NaN clamps to 0"
        );
        assert_eq!(
            CMTime::INVALID.seconds(),
            None,
            "an invalid time has no seconds"
        );
        let indefinite = CMTime {
            flags: CM_VALID | 16,
            ..CMTime::ZERO
        };
        assert_eq!(
            indefinite.seconds(),
            None,
            "an indefinite duration has no seconds"
        );
    }

    #[test]
    fn the_surface_pixel_format_is_420f() {
        assert_eq!(
            PIXEL_FORMAT_420F,
            u32::from_be_bytes(*b"420f"),
            "the FourCC"
        );
    }

    #[test]
    fn a_bad_url_is_refused_before_avfoundation_sees_it() {
        assert!(
            matches!(AvPlayer::open("bad\0url"), Err(AvError::BadUrl)),
            "an interior NUL cannot become a string",
        );
    }
}
