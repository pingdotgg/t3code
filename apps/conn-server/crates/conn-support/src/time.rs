//! UTC time in the contract's `DateTimeUtc` wire form: `2026-11-13T08:49:41.123Z`, the form of
//! JavaScript's `Date.prototype.toISOString`. It sorts as text.

use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch; 0 when the clock is before it.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// The current time in the wire form.
pub fn now_iso() -> String {
    iso_from_ms(now_ms())
}

/// [`iso_from_millis`] for a time that cannot be before the epoch.
pub fn iso_from_ms(ms: u64) -> String {
    iso_from_millis(i64::try_from(ms).unwrap_or(i64::MAX))
}

/// `millis` since the epoch in the wire form; a negative value is a time before 1970.
pub fn iso_from_millis(millis: i64) -> String {
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
pub fn millis_from_iso(text: &str) -> Option<i64> {
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

/// A moment read on both clocks, for an idle or expiry window that must hold when the host
/// was frozen or asleep (Orbit freezes containers) and when the wall clock is stepped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mark {
    pub wall_ms: u64,
    pub mono: std::time::Instant,
}

impl Mark {
    pub fn now() -> Self {
        Self {
            wall_ms: now_ms(),
            mono: std::time::Instant::now(),
        }
    }

    /// The time from `self` to `later`: the larger of the two clocks' readings, as T3's
    /// `idleMs` (`McpSessionRegistry.ts`). Wall time that passed while the monotonic clock
    /// stood still counts, and a wall clock stepped back cannot extend a window.
    pub fn elapsed_to(&self, later: &Self) -> std::time::Duration {
        let wall = std::time::Duration::from_millis(later.wall_ms.saturating_sub(self.wall_ms));
        wall.max(later.mono.saturating_duration_since(self.mono))
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

#[cfg(test)]
mod tests {
    use super::{Mark, iso_from_millis, iso_from_ms, millis_from_iso, now_iso, now_ms};
    use std::time::Duration;

    /// A jump of the wall clock with the monotonic clock still (a frozen container), a
    /// monotonic advance with the wall clock still, and a wall clock stepped back.
    #[test]
    fn a_mark_counts_the_larger_clock() {
        let start = Mark::now();
        for jump in [10 * 60, 2 * 3600, 3 * 86_400] {
            let jumped = Mark {
                wall_ms: start.wall_ms + jump * 1000,
                mono: start.mono,
            };
            assert_eq!(start.elapsed_to(&jumped), Duration::from_secs(jump));
            let advanced = Mark {
                wall_ms: start.wall_ms,
                mono: start.mono + Duration::from_secs(jump),
            };
            assert_eq!(start.elapsed_to(&advanced), Duration::from_secs(jump));
        }
        let stepped_back = Mark {
            wall_ms: start.wall_ms - 3_600_000,
            mono: start.mono + Duration::from_secs(5),
        };
        assert_eq!(start.elapsed_to(&stepped_back), Duration::from_secs(5));
    }

    #[test]
    fn formats_like_to_iso_string() {
        // The cases each crate's own copy tested.
        for (ms, text) in [
            (0, "1970-01-01T00:00:00.000Z"),
            (951_782_400_000, "2000-02-29T00:00:00.000Z"),
            (1_762_000_000_123, "2025-11-01T12:26:40.123Z"),
            (1_763_036_400_123, "2025-11-13T12:20:00.123Z"),
            (1_794_528_000_123, "2026-11-13T00:00:00.123Z"),
            (1_794_559_781_123, "2026-11-13T08:49:41.123Z"),
            (1_794_571_200_123, "2026-11-13T12:00:00.123Z"),
        ] {
            assert_eq!(iso_from_ms(ms), text);
            let signed = i64::try_from(ms).expect("small");
            assert_eq!(iso_from_millis(signed), text);
            assert_eq!(millis_from_iso(text), Some(signed), "round trip {text}");
        }
        assert_eq!(iso_from_millis(-1), "1969-12-31T23:59:59.999Z");
        assert_eq!(
            millis_from_iso("2026-11-13T08:49:41Z"),
            Some(1_794_559_781_000)
        );
        assert_eq!(millis_from_iso("yesterday"), None);
    }

    #[test]
    fn now_agrees_with_now_ms() {
        let before = now_ms();
        let parsed = millis_from_iso(&now_iso()).expect("now parses");
        let parsed = u64::try_from(parsed).expect("after 1970");
        assert!(
            parsed >= before && parsed - before < 60_000,
            "{parsed} near {before}"
        );
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
