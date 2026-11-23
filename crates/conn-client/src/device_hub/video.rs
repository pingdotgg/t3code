//! H.264 video stream demuxing for iOS/Simlock AVCC (`stream.avcc`) and Android `serve-emu`
//! SEMU + Annex-B packets, matching Conn's `device/stream.ts`.

use thiserror::Error;
use url::Url;

use crate::ClientError;
use crate::device_hub::{DeviceHubAccess, DeviceHubVendor};

/// Maximum single AVCC envelope payload (16 MiB).
const MAX_AVCC_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// 4-byte ASCII magic `"SEMU"` (`0x53454d55`) prefixed to `serve-emu` video frames.
pub const SEMU_MAGIC: u32 = 0x5345_4d55;

/// Fixed byte length of the `serve-emu` v1 frame metadata header.
pub const SEMU_HEADER_BYTES: usize = 16;

/// Bitmask for keyframe flag in `SEMU` header byte 5.
pub const SEMU_FLAG_KEY: u8 = 1;

/// Demuxed chunk from `serve-sim`'s `/helper/{device}/stream.avcc` framing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AvccChunk {
    /// Tag `1`: ISO/IEC 14496-15 `AVCDecoderConfigurationRecord` (`avcC` box payload).
    Description(Vec<u8>),
    /// Tag `2`: H.264 IDR keyframe in length-prefixed AVCC format.
    Keyframe(Vec<u8>),
    /// Tag `3`: H.264 non-IDR delta frame in length-prefixed AVCC format.
    Delta(Vec<u8>),
    /// Tag `4`: JPEG still seed frame painted while waiting for the first H.264 keyframe.
    Seed(Vec<u8>),
}

/// Errors returned while reading the `serve-sim` AVCC HTTP stream.
#[derive(Debug, Error)]
pub enum AvccStreamError {
    #[error("invalid avcc stream url: {0}")]
    InvalidUrl(#[from] ClientError),
    #[error("avcc stream unauthorized")]
    Unauthorized,
    #[error("device hub requires WebRTC streaming")]
    TransportLockedWebRtc,
    #[error("avcc stream returned HTTP {0}")]
    HttpStatus(u16),
    #[error("avcc stream network error: {0}")]
    Network(String),
}

/// Incremental length-prefixed AVCC envelope demuxer (`AvccDemuxer` in Conn's `stream.ts`).
///
/// Each envelope is `[u32_be length][u8 tag][payload of length - 1 bytes]`.
#[derive(Debug, Default)]
pub struct AvccDemuxer {
    buf: Vec<u8>,
}

impl AvccDemuxer {
    /// Creates an empty AVCC demuxer.
    #[must_use]
    pub fn new() -> Self {
        Self {
            buf: Vec::with_capacity(64 * 1024),
        }
    }

    /// Feeds raw HTTP body bytes and returns every complete [`AvccChunk`] extracted.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<AvccChunk> {
        if !bytes.is_empty() {
            self.buf.extend_from_slice(bytes);
        }
        let mut out = Vec::new();
        let mut offset = 0usize;
        while self.buf.len().saturating_sub(offset) >= 4 {
            let len = u32::from_be_bytes([
                self.buf[offset],
                self.buf[offset + 1],
                self.buf[offset + 2],
                self.buf[offset + 3],
            ]) as usize;
            if len > MAX_AVCC_FRAME_BYTES {
                self.buf.clear();
                return out;
            }
            if self.buf.len().saturating_sub(offset + 4) < len {
                break;
            }
            if len >= 1 {
                let tag = self.buf[offset + 4];
                let payload = &self.buf[offset + 5..offset + 4 + len];
                match tag {
                    1 => out.push(AvccChunk::Description(payload.to_vec())),
                    2 => out.push(AvccChunk::Keyframe(payload.to_vec())),
                    3 => out.push(AvccChunk::Delta(payload.to_vec())),
                    4 => out.push(AvccChunk::Seed(payload.to_vec())),
                    _ => {}
                }
            }
            offset += 4 + len;
        }
        if offset > 0 {
            self.buf.drain(..offset);
        }
        out
    }

    /// Clears buffered partial bytes.
    pub fn reset(&mut self) {
        self.buf.clear();
    }
}

/// Parsed SPS/PPS parameter sets and NAL length size from an `AVCDecoderConfigurationRecord`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AvccConfig {
    /// Length in bytes of each NAL unit length prefix (normally 4).
    pub nal_length_size: u8,
    pub sps: Vec<Vec<u8>>,
    pub pps: Vec<Vec<u8>>,
}

/// Parses an ISO/IEC 14496-15 `AVCDecoderConfigurationRecord` (`avcC`) into SPS/PPS NAL units
/// and NAL length prefix size.
#[must_use]
pub fn parse_avcc_record(avcc: &[u8]) -> Option<AvccConfig> {
    if avcc.len() < 7 || avcc[0] != 1 {
        return None;
    }
    let nal_length_size = (avcc[4] & 0x03) + 1;
    let num_sps = usize::from(avcc[5] & 0x1f);
    let mut offset = 6usize;

    let mut sps = Vec::with_capacity(num_sps);
    for _ in 0..num_sps {
        if offset + 2 > avcc.len() {
            return None;
        }
        let len = usize::from(u16::from_be_bytes([avcc[offset], avcc[offset + 1]]));
        offset += 2;
        if offset + len > avcc.len() {
            return None;
        }
        if len > 0 {
            sps.push(avcc[offset..offset + len].to_vec());
        }
        offset += len;
    }

    if offset >= avcc.len() {
        return None;
    }
    let num_pps = usize::from(avcc[offset]);
    offset += 1;

    let mut pps = Vec::with_capacity(num_pps);
    for _ in 0..num_pps {
        if offset + 2 > avcc.len() {
            return None;
        }
        let len = usize::from(u16::from_be_bytes([avcc[offset], avcc[offset + 1]]));
        offset += 2;
        if offset + len > avcc.len() {
            return None;
        }
        if len > 0 {
            pps.push(avcc[offset..offset + len].to_vec());
        }
        offset += len;
    }

    if sps.is_empty() || pps.is_empty() {
        return None;
    }
    Some(AvccConfig {
        nal_length_size,
        sps,
        pps,
    })
}

/// Normalizes an AVCC access unit with 1/2/3/4-byte NAL length prefixes into 4-byte big-endian
/// length-prefixed AVCC bytes (when `nal_length_size == 4`, returns a clone directly).
#[must_use]
pub fn normalize_avcc_to_4byte_lengths(data: &[u8], nal_length_size: u8) -> Option<Vec<u8>> {
    let prefix_len = usize::from(nal_length_size);
    if prefix_len == 4 {
        return Some(data.to_vec());
    }
    if !(1..=3).contains(&prefix_len) {
        return None;
    }
    let mut out = Vec::with_capacity(data.len() + 32);
    let mut offset = 0usize;
    while offset + prefix_len <= data.len() {
        let mut nal_len = 0u32;
        for &b in &data[offset..offset + prefix_len] {
            nal_len = (nal_len << 8) | u32::from(b);
        }
        offset += prefix_len;
        let nal_len_usize = nal_len as usize;
        if offset + nal_len_usize > data.len() {
            return None;
        }
        out.extend_from_slice(&nal_len.to_be_bytes());
        out.extend_from_slice(&data[offset..offset + nal_len_usize]);
        offset += nal_len_usize;
    }
    (!out.is_empty()).then_some(out)
}

/// Parsed Android `serve-emu` WebSocket binary video frame (`parseSemuPacket` in Conn's `stream.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SemuPacket<'a> {
    pub data: &'a [u8],
    pub is_key: Option<bool>,
    pub timestamp_us: Option<u64>,
}

/// Strips the optional 16-byte `SEMU` v1 metadata header from an Android `serve-emu` binary frame.
#[must_use]
pub fn parse_semu_packet(raw: &[u8]) -> SemuPacket<'_> {
    if raw.len() > SEMU_HEADER_BYTES {
        let magic = u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]);
        if magic == SEMU_MAGIC && raw[4] == 1 {
            let is_key = (raw[5] & SEMU_FLAG_KEY) != 0;
            let pts = u64::from_be_bytes([
                raw[8], raw[9], raw[10], raw[11], raw[12], raw[13], raw[14], raw[15],
            ]);
            return SemuPacket {
                data: &raw[SEMU_HEADER_BYTES..],
                is_key: Some(is_key),
                timestamp_us: Some(pts),
            };
        }
    }
    SemuPacket {
        data: raw,
        is_key: None,
        timestamp_us: None,
    }
}

/// Result of splitting an Annex-B H.264 access unit into parameter sets and a 4-byte AVCC sample.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedAnnexBAccessUnit {
    pub is_key: bool,
    pub sps: Vec<Vec<u8>>,
    pub pps: Vec<Vec<u8>>,
    /// 4-byte big-endian length-prefixed NAL units (excluding SPS/PPS/AUD), ready for VideoToolbox.
    pub avcc_sample: Vec<u8>,
}

/// Splits an Annex-B H.264 byte stream (`00 00 01` or `00 00 00 01` start codes) into raw NAL
/// slices without start codes.
#[must_use]
pub fn split_annex_b_nals(buf: &[u8]) -> Vec<&[u8]> {
    let mut starts: Vec<(usize, usize)> = Vec::new();
    let len = buf.len();
    let mut i = 0usize;
    while i + 2 < len {
        if buf[i] == 0 && buf[i + 1] == 0 {
            if buf[i + 2] == 1 {
                starts.push((i, i + 3));
                i += 3;
                continue;
            }
            if i + 3 < len && buf[i + 2] == 0 && buf[i + 3] == 1 {
                starts.push((i, i + 4));
                i += 4;
                continue;
            }
        }
        i += 1;
    }

    let mut nals = Vec::with_capacity(starts.len());
    for idx in 0..starts.len() {
        let nal_start = starts[idx].1;
        let nal_end = starts.get(idx + 1).map_or(len, |&(pos, _)| pos);
        if nal_start < nal_end {
            nals.push(&buf[nal_start..nal_end]);
        }
    }
    nals
}

/// Extracts SPS/PPS parameter sets, detects IDR keyframes (NAL type 5), and repacks VCL/SEI NALs
/// into 4-byte big-endian AVCC framing for hardware decoding.
#[must_use]
pub fn annex_b_to_avcc(buf: &[u8]) -> ParsedAnnexBAccessUnit {
    let mut is_key = false;
    let mut sps = Vec::new();
    let mut pps = Vec::new();
    let mut avcc_sample = Vec::with_capacity(buf.len());

    for nal in split_annex_b_nals(buf) {
        let nal_type = nal[0] & 0x1f;
        match nal_type {
            7 => sps.push(nal.to_vec()),
            8 => pps.push(nal.to_vec()),
            9 => {} // Access Unit Delimiter; VideoToolbox does not need it in AVCC samples.
            other => {
                if other == 5 {
                    is_key = true;
                }
                if let Ok(len) = u32::try_from(nal.len()) {
                    avcc_sample.extend_from_slice(&len.to_be_bytes());
                    avcc_sample.extend_from_slice(nal);
                }
            }
        }
    }

    ParsedAnnexBAccessUnit {
        is_key,
        sps,
        pps,
        avcc_sample,
    }
}

/// Builds the authenticated AVCC H.264 stream URL for a `serve-sim` (iOS or Simlock) device.
///
/// # Errors
///
/// Returns [`ClientError::InvalidUrl`] if URL construction fails.
pub fn avcc_stream_url(access: &DeviceHubAccess, device_id: &str) -> Result<Url, ClientError> {
    let encoded = DeviceHubAccess::encode_path_segment(device_id);
    access.vendor_http_url(
        DeviceHubVendor::ServeSim,
        &format!("/helper/{encoded}/stream.avcc"),
        &[],
    )
}

/// Opens the authenticated `serve-sim` AVCC H.264 stream for `device_id` and invokes `on_chunk`
/// for each demuxed [`AvccChunk`] until the stream ends or `on_chunk` returns `false`.
///
/// # Errors
///
/// Returns [`AvccStreamError::Unauthorized`] on HTTP 401/403,
/// [`AvccStreamError::TransportLockedWebRtc`] on HTTP 409 (`stream_transport_locked`),
/// [`AvccStreamError::HttpStatus`] on other non-2xx responses, or [`AvccStreamError::Network`] on
/// transport errors.
pub async fn stream_avcc_chunks<F>(
    http: &reqwest::Client,
    access: &DeviceHubAccess,
    device_id: &str,
    mut on_chunk: F,
) -> Result<(), AvccStreamError>
where
    F: FnMut(AvccChunk) -> bool,
{
    let url = avcc_stream_url(access, device_id)?;
    let mut request = http.get(url);
    for (name, value) in access.http_headers() {
        request = request.header(name, value);
    }

    let mut response = request
        .send()
        .await
        .map_err(|err| AvccStreamError::Network(err.to_string()))?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(AvccStreamError::Unauthorized);
    }
    if status == reqwest::StatusCode::CONFLICT {
        return Err(AvccStreamError::TransportLockedWebRtc);
    }
    if !status.is_success() {
        return Err(AvccStreamError::HttpStatus(status.as_u16()));
    }

    let mut demuxer = AvccDemuxer::new();
    while let Some(bytes) = response
        .chunk()
        .await
        .map_err(|err| AvccStreamError::Network(err.to_string()))?
    {
        for chunk in demuxer.push(&bytes) {
            if !on_chunk(chunk) {
                return Ok(());
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    fn envelope(tag: u8, payload: &[u8]) -> Vec<u8> {
        let len = (1 + payload.len()) as u32;
        let mut out = Vec::with_capacity(5 + payload.len());
        out.extend_from_slice(&len.to_be_bytes());
        out.push(tag);
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn demuxes_avcc_envelopes_across_split_reads() {
        let mut demuxer = AvccDemuxer::new();
        let mut raw = Vec::new();
        raw.extend_from_slice(&envelope(1, &[1, 0x64, 0x00, 0x1f]));
        raw.extend_from_slice(&envelope(4, &[0xFF, 0xD8, 0xFF, 0xD9]));
        raw.extend_from_slice(&envelope(2, &[0, 0, 0, 3, 0x65, 1, 2]));
        raw.extend_from_slice(&envelope(0x7f, &[0]));
        raw.extend_from_slice(&envelope(3, &[0, 0, 0, 2, 0x41, 9]));

        let mut chunks = Vec::new();
        for piece in raw.chunks(4) {
            chunks.extend(demuxer.push(piece));
        }
        assert_eq!(
            chunks,
            vec![
                AvccChunk::Description(vec![1, 0x64, 0x00, 0x1f]),
                AvccChunk::Seed(vec![0xFF, 0xD8, 0xFF, 0xD9]),
                AvccChunk::Keyframe(vec![0, 0, 0, 3, 0x65, 1, 2]),
                AvccChunk::Delta(vec![0, 0, 0, 2, 0x41, 9]),
            ],
            "AVCC demuxer must reassemble all known chunk tags and skip unknown tags"
        );
    }

    #[test]
    fn parses_avcc_decoder_configuration_record() {
        // configurationVersion=1, profile=0x64, compat=0x00, level=0x1f, lengthSizeMinusOne=3 (4 bytes),
        // 1 SPS (3 bytes), 1 PPS (2 bytes).
        let avcc = [
            1u8, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x03, 0x67, 0x64, 0x00, 0x01, 0x00, 0x02,
            0x68, 0xee,
        ];
        let cfg = parse_avcc_record(&avcc).expect("valid avcC record must parse");
        assert_eq!(cfg.nal_length_size, 4, "must parse 4-byte NAL length size");
        assert_eq!(cfg.sps, vec![vec![0x67, 0x64, 0x00]], "must extract SPS");
        assert_eq!(cfg.pps, vec![vec![0x68, 0xee]], "must extract PPS");
    }

    #[test]
    fn parses_semu_packet_and_converts_annex_b_to_avcc() {
        let mut raw = Vec::new();
        raw.extend_from_slice(&SEMU_MAGIC.to_be_bytes());
        raw.push(1); // version
        raw.push(SEMU_FLAG_KEY); // flags
        raw.extend_from_slice(&[0, 0]); // reserved
        raw.extend_from_slice(&42_000u64.to_be_bytes());
        // Annex-B: SPS (type 7), PPS (type 8), IDR (type 5)
        raw.extend_from_slice(&[0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1e]);
        raw.extend_from_slice(&[0, 0, 1, 0x68, 0xce, 0x3c, 0x80]);
        raw.extend_from_slice(&[0, 0, 0, 1, 0x65, 0x88, 0x84]);

        let semu = parse_semu_packet(&raw);
        assert_eq!(semu.is_key, Some(true), "SEMU key flag must decode");
        assert_eq!(
            semu.timestamp_us,
            Some(42_000),
            "SEMU timestamp must decode"
        );

        let parsed = annex_b_to_avcc(semu.data);
        assert!(parsed.is_key, "IDR NAL type 5 must set is_key");
        assert_eq!(
            parsed.sps,
            vec![vec![0x67, 0x42, 0xe0, 0x1e]],
            "must extract SPS NAL"
        );
        assert_eq!(
            parsed.pps,
            vec![vec![0x68, 0xce, 0x3c, 0x80]],
            "must extract PPS NAL"
        );
        assert_eq!(
            parsed.avcc_sample,
            vec![0, 0, 0, 3, 0x65, 0x88, 0x84],
            "IDR NAL must be length-prefixed with 4-byte big-endian length"
        );
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    async fn streams_avcc_chunks_from_fake_server() -> Result<(), Box<dyn std::error::Error>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let mut body = Vec::new();
        body.extend_from_slice(&envelope(1, &[1, 0x42, 0x00, 0x1e]));
        body.extend_from_slice(&envelope(2, &[0, 0, 0, 2, 0x65, 0x01]));
        let body_clone = body.clone();

        tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut req = [0u8; 4096];
            let _ = socket.read(&mut req).await;
            let header = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/octet-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body_clone.len()
            );
            let _ = socket.write_all(header.as_bytes()).await;
            let _ = socket.write_all(&body_clone).await;
            let _ = socket.shutdown().await;
        });

        let access = DeviceHubAccess::from_ticket(
            &Url::parse(&format!("http://{addr}"))?,
            "/api/device-hub",
            "t-avcc".to_owned(),
            None,
            None,
            None,
        )?;
        let mut got = Vec::new();
        stream_avcc_chunks(&reqwest::Client::new(), &access, "UDID-1", |chunk| {
            got.push(chunk);
            true
        })
        .await?;
        assert_eq!(
            got,
            vec![
                AvccChunk::Description(vec![1, 0x42, 0x00, 0x1e]),
                AvccChunk::Keyframe(vec![0, 0, 0, 2, 0x65, 0x01]),
            ],
            "must stream demuxed AVCC chunks from fake server"
        );
        Ok(())
    }
}
