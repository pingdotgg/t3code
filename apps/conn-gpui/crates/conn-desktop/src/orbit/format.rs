//! Number and duration text, matching Conn's JavaScript output exactly.
//!
//! Ports `formatTokens` (`packages/shared/src/usageFormat.ts`) and `formatWorkingDurationLabel`
//! (`packages/client-runtime/src/state/models.ts`), plus the JavaScript number rules they lean on
//! (`Math.round`, `Number.prototype.toFixed`, en-US grouping).

const TOKEN_SUFFIXES: [&str; 4] = ["K", "M", "B", "T"];

/// JavaScript `Math.round`: halves round toward positive infinity.
pub fn js_round(value: f64) -> f64 {
    let rounded = (value + 0.5).floor();
    // `Math.round(-0.4)` is `-0`, which prints as "0"; normalise it.
    if rounded == 0.0 { 0.0 } else { rounded }
}

/// JavaScript `toFixed(digits)` for finite values below 1e21: round half away from zero on the
/// exact binary value.
pub fn to_fixed(value: f64, digits: usize) -> String {
    if !value.is_finite() {
        return value.to_string();
    }
    // Rust prints the exact decimal expansion when asked for enough digits; round it by hand so
    // exact ties go up, as JavaScript does (Rust's own rounding sends ties to even).
    let wide = format!("{:.*}", digits + 30, value.abs());
    let (whole, fraction) = wide.split_once('.').unwrap_or((wide.as_str(), ""));
    let mut kept: Vec<u8> = whole.bytes().chain(fraction.bytes().take(digits)).collect();
    let rest = &fraction.as_bytes()[digits.min(fraction.len())..];
    if rest.first().is_some_and(|&d| d >= b'5') {
        let mut index = kept.len();
        loop {
            if index == 0 {
                kept.insert(0, b'1');
                break;
            }
            index -= 1;
            if kept[index] == b'9' {
                kept[index] = b'0';
            } else {
                kept[index] += 1;
                break;
            }
        }
    }
    let split = kept.len() - digits;
    let mut text = String::from_utf8_lossy(&kept[..split]).into_owned();
    if digits > 0 {
        text.push('.');
        text.push_str(&String::from_utf8_lossy(&kept[split..]));
    }
    // JavaScript keeps the sign of any negative value, so `(-0.001).toFixed(2)` is "-0.00".
    if value < 0.0 {
        format!("-{text}")
    } else {
        text
    }
}

/// An integer in en-US grouping, such as `1,234` (`Intl.NumberFormat("en-US")`).
pub fn group_integer(value: f64) -> String {
    let rounded = js_round(value);
    let digits = to_fixed(rounded.abs(), 0);
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    if rounded < 0.0 {
        format!("-{grouped}")
    } else {
        grouped
    }
}

/// `toLocaleString()` in en-US: grouped, with up to three fraction digits.
pub fn locale_number(value: f64) -> String {
    if value.fract() == 0.0 {
        return group_integer(value);
    }
    let fixed = to_fixed(value, 3);
    let (whole, fraction) = fixed.split_once('.').unwrap_or((fixed.as_str(), ""));
    let whole: f64 = whole.parse().unwrap_or(0.0);
    let fraction = fraction.trim_end_matches('0');
    let sign = if value < 0.0 && whole == 0.0 { "-" } else { "" };
    if fraction.is_empty() {
        format!("{sign}{}", group_integer(whole))
    } else {
        format!("{sign}{}.{fraction}", group_integer(whole))
    }
}

/// Fixed digits by size (two below 10, one below 100, none above), with trailing `.0…` cut.
fn trim(value: f64) -> String {
    let abs = value.abs();
    let digits = if abs >= 100.0 {
        0
    } else if abs >= 10.0 {
        1
    } else {
        2
    };
    let text = to_fixed(value, digits);
    match text.split_once('.') {
        Some((whole, fraction)) if fraction.bytes().all(|b| b == b'0') => whole.to_owned(),
        _ => text,
    }
}

/// Token counts as Conn shows them: `950`, `12.5K`, `1.41M`, `1.03B`.
pub fn format_tokens(value: f64) -> String {
    if js_round(value).abs() < 1e3 {
        return group_integer(value);
    }
    let mut scaled = value / 1e3;
    let mut unit = 0;
    // Choose the unit after rounding, so 999,999 reads 1M rather than 1000K.
    while trim(scaled).parse::<f64>().unwrap_or(0.0).abs() >= 1e3 && unit < TOKEN_SUFFIXES.len() - 1
    {
        scaled /= 1e3;
        unit += 1;
    }
    format!("{}{}", trim(scaled), TOKEN_SUFFIXES[unit])
}

/// A working duration: `42s`, `38m`, `24h 24m`.
pub fn format_duration(elapsed_ms: f64) -> String {
    let seconds = if elapsed_ms.is_finite() {
        (elapsed_ms / 1000.0).floor().max(0.0)
    } else {
        0.0
    };
    // Bounded above by f64; the cast saturates, which only matters for absurd values.
    let seconds = seconds as u64;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    format!("{}h {}m", minutes / 60, minutes % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_like_javascript() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(-0.4).to_string(), "0");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(9.995, 2), "9.99");
        assert_eq!(to_fixed(99.96, 1), "100.0");
        assert_eq!(to_fixed(-1.5, 0), "-2");
        assert_eq!(to_fixed(-0.001, 2), "-0.00");
        assert_eq!(to_fixed(1.6, 1), "1.6");
    }

    #[test]
    fn groups_like_en_us() {
        assert_eq!(group_integer(0.0), "0");
        assert_eq!(group_integer(999.0), "999");
        assert_eq!(group_integer(1234.0), "1,234");
        assert_eq!(group_integer(1_234_567.0), "1,234,567");
        assert_eq!(group_integer(-1234.0), "-1,234");
        assert_eq!(locale_number(610.0), "610");
        assert_eq!(locale_number(1234.5), "1,234.5");
    }

    #[test]
    fn formats_tokens() {
        assert_eq!(format_tokens(0.0), "0");
        assert_eq!(format_tokens(999.0), "999");
        assert_eq!(format_tokens(999.6), "1K");
        assert_eq!(format_tokens(1_000.0), "1K");
        assert_eq!(format_tokens(12_500.0), "12.5K");
        assert_eq!(format_tokens(999_999.0), "1M");
        assert_eq!(format_tokens(1_410_000.0), "1.41M");
        assert_eq!(format_tokens(2_000_000.0), "2M");
        assert_eq!(format_tokens(1_030_000_000.0), "1.03B");
        assert_eq!(format_tokens(941_600_000.0), "942M");
        assert_eq!(format_tokens(5e15), "5000T");
    }

    #[test]
    fn formats_durations() {
        assert_eq!(format_duration(0.0), "0s");
        assert_eq!(format_duration(59_999.0), "59s");
        assert_eq!(format_duration(60_000.0), "1m");
        assert_eq!(format_duration(38.0 * 60_000.0), "38m");
        assert_eq!(format_duration((24.0 * 60.0 + 24.0) * 60_000.0), "24h 24m");
        assert_eq!(format_duration(-5.0), "0s");
        assert_eq!(format_duration(f64::NAN), "0s");
    }
}
