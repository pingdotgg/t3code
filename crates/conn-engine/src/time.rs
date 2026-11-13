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

/// Milliseconds since the epoch of an ISO-8601 UTC time (`2026-11-13T08:49:41.123Z`, with or
/// without fraction). `None` when it does not parse.
pub(crate) fn millis_from_iso(text: &str) -> Option<i64> {
    let text = text.strip_suffix('Z')?;
    let (date, time) = text.split_once('T')?;
    let mut date = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (date.next()??, date.next()??, date.next()??);
    let (hms, frac) = time.split_once('.').unwrap_or((time, "0"));
    let mut hms = hms.split(':').map(|p| p.parse::<i64>().ok());
    let (h, mi, s) = (hms.next()??, hms.next()??, hms.next()??);
    let ms: i64 = format!("{frac:0<3}").get(..3)?.parse().ok()?;
    let days = days_from_civil(y, m, d);
    Some(((days * 24 + h) * 60 + mi) * 60_000 + s * 1000 + ms)
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
}
