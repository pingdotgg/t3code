//! UTC timestamps in the contract's `DateTimeUtc` wire form: `2026-11-13T08:49:41.123Z`.

use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn now_iso() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    iso_from_millis(millis)
}

pub(crate) fn iso_from_millis(millis: i64) -> String {
    let secs = millis.div_euclid(1000);
    let ms = millis.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Milliseconds since the epoch of an RFC 3339 time: `2026-11-13T08:49:41.123Z`, any number of
/// fraction digits or none, `Z` or a `±HH:MM` offset. `None` when it does not parse or names a
/// time that does not exist.
pub(crate) fn millis_from_iso(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let digits = |from: usize, len: usize| -> Option<i64> {
        let part = bytes.get(from..from + len)?;
        part.iter().try_fold(0i64, |n, b| {
            b.is_ascii_digit().then(|| n * 10 + i64::from(b - b'0'))
        })
    };
    let at = |i: usize, expected: &[u8]| bytes.get(i).is_some_and(|b| expected.contains(b));
    if !(at(4, b"-") && at(7, b"-") && at(10, b"Tt") && at(13, b":") && at(16, b":")) {
        return None;
    }
    let (y, m, d) = (digits(0, 4)?, digits(5, 2)?, digits(8, 2)?);
    let (h, mi, s) = (digits(11, 2)?, digits(14, 2)?, digits(17, 2)?);
    if !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) || h > 23 || mi > 59 || s > 59 {
        return None;
    }
    let mut i = 19;
    let mut ms = 0;
    if at(i, b".") {
        let start = i + 1;
        i = start;
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return None;
        }
        // The first three digits are milliseconds; the rest are below what the wire keeps.
        let kept = (i - start).min(3);
        ms = digits(start, kept)? * 10_i64.pow(3 - kept as u32);
    }
    let offset_minutes = match bytes.get(i..)? {
        b"Z" | b"z" => 0,
        [sign @ (b'+' | b'-'), _, _, b':', _, _] => {
            let (oh, om) = (digits(i + 1, 2)?, digits(i + 4, 2)?);
            if oh > 23 || om > 59 {
                return None;
            }
            let minutes = oh * 60 + om;
            if *sign == b'-' { -minutes } else { minutes }
        }
        _ => return None,
    };
    let days = days_from_civil(y, m, d);
    let minutes = days
        .checked_mul(1440)?
        .checked_add(h * 60 + mi)?
        .checked_sub(offset_minutes)?;
    minutes.checked_mul(60_000)?.checked_add(s * 1000 + ms)
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        2 if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Howard Hinnant's `days_from_civil`.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Howard Hinnant's `civil_from_days`.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// A suffix no earlier call in this process returned: epoch nanoseconds, then a counter.
pub(crate) fn unique_suffix() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

#[cfg(test)]
mod tests {
    use super::{iso_from_millis, millis_from_iso};

    #[test]
    fn formats_utc() {
        assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso_from_millis(1_794_559_781_123),
            "2026-11-13T08:49:41.123Z"
        );
        assert_eq!(iso_from_millis(951_782_400_000), "2000-02-29T00:00:00.000Z");
        for millis in [0, 951_782_400_000, 1_794_559_781_123] {
            assert_eq!(millis_from_iso(&iso_from_millis(millis)), Some(millis));
        }
        assert_eq!(
            millis_from_iso("2026-11-13T08:49:41Z"),
            Some(1_794_559_781_000)
        );
        assert_eq!(millis_from_iso("yesterday"), None);
    }

    #[test]
    fn parses_rfc_3339_offsets_and_rejects_impossible_times() {
        let utc = Some(1_794_559_781_123);
        assert_eq!(millis_from_iso("2026-11-13T08:49:41.123Z"), utc);
        assert_eq!(millis_from_iso("2026-11-13T08:49:41.123z"), utc);
        assert_eq!(millis_from_iso("2026-11-13T08:49:41.123+00:00"), utc);
        assert_eq!(millis_from_iso("2026-11-13T10:49:41.123+02:00"), utc);
        assert_eq!(millis_from_iso("2026-11-13T03:19:41.123-05:30"), utc);
        assert_eq!(millis_from_iso("2026-11-13t08:49:41.123456Z"), utc);
        for bad in [
            "2026-99-99T99:99:99Z",
            "2026-02-29T00:00:00Z",
            "2026-02-31T00:00:00Z",
            "2026-04-31T00:00:00Z",
            "2026-11-13T24:00:00Z",
            "2026-11-13T08:60:00Z",
            "2026-11-13T08:49:60Z",
            "2026-11-13T08:49:41+24:00",
            "2026-11-13T08:49:41+02",
            "2026-11-13T08:49:41",
            "2026-11-13T08:49:41.Z",
            "2026-11-13T08:49Z",
            "+026-11-13T08:49:41Z",
            "2026-1-13T08:49:41Z",
            "9999999999999999-01-01T00:00:00Z",
            "",
        ] {
            assert_eq!(millis_from_iso(bad), None, "{bad}");
        }
        assert_eq!(
            millis_from_iso("2024-02-29T00:00:00Z"),
            Some(1_709_164_800_000)
        );
    }
}
