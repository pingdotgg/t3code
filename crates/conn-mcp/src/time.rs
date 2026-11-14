//! The current UTC time in the contract's wire form, `2026-11-13T08:49:41.123Z`, which sorts
//! as text: snooze checks compare these strings.

use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn now_iso() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let secs = millis.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant's `civil_from_days`.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        millis.rem_euclid(1000)
    )
}

/// Milliseconds since the epoch of a wire time (`2026-11-13T08:49:41.123Z`, a fraction and a
/// `Z` or `+hh:mm` offset optional), or `None` for text that is not one. The T3 server gets
/// this from `Date.parse`; it only ever sees the wire form.
pub(crate) fn parse_iso_ms(text: &str) -> Option<i64> {
    let digits = |s: &str| -> Option<i64> {
        (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse::<i64>().ok())
            .flatten()
    };
    let (date, time) = text.split_once('T')?;
    let mut date = date.split('-');
    let (y, m, d) = (
        digits(date.next()?)?,
        digits(date.next()?)?,
        digits(date.next()?)?,
    );
    if date.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let (clock, offset_minutes) = if let Some(clock) = time.strip_suffix('Z') {
        (clock, 0)
    } else {
        let at = time.rfind(['+', '-'])?;
        let (clock, zone) = time.split_at(at);
        let (hh, mm) = zone.get(1..)?.split_once(':')?;
        let minutes = digits(hh)? * 60 + digits(mm)?;
        (
            clock,
            if zone.starts_with('-') {
                -minutes
            } else {
                minutes
            },
        )
    };
    let (clock, fraction) = clock.split_once('.').unwrap_or((clock, ""));
    let mut parts = clock.split(':');
    let (hh, mm, ss) = (
        digits(parts.next()?)?,
        digits(parts.next()?)?,
        digits(parts.next()?)?,
    );
    if parts.next().is_some() || hh > 23 || mm > 59 || ss > 59 {
        return None;
    }
    let millis = if fraction.is_empty() {
        0
    } else {
        let head: String = fraction.chars().take(3).collect();
        digits(&head)? * 10_i64.pow(3 - head.len() as u32)
    };
    // Howard Hinnant's `days_from_civil`.
    let y = y - i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + hh * 3600 + mm * 60 + ss - offset_minutes * 60) * 1000) + millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_wire_form() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso_ms("1970-01-01T00:00:01Z"), Some(1000));
        assert_eq!(
            parse_iso_ms("2026-11-13T08:49:41.123Z"),
            Some(1_794_559_781_123)
        );
        assert_eq!(
            parse_iso_ms("2026-11-13T09:49:41.123+01:00"),
            parse_iso_ms("2026-11-13T08:49:41.123Z")
        );
        assert_eq!(parse_iso_ms("not a time"), None);
        assert_eq!(parse_iso_ms("2026-13-01T00:00:00Z"), None);
    }

    #[test]
    fn agrees_with_now_iso() {
        let now = now_iso();
        let ms = parse_iso_ms(&now).unwrap();
        assert_eq!(ms.rem_euclid(1000), now[20..23].parse::<i64>().unwrap());
    }
}
