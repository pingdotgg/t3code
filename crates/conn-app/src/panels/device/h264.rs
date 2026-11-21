//! Hardware H.264 decoding via macOS VideoToolbox (`VideoToolbox.framework`,
//! `CoreMedia.framework`, `CoreVideo.framework`, `CoreFoundation.framework`).
//!
//! Decodes 4-byte length-prefixed AVCC H.264 access units directly into 32-bit BGRA
//! [`DecodedFrame`] buffers ready for `gpui_kit::RenderImage`, with zero extra crate
//! dependencies. On non-macOS targets, provides a safe unavailable stub so callers fall back to
//! MJPEG cleanly.

use super::stream::DecodedFrame;

/// Rotates a tightly-packed 32-bit BGRA frame by `0`, `90` (CW), `-90`/`270` (CCW), or `180`
/// degrees, matching `DeviceStreamView`'s display orientation for portrait `serve-sim` buffers.
#[must_use]
pub(super) fn rotate_bgra(frame: DecodedFrame, rotation_deg: i16) -> DecodedFrame {
    let w = frame.width as usize;
    let h = frame.height as usize;
    if w == 0 || h == 0 || frame.bgra.len() != w * h * 4 {
        return frame;
    }
    match rotation_deg {
        90 => {
            let mut out = vec![0u8; w * h * 4];
            let dst_w = h;
            for sy in 0..h {
                for sx in 0..w {
                    let dx = h - 1 - sy;
                    let dy = sx;
                    let src_idx = (sy * w + sx) * 4;
                    let dst_idx = (dy * dst_w + dx) * 4;
                    out[dst_idx..dst_idx + 4].copy_from_slice(&frame.bgra[src_idx..src_idx + 4]);
                }
            }
            DecodedFrame {
                width: frame.height,
                height: frame.width,
                bgra: out,
            }
        }
        -90 | 270 => {
            let mut out = vec![0u8; w * h * 4];
            let dst_w = h;
            for sy in 0..h {
                for sx in 0..w {
                    let dx = sy;
                    let dy = w - 1 - sx;
                    let src_idx = (sy * w + sx) * 4;
                    let dst_idx = (dy * dst_w + dx) * 4;
                    out[dst_idx..dst_idx + 4].copy_from_slice(&frame.bgra[src_idx..src_idx + 4]);
                }
            }
            DecodedFrame {
                width: frame.height,
                height: frame.width,
                bgra: out,
            }
        }
        180 | -180 => {
            let mut out = vec![0u8; w * h * 4];
            for sy in 0..h {
                for sx in 0..w {
                    let dx = w - 1 - sx;
                    let dy = h - 1 - sy;
                    let src_idx = (sy * w + sx) * 4;
                    let dst_idx = (dy * w + dx) * 4;
                    out[dst_idx..dst_idx + 4].copy_from_slice(&frame.bgra[src_idx..src_idx + 4]);
                }
            }
            DecodedFrame {
                width: frame.width,
                height: frame.height,
                bgra: out,
            }
        }
        _ => frame,
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;
    use std::ptr;

    use super::super::stream::DecodedFrame;

    type OSStatus = i32;
    type CVReturn = i32;
    type CFIndex = isize;
    type CFTypeRef = *const c_void;
    type CFAllocatorRef = *const c_void;
    type CFDictionaryRef = *const c_void;
    type CFNumberRef = *const c_void;
    type CFStringRef = *const c_void;
    type CMFormatDescriptionRef = *const c_void;
    type CMBlockBufferRef = *mut c_void;
    type CMSampleBufferRef = *mut c_void;
    type VTDecompressionSessionRef = *mut c_void;
    type CVImageBufferRef = *mut c_void;

    const K_CF_NUMBER_SINT32_TYPE: CFIndex = 3;
    const K_CV_PIXEL_FORMAT_TYPE_32BGRA: i32 = u32::from_be_bytes(*b"BGRA") as i32;
    const K_CV_PIXEL_BUFFER_LOCK_READ_ONLY: u64 = 1;
    const K_VT_DECODE_INFO_FRAME_DROPPED: u32 = 1 << 1;
    /// Synchronous decode (bit 0 = EnableAsynchronousDecompression is cleared).
    const VT_DECODE_SYNCHRONOUS: u32 = 0;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CMTime {
        value: i64,
        timescale: i32,
        flags: u32,
        epoch: i64,
    }

    type VTDecompressionOutputCallback = unsafe extern "C" fn(
        decompression_output_ref_con: *mut c_void,
        source_frame_ref_con: *mut c_void,
        status: OSStatus,
        info_flags: u32,
        image_buffer: CVImageBufferRef,
        presentation_time_stamp: CMTime,
        presentation_duration: CMTime,
    );

    #[repr(C)]
    struct VTDecompressionOutputCallbackRecord {
        decompression_output_callback: Option<VTDecompressionOutputCallback>,
        decompression_output_ref_con: *mut c_void,
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFAllocatorNull: CFAllocatorRef;
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;

        fn CFRelease(cf: CFTypeRef);
        fn CFNumberCreate(
            allocator: CFAllocatorRef,
            the_type: CFIndex,
            value_ptr: *const c_void,
        ) -> CFNumberRef;
        fn CFDictionaryCreate(
            allocator: CFAllocatorRef,
            keys: *const *const c_void,
            values: *const *const c_void,
            num_values: CFIndex,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> CFDictionaryRef;
    }

    #[link(name = "CoreVideo", kind = "framework")]
    unsafe extern "C" {
        static kCVPixelBufferPixelFormatTypeKey: CFStringRef;

        fn CVPixelBufferLockBaseAddress(
            pixel_buffer: CVImageBufferRef,
            lock_flags: u64,
        ) -> CVReturn;
        fn CVPixelBufferUnlockBaseAddress(
            pixel_buffer: CVImageBufferRef,
            unlock_flags: u64,
        ) -> CVReturn;
        fn CVPixelBufferGetWidth(pixel_buffer: CVImageBufferRef) -> usize;
        fn CVPixelBufferGetHeight(pixel_buffer: CVImageBufferRef) -> usize;
        fn CVPixelBufferGetBytesPerRow(pixel_buffer: CVImageBufferRef) -> usize;
        fn CVPixelBufferGetBaseAddress(pixel_buffer: CVImageBufferRef) -> *mut c_void;
    }

    #[link(name = "CoreMedia", kind = "framework")]
    unsafe extern "C" {
        fn CMVideoFormatDescriptionCreateFromH264ParameterSets(
            allocator: CFAllocatorRef,
            parameter_set_count: usize,
            parameter_set_pointers: *const *const u8,
            parameter_set_sizes: *const usize,
            nal_unit_header_length: i32,
            format_description_out: *mut CMFormatDescriptionRef,
        ) -> OSStatus;

        fn CMBlockBufferCreateWithMemoryBlock(
            structure_allocator: CFAllocatorRef,
            memory_block: *mut c_void,
            block_length: usize,
            block_allocator: CFAllocatorRef,
            custom_block_source: *const c_void,
            offset_to_data: usize,
            data_length: usize,
            flags: u32,
            block_buffer_out: *mut CMBlockBufferRef,
        ) -> OSStatus;

        fn CMSampleBufferCreateReady(
            allocator: CFAllocatorRef,
            data_buffer: CMBlockBufferRef,
            format_description: CMFormatDescriptionRef,
            num_samples: CFIndex,
            num_sample_timing_entries: CFIndex,
            sample_timing_array: *const c_void,
            num_sample_size_entries: CFIndex,
            sample_size_array: *const usize,
            sample_buffer_out: *mut CMSampleBufferRef,
        ) -> OSStatus;
    }

    #[link(name = "VideoToolbox", kind = "framework")]
    unsafe extern "C" {
        fn VTDecompressionSessionCreate(
            allocator: CFAllocatorRef,
            video_format_description: CMFormatDescriptionRef,
            video_decoder_specification: CFDictionaryRef,
            destination_image_buffer_attributes: CFDictionaryRef,
            output_callback: *const VTDecompressionOutputCallbackRecord,
            decompression_session_out: *mut VTDecompressionSessionRef,
        ) -> OSStatus;

        fn VTDecompressionSessionDecodeFrame(
            session: VTDecompressionSessionRef,
            sample_buffer: CMSampleBufferRef,
            decode_flags: u32,
            source_frame_ref_con: *mut c_void,
            info_flags_out: *mut u32,
        ) -> OSStatus;

        fn VTDecompressionSessionInvalidate(session: VTDecompressionSessionRef);
    }

    /// RAII guard for owned CoreFoundation/CoreMedia references.
    struct CfGuard(CFTypeRef);

    impl Drop for CfGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: `CfGuard` exclusively owns a retained CF reference created with a
                // Create/Copy rule and releases it exactly once on drop.
                unsafe { CFRelease(self.0) };
            }
        }
    }

    /// Output slot passed via `source_frame_ref_con` for a single synchronous decode call.
    struct DecodeOutputSlot {
        frame: Option<DecodedFrame>,
    }

    unsafe extern "C" fn decode_output_callback(
        _decompression_output_ref_con: *mut c_void,
        source_frame_ref_con: *mut c_void,
        status: OSStatus,
        info_flags: u32,
        image_buffer: CVImageBufferRef,
        _presentation_time_stamp: CMTime,
        _presentation_duration: CMTime,
    ) {
        let _ = std::panic::catch_unwind(|| {
            if status != 0
                || image_buffer.is_null()
                || source_frame_ref_con.is_null()
                || (info_flags & K_VT_DECODE_INFO_FRAME_DROPPED) != 0
            {
                return;
            }
            // SAFETY: `VTDecompressionSessionDecodeFrame` runs synchronously (`decode_flags = 0`)
            // and receives `&mut slot` as `source_frame_ref_con`, so `slot` is valid, properly
            // aligned, and exclusively borrowed for the duration of this callback.
            let slot = unsafe { &mut *source_frame_ref_con.cast::<DecodeOutputSlot>() };
            if let Some(frame) = copy_bgra_pixel_buffer(image_buffer) {
                slot.frame = Some(frame);
            }
        });
    }

    fn copy_bgra_pixel_buffer(pixel_buffer: CVImageBufferRef) -> Option<DecodedFrame> {
        // SAFETY: `pixel_buffer` is a non-null `CVPixelBufferRef` supplied by VideoToolbox for the
        // duration of the output callback; we lock it read-only and always unlock before return.
        let lock_res =
            unsafe { CVPixelBufferLockBaseAddress(pixel_buffer, K_CV_PIXEL_BUFFER_LOCK_READ_ONLY) };
        if lock_res != 0 {
            return None;
        }

        struct UnlockGuard(CVImageBufferRef);
        impl Drop for UnlockGuard {
            fn drop(&mut self) {
                // SAFETY: Matches the successful `CVPixelBufferLockBaseAddress` call above with
                // identical read-only flags.
                unsafe {
                    CVPixelBufferUnlockBaseAddress(self.0, K_CV_PIXEL_BUFFER_LOCK_READ_ONLY);
                }
            }
        }
        let _unlock = UnlockGuard(pixel_buffer);

        // SAFETY: The pixel buffer is locked for reading; querying its dimensions, stride, and
        // base address is valid while locked.
        let (width, height, bytes_per_row, base) = unsafe {
            (
                CVPixelBufferGetWidth(pixel_buffer),
                CVPixelBufferGetHeight(pixel_buffer),
                CVPixelBufferGetBytesPerRow(pixel_buffer),
                CVPixelBufferGetBaseAddress(pixel_buffer).cast::<u8>(),
            )
        };

        let row_bytes = width.checked_mul(4)?;
        if width == 0 || height == 0 || base.is_null() || bytes_per_row < row_bytes {
            return None;
        }
        let total_bytes = row_bytes.checked_mul(height)?;
        let mut bgra = vec![0u8; total_bytes];

        for row in 0..height {
            let src_offset = row.checked_mul(bytes_per_row)?;
            let dst_offset = row * row_bytes;
            // SAFETY: `pixel_buffer` is locked with at least `height * bytes_per_row` readable
            // bytes starting at `base`, and `row_bytes <= bytes_per_row`.
            let src_row = unsafe { std::slice::from_raw_parts(base.add(src_offset), row_bytes) };
            bgra[dst_offset..dst_offset + row_bytes].copy_from_slice(src_row);
        }

        Some(DecodedFrame {
            width: u32::try_from(width).ok()?,
            height: u32::try_from(height).ok()?,
            bgra,
        })
    }

    /// Synchronous macOS VideoToolbox H.264 decoder producing 32-bit BGRA frames.
    pub(in super::super) struct VideoToolboxDecoder {
        format_desc: CMFormatDescriptionRef,
        session: VTDecompressionSessionRef,
    }

    // SAFETY: `VideoToolboxDecoder` exclusively owns its `CMFormatDescriptionRef` and
    // `VTDecompressionSessionRef`, performs only synchronous decoding through `&mut self`, and
    // invalidates/releases them on `Drop`. Moving it across worker threads is sound.
    unsafe impl Send for VideoToolboxDecoder {}

    impl std::fmt::Debug for VideoToolboxDecoder {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("VideoToolboxDecoder")
                .finish_non_exhaustive()
        }
    }

    impl Drop for VideoToolboxDecoder {
        fn drop(&mut self) {
            if !self.session.is_null() {
                // SAFETY: All decode calls are synchronous, so no async callback can reference
                // this session when `Drop` runs. Invalidate before releasing per VideoToolbox docs.
                unsafe {
                    VTDecompressionSessionInvalidate(self.session);
                    CFRelease(self.session.cast::<c_void>());
                }
                self.session = ptr::null_mut();
            }
            if !self.format_desc.is_null() {
                // SAFETY: `self.format_desc` is a retained `CMFormatDescriptionRef` owned by self.
                unsafe { CFRelease(self.format_desc) };
                self.format_desc = ptr::null();
            }
        }
    }

    impl VideoToolboxDecoder {
        /// Returns `true` on macOS where VideoToolbox is linked.
        #[must_use]
        pub(in super::super) const fn is_supported() -> bool {
            true
        }

        /// Creates a VideoToolbox decompression session from H.264 SPS and PPS NAL units
        /// (without Annex-B start codes or length prefixes) configured for 4-byte AVCC samples.
        pub(in super::super) fn new(
            sps_list: &[Vec<u8>],
            pps_list: &[Vec<u8>],
        ) -> Result<Self, String> {
            if sps_list.is_empty() || pps_list.is_empty() {
                return Err("missing H.264 SPS or PPS parameter sets".to_owned());
            }
            let mut ptrs: Vec<*const u8> = Vec::with_capacity(sps_list.len() + pps_list.len());
            let mut sizes: Vec<usize> = Vec::with_capacity(sps_list.len() + pps_list.len());
            for nal in sps_list.iter().chain(pps_list.iter()) {
                if !nal.is_empty() {
                    ptrs.push(nal.as_ptr());
                    sizes.push(nal.len());
                }
            }
            if ptrs.len() < 2 {
                return Err("insufficient H.264 parameter sets".to_owned());
            }

            let mut format_desc: CMFormatDescriptionRef = ptr::null();
            // SAFETY: `ptrs` and `sizes` have identical length >= 2 and point to valid slices
            // alive for the duration of this call; `format_desc` receives a retained reference.
            let fmt_status = unsafe {
                CMVideoFormatDescriptionCreateFromH264ParameterSets(
                    ptr::null(),
                    ptrs.len(),
                    ptrs.as_ptr(),
                    sizes.as_ptr(),
                    4,
                    &mut format_desc,
                )
            };
            if fmt_status != 0 || format_desc.is_null() {
                return Err(format!(
                    "CMVideoFormatDescriptionCreateFromH264ParameterSets failed ({fmt_status})"
                ));
            }
            let fmt_guard = CfGuard(format_desc);

            let pixel_format = K_CV_PIXEL_FORMAT_TYPE_32BGRA;
            // SAFETY: `&pixel_format` points to a valid `i32` matching `kCFNumberSInt32Type`.
            let pixel_format_num = unsafe {
                CFNumberCreate(
                    ptr::null(),
                    K_CF_NUMBER_SINT32_TYPE,
                    ptr::from_ref(&pixel_format).cast::<c_void>(),
                )
            };
            if pixel_format_num.is_null() {
                return Err("CFNumberCreate failed for 32BGRA pixel format".to_owned());
            }
            let _num_guard = CfGuard(pixel_format_num);

            // SAFETY: `kCVPixelBufferPixelFormatTypeKey` and `pixel_format_num` are valid CF
            // objects; callbacks are standard CFType callbacks provided by CoreFoundation.
            let dest_attrs = unsafe {
                let key = kCVPixelBufferPixelFormatTypeKey;
                let val = pixel_format_num;
                CFDictionaryCreate(
                    ptr::null(),
                    &key,
                    &val,
                    1,
                    ptr::addr_of!(kCFTypeDictionaryKeyCallBacks),
                    ptr::addr_of!(kCFTypeDictionaryValueCallBacks),
                )
            };
            if dest_attrs.is_null() {
                return Err("CFDictionaryCreate failed for VideoToolbox attributes".to_owned());
            }
            let _attrs_guard = CfGuard(dest_attrs);

            let callback = VTDecompressionOutputCallbackRecord {
                decompression_output_callback: Some(decode_output_callback),
                decompression_output_ref_con: ptr::null_mut(),
            };
            let mut session: VTDecompressionSessionRef = ptr::null_mut();
            // SAFETY: `format_desc` and `dest_attrs` are valid CF objects, `callback` points to
            // a valid stack record copied by VideoToolbox, and `session` receives an owned handle.
            let session_status = unsafe {
                VTDecompressionSessionCreate(
                    ptr::null(),
                    format_desc,
                    ptr::null(),
                    dest_attrs,
                    &callback,
                    &mut session,
                )
            };
            if session_status != 0 || session.is_null() {
                return Err(format!(
                    "VTDecompressionSessionCreate failed ({session_status})"
                ));
            }

            // Transfer ownership of `format_desc` out of `fmt_guard` into `Self`.
            std::mem::forget(fmt_guard);
            Ok(Self {
                format_desc,
                session,
            })
        }

        /// Synchronously decodes a 4-byte length-prefixed AVCC H.264 access unit into BGRA.
        pub(in super::super) fn decode_avcc(
            &mut self,
            avcc_sample: &[u8],
        ) -> Result<Option<DecodedFrame>, String> {
            if avcc_sample.is_empty() {
                return Ok(None);
            }

            let mut block_buf: CMBlockBufferRef = ptr::null_mut();
            // SAFETY: `avcc_sample` lives through the synchronous decode call below; passing
            // `kCFAllocatorNull` as `block_allocator` ensures CoreMedia never frees our slice.
            let block_status = unsafe {
                CMBlockBufferCreateWithMemoryBlock(
                    ptr::null(),
                    avcc_sample.as_ptr().cast_mut().cast::<c_void>(),
                    avcc_sample.len(),
                    kCFAllocatorNull,
                    ptr::null(),
                    0,
                    avcc_sample.len(),
                    0,
                    &mut block_buf,
                )
            };
            if block_status != 0 || block_buf.is_null() {
                return Err(format!(
                    "CMBlockBufferCreateWithMemoryBlock failed ({block_status})"
                ));
            }
            let _block_guard = CfGuard(block_buf.cast::<c_void>());

            let sample_size = avcc_sample.len();
            let mut sample_buf: CMSampleBufferRef = ptr::null_mut();
            // SAFETY: `block_buf` and `self.format_desc` are valid CoreMedia objects, and
            // `sample_size` matches `num_sample_size_entries = 1`.
            let sample_status = unsafe {
                CMSampleBufferCreateReady(
                    ptr::null(),
                    block_buf,
                    self.format_desc,
                    1,
                    0,
                    ptr::null(),
                    1,
                    &sample_size,
                    &mut sample_buf,
                )
            };
            if sample_status != 0 || sample_buf.is_null() {
                return Err(format!(
                    "CMSampleBufferCreateReady failed ({sample_status})"
                ));
            }
            let _sample_guard = CfGuard(sample_buf.cast::<c_void>());

            let mut slot = DecodeOutputSlot { frame: None };
            let mut info_flags: u32 = 0;
            // SAFETY: `self.session` and `sample_buf` are valid, `decode_flags = 0` forces
            // synchronous completion before returning, so `&mut slot` remains valid for the
            // callback and `avcc_sample` outlives `sample_buf`.
            let decode_status = unsafe {
                VTDecompressionSessionDecodeFrame(
                    self.session,
                    sample_buf,
                    VT_DECODE_SYNCHRONOUS,
                    ptr::from_mut(&mut slot).cast::<c_void>(),
                    &mut info_flags,
                )
            };
            if decode_status != 0 {
                return Err(format!(
                    "VTDecompressionSessionDecodeFrame failed ({decode_status})"
                ));
            }
            Ok(slot.frame)
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod fallback {
    use super::super::stream::DecodedFrame;

    #[derive(Debug)]
    pub(in super::super) struct VideoToolboxDecoder;

    impl VideoToolboxDecoder {
        #[must_use]
        pub(in super::super) const fn is_supported() -> bool {
            false
        }

        pub(in super::super) fn new(
            _sps_list: &[Vec<u8>],
            _pps_list: &[Vec<u8>],
        ) -> Result<Self, String> {
            Err("VideoToolbox H.264 decoding is only available on macOS".to_owned())
        }

        pub(in super::super) fn decode_avcc(
            &mut self,
            _avcc_sample: &[u8],
        ) -> Result<Option<DecodedFrame>, String> {
            Err("VideoToolbox H.264 decoding is only available on macOS".to_owned())
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub(super) use self::fallback::VideoToolboxDecoder;
#[cfg(target_os = "macos")]
pub(super) use self::macos::VideoToolboxDecoder;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_bgra_pixels_correctly_for_all_orientations() {
        // 2x1 image: left pixel = [1,2,3,255], right pixel = [4,5,6,255].
        let frame = DecodedFrame {
            width: 2,
            height: 1,
            bgra: vec![1, 2, 3, 255, 4, 5, 6, 255],
        };
        let cw = rotate_bgra(
            DecodedFrame {
                width: frame.width,
                height: frame.height,
                bgra: frame.bgra.clone(),
            },
            90,
        );
        assert_eq!(
            (cw.width, cw.height),
            (1, 2),
            "90deg CW transposes 2x1 -> 1x2"
        );
        assert_eq!(
            cw.bgra,
            vec![1, 2, 3, 255, 4, 5, 6, 255],
            "90deg CW puts left pixel at top (0,0) and right pixel at bottom (0,1)"
        );

        let ccw = rotate_bgra(
            DecodedFrame {
                width: frame.width,
                height: frame.height,
                bgra: frame.bgra.clone(),
            },
            -90,
        );
        assert_eq!(
            (ccw.width, ccw.height),
            (1, 2),
            "-90deg CCW transposes 2x1 -> 1x2"
        );
        assert_eq!(
            ccw.bgra,
            vec![4, 5, 6, 255, 1, 2, 3, 255],
            "-90deg CCW puts right pixel at top (0,0) and left pixel at bottom (0,1)"
        );

        let flip = rotate_bgra(frame, 180);
        assert_eq!((flip.width, flip.height), (2, 1), "180deg keeps 2x1");
        assert_eq!(
            flip.bgra,
            vec![4, 5, 6, 255, 1, 2, 3, 255],
            "180deg reverses pixel order"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn videotoolbox_decodes_real_h264_idr_frame_to_bgra() {
        // Real 16x16 solid-blue H.264 Baseline Profile SPS + PPS + IDR NAL units.
        let sps = vec![
            0x67, 0x42, 0xc0, 0x0a, 0xd9, 0x1e, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00,
            0x00, 0x03, 0x00, 0xc8, 0x3c, 0x48, 0x99, 0x20,
        ];
        let pps = vec![0x68, 0xcb, 0x83, 0xcb, 0x20];
        let idr = [
            0x65, 0x88, 0x84, 0x0a, 0xf1, 0x18, 0xa0, 0x00, 0x27, 0xa7, 0x1c, 0x00, 0x04, 0xbe,
            0x23, 0x80, 0x00, 0x82, 0xee,
        ];
        let mut avcc_sample = Vec::with_capacity(4 + idr.len());
        avcc_sample.extend_from_slice(&(idr.len() as u32).to_be_bytes());
        avcc_sample.extend_from_slice(&idr);

        let mut decoder = VideoToolboxDecoder::new(&[sps], &[pps])
            .expect("VideoToolbox must create a decompression session from valid H.264 SPS/PPS");
        let decoded = decoder
            .decode_avcc(&avcc_sample)
            .expect("VideoToolbox must decode a valid IDR keyframe")
            .expect("synchronous decode must produce a DecodedFrame");

        assert_eq!(
            (decoded.width, decoded.height),
            (16, 16),
            "decoded H.264 frame dimensions must be 16x16"
        );
        assert_eq!(
            decoded.bgra.len(),
            16 * 16 * 4,
            "decoded BGRA buffer must hold 16x16x4 bytes"
        );
        // Solid blue pixel in 32-bit BGRA: B high, G low, R low, A=255.
        assert!(
            decoded.bgra[0] > 200
                && decoded.bgra[1] < 40
                && decoded.bgra[2] < 40
                && decoded.bgra[3] == 255,
            "expected solid blue BGRA pixel, got {:?}",
            &decoded.bgra[..4]
        );
    }
}
