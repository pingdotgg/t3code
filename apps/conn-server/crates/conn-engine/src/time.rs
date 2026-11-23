//! UTC timestamps in the contract's `DateTimeUtc` wire form: `2026-11-13T08:49:41.123Z`.

use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) use conn_support::time::{iso_from_millis, millis_from_iso};

use jiff::Timestamp;
use jiff::tz::{AmbiguousOffset, TimeZone};

/// Milliseconds since the epoch of a command's time string, as T3's `DateTime.make` reads it:
/// `Date.parse` after Effect's zone rule, a time without a zone in `zone`.
pub(crate) fn date_input_millis(text: &str, zone: &TimeZone) -> Option<i64> {
    conn_support::js_date::effect_date_time_make(text, |local| local_offset_ms(zone, local))
}

/// The offset of `zone` at a local time, in milliseconds, as V8 asks ICU for it
/// (`getOffsetFromLocal` with `UCAL_TZ_LOCAL_FORMER`): the offset in force before a gap or a
/// fold, so a skipped time lands after the gap and a repeated one at its first occurrence.
/// Outside jiff's
/// years the time moves by whole 400-year cycles, which repeat the calendar, to the nearest
/// end of that range: before a zone's first transition, or under its last rule, as in ICU.
/// 0 when the zone cannot answer, as V8 takes a failed ICU call.
pub(crate) fn local_offset_ms(zone: &TimeZone, local_ms: i64) -> i64 {
    const CYCLE_MS: i64 = 146_097 * 86_400_000;
    // About years -9000 and 9000, inside jiff's range with room for any offset.
    const LOW: i64 = -346_172_342_400_000;
    const HIGH: i64 = 221_845_392_000_000;
    let mut at = local_ms;
    if at > HIGH {
        at -= ((at - HIGH) / CYCLE_MS + 1) * CYCLE_MS;
    } else if at < LOW {
        at += ((LOW - at) / CYCLE_MS + 1) * CYCLE_MS;
    }
    let Ok(local) = Timestamp::from_millisecond(at).map(|ts| ts.to_zoned(TimeZone::UTC).datetime())
    else {
        return 0;
    };
    let offset = match zone.to_ambiguous_timestamp(local).offset() {
        AmbiguousOffset::Unambiguous { offset } => offset,
        AmbiguousOffset::Gap { before, .. } | AmbiguousOffset::Fold { before, .. } => before,
    };
    i64::from(offset.seconds()) * 1000
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
    use super::{TimeZone, date_input_millis};

    /// T3's `DateTime.make` in five zones on the strings of `tools/gen-date-cases.mjs`.
    #[test]
    fn date_input_matches_t3s() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("date-cases.json")).expect("the cases parse");
        let zones: Vec<TimeZone> = cases["zones"]
            .as_array()
            .expect("zones")
            .iter()
            .map(|name| TimeZone::get(name.as_str().expect("a name")).expect("the zone exists"))
            .collect();
        let mut wrong = vec![];
        let mut count = 0;
        for case in cases["cases"].as_array().expect("cases") {
            let input = case[0].as_str().expect("a string");
            for (z, zone) in zones.iter().enumerate() {
                count += 1;
                let expected = case[1][z].as_i64();
                let got = date_input_millis(input, zone);
                if got != expected {
                    wrong.push(format!(
                        "{input:?} in {}: T3 {expected:?}, here {got:?}",
                        cases["zones"][z]
                    ));
                }
            }
        }
        assert!(
            wrong.is_empty(),
            "{} of {count} differ:\n{}",
            wrong.len(),
            wrong
                .iter()
                .take(40)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
}
