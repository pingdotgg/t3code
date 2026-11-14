//! When a scheduled task runs next, from `apps/server/src/scheduledTasks/Schedule.ts`, and
//! the contract's checks on a saved schedule (`packages/contracts/src/scheduledTask.ts`).
//!
//! Times are milliseconds since the epoch. Fixed times use the server's time zone, as the
//! T3 server uses its process's local zone.

use conn_contract::{
    ScheduledTaskSchedule, ScheduledTaskScheduleFixedTime, ScheduledTaskScheduleInterval,
    ScheduledTaskScheduleOnce,
};
use jiff::{Timestamp, tz::TimeZone};
use serde_json::Value;

/// `MIN_SCHEDULED_TASK_INTERVAL_MS`.
pub const MIN_INTERVAL_MS: i64 = 60_000;
/// `MISSED_FIXED_TIME_GRACE_MS`: a fixed-time run more than this late was missed.
const MISSED_FIXED_TIME_GRACE_MS: i64 = 10 * 60_000;
/// JavaScript's `Date` range: ±8.64e15 ms. A time outside it has no next run.
const JS_DATE_LIMIT_MS: i64 = 8_640_000_000_000_000;

/// `parseTimeOfDay`: `H:MM` or `HH:MM`, after trimming.
pub fn parse_time_of_day(value: &str) -> Option<(i8, i8)> {
    let (hour, minute) = value.trim().split_once(':')?;
    let all_digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !(all_digits(hour) && all_digits(minute)) || hour.len() > 2 || minute.len() != 2 {
        return None;
    }
    let hour: i8 = hour.parse().ok()?;
    let minute: i8 = minute.parse().ok()?;
    ((0..24).contains(&hour) && (0..60).contains(&minute)).then_some((hour, minute))
}

/// `nextScheduledRunAt`: the first run strictly after `from`, or `None`.
pub fn next_run_at(schedule: &ScheduledTaskSchedule, from: i64, zone: &TimeZone) -> Option<i64> {
    let next = match schedule {
        ScheduledTaskSchedule::Webhook(_) => None,
        ScheduledTaskSchedule::Once(once) => parse_iso(&once.run_at).filter(|at| *at > from),
        // Intervals advance elapsed time, also across daylight-saving changes.
        ScheduledTaskSchedule::Interval(interval) => {
            from.checked_add(interval.every_ms.max(MIN_INTERVAL_MS))
        }
        ScheduledTaskSchedule::FixedTime(fixed) => next_fixed_time(fixed, from, zone),
    }?;
    (-JS_DATE_LIMIT_MS..=JS_DATE_LIMIT_MS)
        .contains(&next)
        .then_some(next)
}

/// The same local wall time on each of the next eight days, the first after `from` on an
/// allowed weekday. A time a daylight-saving gap skips moves forward, as JavaScript does.
fn next_fixed_time(
    fixed: &ScheduledTaskScheduleFixedTime,
    from: i64,
    zone: &TimeZone,
) -> Option<i64> {
    let (hour, minute) = parse_time_of_day(&fixed.time_of_day)?;
    let weekdays: Option<&[i64]> = fixed.weekdays.as_deref().filter(|w| !w.is_empty());
    let start = Timestamp::from_millisecond(from)
        .ok()?
        .to_zoned(zone.clone());
    for offset in 0..=7_i64 {
        let day = start
            .date()
            .checked_add(jiff::Span::new().days(offset))
            .ok()?;
        let local = day.at(hour, minute, 0, 0);
        let candidate = zone.to_ambiguous_zoned(local).compatible().ok()?;
        let at = candidate.timestamp().as_millisecond();
        if at <= from {
            continue;
        }
        let weekday = i64::from(candidate.weekday().to_sunday_zero_offset());
        if weekdays.is_some_and(|days| !days.contains(&weekday)) {
            continue;
        }
        return Some(at);
    }
    None
}

/// `weekdayKey`: every day and no days are the same schedule.
fn weekday_key(weekdays: Option<&[i64]>) -> Vec<i64> {
    let mut unique: Vec<i64> = weekdays.unwrap_or_default().to_vec();
    unique.sort_unstable();
    unique.dedup();
    if unique.len() == 7 {
        unique.clear();
    }
    unique
}

/// `isSameSchedule`: compared by meaning, so a padded hour or a reordered weekday list is
/// not a change.
pub fn is_same_schedule(a: &ScheduledTaskSchedule, b: &ScheduledTaskSchedule) -> bool {
    match (a, b) {
        (ScheduledTaskSchedule::Interval(a), ScheduledTaskSchedule::Interval(b)) => {
            a.every_ms == b.every_ms
        }
        (ScheduledTaskSchedule::Webhook(_), ScheduledTaskSchedule::Webhook(_)) => true,
        (ScheduledTaskSchedule::Once(a), ScheduledTaskSchedule::Once(b)) => {
            parse_iso(&a.run_at) == parse_iso(&b.run_at)
        }
        (ScheduledTaskSchedule::FixedTime(a), ScheduledTaskSchedule::FixedTime(b)) => {
            let (Some(at), Some(bt)) = (
                parse_time_of_day(&a.time_of_day),
                parse_time_of_day(&b.time_of_day),
            ) else {
                return false;
            };
            at == bt && weekday_key(a.weekdays.as_deref()) == weekday_key(b.weekdays.as_deref())
        }
        _ => false,
    }
}

/// `isMissedFixedTimeRun`: only fixed times are skipped when late; intervals and one-time
/// runs still run.
pub fn is_missed_fixed_time_run(schedule: &ScheduledTaskSchedule, due: i64, now: i64) -> bool {
    matches!(schedule, ScheduledTaskSchedule::FixedTime(_))
        && now.saturating_sub(due) > MISSED_FIXED_TIME_GRACE_MS
}

/// `DateTime.formatIso(DateTime.toUtc(..))`, as `Date.prototype.toISOString`: a year past
/// 9999 or before 0 takes six digits and a sign.
pub fn format_iso(ms: i64) -> String {
    let text = conn_support::time::iso_from_millis(ms);
    let year_end = text.find('-').unwrap_or(0);
    let year_text = text.get(..year_end).unwrap_or_default();
    match year_text.parse::<i64>() {
        Ok(year) if (0..=9999).contains(&year) && year_text.len() == 4 => text,
        Ok(year) => {
            let rest = text.get(year_end..).unwrap_or_default();
            let sign = if year < 0 { '-' } else { '+' };
            format!("{sign}{:06}{rest}", year.abs())
        }
        Err(_) => text,
    }
}

/// `DateTime.make` of a stored or given time: RFC 3339 with `Z` or an offset, and the
/// six-digit signed years [`format_iso`] writes. `None` when it does not parse.
pub fn parse_iso(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    match bytes.first() {
        Some(sign @ (b'+' | b'-')) => {
            // `+YYYYYY-MM-DD...`: shift the year into four digits, parse, shift back.
            let year: i64 = text.get(1..7)?.parse().ok()?;
            let year = if *sign == b'-' { -year } else { year };
            let rest = text.get(7..)?;
            // 2000 shares the leap rule's 400-year cycle, which is 146,097 days long.
            let cycles = (year - 2000).div_euclid(400);
            let shifted = year - cycles * 400;
            let base = conn_support::time::millis_from_iso(&format!("{shifted:04}{rest}"))?;
            base.checked_add(cycles.checked_mul(146_097 * 86_400_000)?)
        }
        _ => conn_support::time::millis_from_iso(text),
    }
}

/// Why a saved schedule is not valid, in the words a schema failure gives.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("{0}")]
pub struct ScheduleInvalid(pub String);

/// The contract's `ScheduledTaskUpsertSchedule` for the three timed kinds, with its checks:
/// an interval of at least a minute, an `HH:MM` time and weekdays 0 to 6, a one-time run as
/// an ISO time with an offset in years 0 to 9999. Strings are trimmed, as `TrimmedString`
/// decodes. A webhook schedule is the caller's to refuse; this answers `Ok(None)` for it.
pub fn decode_upsert_schedule(
    value: &Value,
) -> Result<Option<ScheduledTaskSchedule>, ScheduleInvalid> {
    let invalid = |what: &str| ScheduleInvalid(format!("Invalid schedule: {what}"));
    let kind = value.get("type").and_then(Value::as_str);
    match kind {
        Some("webhook") => Ok(None),
        Some("interval") => {
            let every = value
                .get("everyMs")
                .and_then(Value::as_i64)
                .ok_or_else(|| invalid("everyMs must be an integer"))?;
            if every < MIN_INTERVAL_MS {
                return Err(invalid("everyMs must be at least 60000"));
            }
            Ok(Some(ScheduledTaskSchedule::Interval(
                ScheduledTaskScheduleInterval {
                    r#type: Default::default(),
                    every_ms: every,
                },
            )))
        }
        Some("fixed_time") => {
            let time = value
                .get("timeOfDay")
                .and_then(Value::as_str)
                .map(str::trim)
                .ok_or_else(|| invalid("timeOfDay must be a string"))?;
            if parse_time_of_day(time).is_none() {
                return Err(invalid("timeOfDay must be HH:MM"));
            }
            let weekdays = match value.get("weekdays") {
                None => None,
                Some(Value::Array(days)) => {
                    let mut out = Vec::with_capacity(days.len().min(7));
                    for day in days {
                        match day.as_i64() {
                            Some(day) if (0..=6).contains(&day) => out.push(day),
                            _ => return Err(invalid("weekdays must be integers from 0 to 6")),
                        }
                    }
                    Some(out)
                }
                Some(_) => return Err(invalid("weekdays must be an array")),
            };
            Ok(Some(ScheduledTaskSchedule::FixedTime(
                ScheduledTaskScheduleFixedTime {
                    r#type: Default::default(),
                    time_of_day: time.to_owned(),
                    weekdays,
                },
            )))
        }
        Some("once") => {
            let run_at = value
                .get("runAt")
                .and_then(Value::as_str)
                .map(str::trim)
                .ok_or_else(|| invalid("runAt must be a string"))?;
            let at = iso_with_offset_millis(run_at).ok_or_else(|| {
                ScheduleInvalid("Expected an ISO date and time with an offset.".into())
            })?;
            // The server stores UTC.
            Ok(Some(ScheduledTaskSchedule::Once(
                ScheduledTaskScheduleOnce {
                    r#type: Default::default(),
                    run_at: format_iso(at),
                },
            )))
        }
        _ => Err(invalid("unknown type")),
    }
}

/// `isIsoWithOffset`: `YYYY-MM-DDTHH:MM[:SS[.fff]]` with `Z` or `±HH:MM`, a real day, and a
/// UTC time in years 0 to 9999. Answers the time, or `None` when the value fails the check.
fn iso_with_offset_millis(value: &str) -> Option<i64> {
    let ms = check_iso_with_offset(value)?;
    // 0000-01-01 to before 10000-01-01, UTC.
    (-62_167_219_200_000..253_402_300_800_000)
        .contains(&ms)
        .then_some(ms)
}

fn check_iso_with_offset(value: &str) -> Option<i64> {
    let b = value.as_bytes();
    let digit = |i: usize| b.get(i).is_some_and(u8::is_ascii_digit);
    let at = |i: usize, c: u8| b.get(i) == Some(&c);
    let date_ok = (0..4).all(digit) && at(4, b'-') && digit(5) && digit(6) && at(7, b'-');
    let time_ok = digit(8) && digit(9) && at(10, b'T') && digit(11) && digit(12) && at(13, b':');
    if !(date_ok && time_ok && digit(14) && digit(15)) {
        return None;
    }
    let hour = value.get(11..13).and_then(|h| h.parse::<u8>().ok());
    let minute = value.get(14..16).and_then(|m| m.parse::<u8>().ok());
    if !(hour.is_some_and(|h| h < 24) && minute.is_some_and(|m| m < 60)) {
        return None;
    }
    let mut i = 16;
    if at(i, b':') {
        if !(digit(i + 1) && digit(i + 2)) {
            return None;
        }
        if value
            .get(i + 1..i + 3)
            .and_then(|s| s.parse::<u8>().ok())
            .is_none_or(|s| s > 59)
        {
            return None;
        }
        i += 3;
        if at(i, b'.') {
            let start = i + 1;
            i = start;
            while digit(i) {
                i += 1;
            }
            if i == start {
                return None;
            }
        }
    }
    let offset_ok = match b.get(i..) {
        Some(b"Z") => true,
        Some([b'+' | b'-', h1, h2, b':', m1, m2]) => {
            [h1, h2, m1, m2].iter().all(|c| c.is_ascii_digit())
        }
        _ => false,
    };
    if !offset_ok {
        return None;
    }
    // Seconds are optional in the pattern; add them so the shared parser reads the value.
    let normalized = if at(16, b':') {
        value.to_owned()
    } else {
        format!(
            "{}:00{}",
            value.get(..16).unwrap_or_default(),
            value.get(16..).unwrap_or_default()
        )
    };
    conn_support::time::millis_from_iso(&normalized)
}

#[cfg(test)]
mod tests;
