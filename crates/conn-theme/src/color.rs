//! CSS Color 4 parsing (`oklch`, `#hex`, `rgb`/`rgba`, named keywords) and
//! CSS Color 5 `color-mix()` in `srgb` and `oklab`.

use crate::Rgba;
use std::f64::consts::PI;

/// Error returned when a CSS color string cannot be parsed.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("invalid CSS color `{0}`")]
pub struct ParseColorError(pub String);

/// Parses a CSS color literal into straight-alpha sRGB [`Rgba`] with channels in `0.0..=1.0`.
///
/// Supports:
/// - `oklch(L C H)` and `oklch(L C H / alpha)` (CSS Color 4, clipping out-of-gamut linear sRGB to `0..=1`)
/// - `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`
/// - `rgb(...)` and `rgba(...)` (both modern space/slash and legacy comma syntax)
/// - `transparent`, `black`, `white`
///
/// # Errors
/// Returns [`ParseColorError`] if `input` is not a recognized valid CSS color.
pub fn parse_color(input: &str) -> Result<Rgba, ParseColorError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(ParseColorError(input.to_owned()));
    }

    if trimmed.eq_ignore_ascii_case("transparent") {
        return Ok(Rgba::TRANSPARENT);
    }
    if trimmed.eq_ignore_ascii_case("black") {
        return Ok(Rgba::new(0.0, 0.0, 0.0, 1.0));
    }
    if trimmed.eq_ignore_ascii_case("white") {
        return Ok(Rgba::new(1.0, 1.0, 1.0, 1.0));
    }

    if let Some(hex) = trimmed.strip_prefix('#') {
        return parse_hex(hex).ok_or_else(|| ParseColorError(input.to_owned()));
    }

    if let Some(args) = strip_func(trimmed, "oklch") {
        return parse_oklch(args).ok_or_else(|| ParseColorError(input.to_owned()));
    }

    if let Some(args) = strip_func(trimmed, "rgb").or_else(|| strip_func(trimmed, "rgba")) {
        return parse_rgb_func(args).ok_or_else(|| ParseColorError(input.to_owned()));
    }

    Err(ParseColorError(input.to_owned()))
}

/// CSS `color-mix(in srgb, a (pa * 100)%, b)` with alpha premultiplication.
///
/// `pa` is clamped to `0.0..=1.0`; `b` receives weight `1.0 - pa`.
/// When `b` is [`Rgba::TRANSPARENT`], the result has `a`'s RGB channels and alpha `a.a * pa`.
#[must_use]
pub fn color_mix_srgb(a: Rgba, pa: f32, b: Rgba) -> Rgba {
    let wa = f64::from(pa.clamp(0.0, 1.0));
    let wb = 1.0 - wa;
    let aa = f64::from(a.a.clamp(0.0, 1.0));
    let ab = f64::from(b.a.clamp(0.0, 1.0));
    let alpha_out = wa * aa + wb * ab;

    if alpha_out <= 0.0 {
        return Rgba::TRANSPARENT;
    }

    let r = (wa * aa * f64::from(a.r) + wb * ab * f64::from(b.r)) / alpha_out;
    let g = (wa * aa * f64::from(a.g) + wb * ab * f64::from(b.g)) / alpha_out;
    let bl = (wa * aa * f64::from(a.b) + wb * ab * f64::from(b.b)) / alpha_out;

    Rgba::new(
        r.clamp(0.0, 1.0) as f32,
        g.clamp(0.0, 1.0) as f32,
        bl.clamp(0.0, 1.0) as f32,
        alpha_out.clamp(0.0, 1.0) as f32,
    )
}

/// CSS `color-mix(in oklab, a (pa * 100)%, b)` with alpha premultiplication.
///
/// `pa` is clamped to `0.0..=1.0`; `b` receives weight `1.0 - pa`.
/// Out-of-gamut linear sRGB channels are clipped to `0.0..=1.0` after converting back from OKLab.
#[must_use]
pub fn color_mix_oklab(a: Rgba, pa: f32, b: Rgba) -> Rgba {
    let wa = f64::from(pa.clamp(0.0, 1.0));
    let wb = 1.0 - wa;
    let aa = f64::from(a.a.clamp(0.0, 1.0));
    let ab = f64::from(b.a.clamp(0.0, 1.0));
    let alpha_out = wa * aa + wb * ab;

    if alpha_out <= 0.0 {
        return Rgba::TRANSPARENT;
    }

    let (la, oa, ba) = srgb_to_oklab(f64::from(a.r), f64::from(a.g), f64::from(a.b));
    let (lb, ob, bb) = srgb_to_oklab(f64::from(b.r), f64::from(b.g), f64::from(b.b));

    let l = (wa * aa * la + wb * ab * lb) / alpha_out;
    let o = (wa * aa * oa + wb * ab * ob) / alpha_out;
    let bv = (wa * aa * ba + wb * ab * bb) / alpha_out;

    let (r, g, bl) = oklab_to_srgb(l, o, bv);
    Rgba::new(
        r as f32,
        g as f32,
        bl as f32,
        alpha_out.clamp(0.0, 1.0) as f32,
    )
}

/// Converts OKLCH `(l, c, h_deg)` + `alpha` to sRGB [`Rgba`], clipping out-of-gamut linear sRGB.
#[must_use]
pub(crate) fn oklch_to_rgba(l: f64, c: f64, h_deg: f64, alpha: f64) -> Rgba {
    let h_rad = h_deg * (PI / 180.0);
    let a = c * h_rad.cos();
    let b = c * h_rad.sin();
    let (r, g, bl) = oklab_to_srgb(l, a, b);
    Rgba::new(r as f32, g as f32, bl as f32, alpha.clamp(0.0, 1.0) as f32)
}

fn strip_func<'a>(input: &'a str, name: &str) -> Option<&'a str> {
    let rest = input.strip_suffix(')')?;
    let prefix = rest.get(..name.len())?;
    if !prefix.eq_ignore_ascii_case(name) {
        return None;
    }
    rest.get(name.len()..)?.strip_prefix('(')
}

fn parse_hex(hex: &str) -> Option<Rgba> {
    let bytes = hex.as_bytes();
    let hex_val = |b: u8| -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    };
    let pair = |hi: u8, lo: u8| -> Option<f32> {
        let v = (hex_val(hi)? << 4) | hex_val(lo)?;
        Some(f32::from(v) / 255.0)
    };
    let dup = |n: u8| -> Option<f32> {
        let d = hex_val(n)?;
        Some(f32::from((d << 4) | d) / 255.0)
    };

    match bytes {
        [r, g, b] => Some(Rgba::new(dup(*r)?, dup(*g)?, dup(*b)?, 1.0)),
        [r, g, b, a] => Some(Rgba::new(dup(*r)?, dup(*g)?, dup(*b)?, dup(*a)?)),
        [r1, r2, g1, g2, b1, b2] => Some(Rgba::new(
            pair(*r1, *r2)?,
            pair(*g1, *g2)?,
            pair(*b1, *b2)?,
            1.0,
        )),
        [r1, r2, g1, g2, b1, b2, a1, a2] => Some(Rgba::new(
            pair(*r1, *r2)?,
            pair(*g1, *g2)?,
            pair(*b1, *b2)?,
            pair(*a1, *a2)?,
        )),
        _ => None,
    }
}

fn parse_oklch(args: &str) -> Option<Rgba> {
    let (channels_part, alpha_part) = split_slash(args)?;
    let parts: Vec<&str> = channels_part.split_whitespace().collect();
    if parts.len() != 3 {
        return None;
    }

    let l = parse_unit_or_percent(parts[0], 1.0)?.clamp(0.0, 1.0);
    // CSS Color 4: chroma percentage 100% = 0.4
    let c = parse_unit_or_percent(parts[1], 0.4)?.max(0.0);
    let h = parse_angle_deg(parts[2])?;
    let alpha = match alpha_part {
        Some(a) => parse_unit_or_percent(a, 1.0)?.clamp(0.0, 1.0),
        None => 1.0,
    };

    Some(oklch_to_rgba(l, c, h, alpha))
}

fn parse_rgb_func(args: &str) -> Option<Rgba> {
    if args.contains(',') {
        // Legacy comma-separated syntax: rgb(r, g, b) or rgba(r, g, b, a)
        let parts: Vec<&str> = args.split(',').map(str::trim).collect();
        if parts.len() != 3 && parts.len() != 4 {
            return None;
        }
        let r = parse_rgb_channel(parts[0])?;
        let g = parse_rgb_channel(parts[1])?;
        let b = parse_rgb_channel(parts[2])?;
        let a = if parts.len() == 4 {
            parse_unit_or_percent(parts[3], 1.0)?.clamp(0.0, 1.0)
        } else {
            1.0
        };
        return Some(Rgba::new(r as f32, g as f32, b as f32, a as f32));
    }

    // Modern space-separated syntax: rgb(r g b [/ a])
    let (channels_part, alpha_part) = split_slash(args)?;
    let parts: Vec<&str> = channels_part.split_whitespace().collect();
    if parts.len() != 3 {
        return None;
    }
    let r = parse_rgb_channel(parts[0])?;
    let g = parse_rgb_channel(parts[1])?;
    let b = parse_rgb_channel(parts[2])?;
    let a = match alpha_part {
        Some(a) => parse_unit_or_percent(a, 1.0)?.clamp(0.0, 1.0),
        None => 1.0,
    };
    Some(Rgba::new(r as f32, g as f32, b as f32, a as f32))
}

fn split_slash(args: &str) -> Option<(&str, Option<&str>)> {
    let mut iter = args.split('/');
    let first = iter.next()?.trim();
    let second = iter.next().map(str::trim);
    if iter.next().is_some() {
        return None;
    }
    if let Some(a) = second
        && a.is_empty()
    {
        return None;
    }
    Some((first, second))
}

fn parse_rgb_channel(token: &str) -> Option<f64> {
    if token.eq_ignore_ascii_case("none") {
        return Some(0.0);
    }
    if let Some(pct) = token.strip_suffix('%') {
        let v: f64 = pct.parse().ok()?;
        if !v.is_finite() {
            return None;
        }
        return Some((v / 100.0).clamp(0.0, 1.0));
    }
    let v: f64 = token.parse().ok()?;
    if !v.is_finite() {
        return None;
    }
    Some((v / 255.0).clamp(0.0, 1.0))
}

fn parse_unit_or_percent(token: &str, pct_scale: f64) -> Option<f64> {
    if token.eq_ignore_ascii_case("none") {
        return Some(0.0);
    }
    if let Some(pct) = token.strip_suffix('%') {
        let v: f64 = pct.parse().ok()?;
        if !v.is_finite() {
            return None;
        }
        return Some((v / 100.0) * pct_scale);
    }
    let v: f64 = token.parse().ok()?;
    if !v.is_finite() {
        return None;
    }
    Some(v)
}

fn parse_angle_deg(token: &str) -> Option<f64> {
    if token.eq_ignore_ascii_case("none") {
        return Some(0.0);
    }
    let (num_str, factor) = if let Some(s) = strip_suffix_ignore_case(token, "deg") {
        (s, 1.0)
    } else if let Some(s) = strip_suffix_ignore_case(token, "grad") {
        (s, 0.9)
    } else if let Some(s) = strip_suffix_ignore_case(token, "rad") {
        (s, 180.0 / PI)
    } else if let Some(s) = strip_suffix_ignore_case(token, "turn") {
        (s, 360.0)
    } else {
        (token, 1.0)
    };
    let v: f64 = num_str.parse().ok()?;
    if !v.is_finite() {
        return None;
    }
    Some(v * factor)
}

fn strip_suffix_ignore_case<'a>(s: &'a str, suffix: &str) -> Option<&'a str> {
    let split = s.len().checked_sub(suffix.len())?;
    let tail = s.get(split..)?;
    if tail.eq_ignore_ascii_case(suffix) {
        s.get(..split)
    } else {
        None
    }
}

fn srgb_channel_to_linear(c: f64) -> f64 {
    let c = c.clamp(0.0, 1.0);
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_channel_to_srgb(c: f64) -> f64 {
    let c = c.clamp(0.0, 1.0);
    if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

fn srgb_to_oklab(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let rl = srgb_channel_to_linear(r);
    let gl = srgb_channel_to_linear(g);
    let bl = srgb_channel_to_linear(b);

    let l = (0.412_221_470_8 * rl + 0.536_332_536_3 * gl + 0.051_445_992_9 * bl).cbrt();
    let m = (0.211_903_498_2 * rl + 0.680_699_545_1 * gl + 0.107_396_956_6 * bl).cbrt();
    let s = (0.088_302_461_9 * rl + 0.281_718_837_6 * gl + 0.629_978_700_5 * bl).cbrt();

    let ok_l = 0.210_454_255_3 * l + 0.793_617_785_0 * m - 0.004_072_046_8 * s;
    let ok_a = 1.977_998_495_1 * l - 2.428_592_205_0 * m + 0.450_593_709_9 * s;
    let ok_b = 0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766_0 * s;

    (ok_l, ok_a, ok_b)
}

fn oklab_to_srgb(ok_l: f64, ok_a: f64, ok_b: f64) -> (f64, f64, f64) {
    let l_ = ok_l + 0.396_337_777_4 * ok_a + 0.215_803_757_3 * ok_b;
    let m_ = ok_l - 0.105_561_345_8 * ok_a - 0.063_854_172_8 * ok_b;
    let s_ = ok_l - 0.089_484_177_5 * ok_a - 1.291_485_548_0 * ok_b;

    let l = l_ * l_ * l_;
    let m = m_ * m_ * m_;
    let s = s_ * s_ * s_;

    let rl = 4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s;
    let gl = -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s;
    let bl = -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701_0 * s;

    (
        linear_channel_to_srgb(rl),
        linear_channel_to_srgb(gl),
        linear_channel_to_srgb(bl),
    )
}
