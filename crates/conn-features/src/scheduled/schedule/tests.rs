//! Cases from `apps/server/src/scheduledTasks/Schedule.test.ts`, and the schedule cases of
//! `ScheduledTaskService.interval.test.ts` at the level of the rule itself.

use super::{
    decode_upsert_schedule, format_iso, is_missed_fixed_time_run, is_same_schedule, next_run_at,
    parse_iso,
};
use conn_contract::{ScheduledTaskSchedule, from_json};
use jiff::tz::TimeZone;
use serde_json::json;

fn schedule(value: serde_json::Value) -> ScheduledTaskSchedule {
    from_json(value).expect("schedule")
}

fn zone(name: &str) -> TimeZone {
    TimeZone::get(name).expect("the system has this zone")
}

fn ms(text: &str) -> i64 {
    parse_iso(text).expect("time")
}

#[test]
fn skips_to_the_next_matching_fixed_time_weekday() {
    // Friday 2026-07-03 10:00 in Los Angeles.
    let la = zone("America/Los_Angeles");
    let from = ms("2026-07-03T10:00:00-07:00");
    let next = next_run_at(
        &schedule(json!({"type": "fixed_time", "timeOfDay": "09:00", "weekdays": [1, 2, 3, 4, 5]})),
        from,
        &la,
    )
    .expect("a next run");
    let local = jiff::Timestamp::from_millisecond(next)
        .expect("ts")
        .to_zoned(la);
    assert_eq!(local.weekday().to_sunday_zero_offset(), 1, "Monday");
    assert_eq!((local.hour(), local.minute()), (9, 0), "09:00 local");
}

#[test]
fn compares_schedules_structurally() {
    let same = |a, b| is_same_schedule(&schedule(a), &schedule(b));
    assert!(
        same(
            json!({"type": "once", "runAt": "2026-11-01T03:00:00-05:00"}),
            json!({"type": "once", "runAt": "2026-11-01T08:00:00.000Z"}),
        ),
        "one instant, two offsets"
    );
    assert!(
        same(
            json!({"type": "interval", "everyMs": 60_000}),
            json!({"type": "interval", "everyMs": 60_000}),
        ),
        "equal intervals"
    );
    assert!(
        !same(
            json!({"type": "interval", "everyMs": 60_000}),
            json!({"type": "interval", "everyMs": 30_000}),
        ),
        "different intervals"
    );
    assert!(
        same(
            json!({"type": "fixed_time", "timeOfDay": "09:00", "weekdays": [1, 2]}),
            json!({"type": "fixed_time", "timeOfDay": "09:00", "weekdays": [1, 2]}),
        ),
        "equal weekdays"
    );
    assert!(
        same(
            json!({"type": "fixed_time", "timeOfDay": "09:00", "weekdays": [5, 1]}),
            json!({"type": "fixed_time", "timeOfDay": "09:00", "weekdays": [1, 5, 5]}),
        ),
        "order and repeats do not count"
    );
    assert!(
        same(
            json!({"type": "fixed_time", "timeOfDay": "09:00"}),
            json!({"type": "fixed_time", "timeOfDay": "09:00", "weekdays": [0, 1, 2, 3, 4, 5, 6]}),
        ),
        "all days is daily"
    );
    assert!(
        same(
            json!({"type": "fixed_time", "timeOfDay": "09:00", "weekdays": []}),
            json!({"type": "fixed_time", "timeOfDay": "09:00"}),
        ),
        "no days is daily"
    );
    assert!(
        !same(
            json!({"type": "fixed_time", "timeOfDay": "09:00", "weekdays": [1, 2]}),
            json!({"type": "fixed_time", "timeOfDay": "09:00", "weekdays": [1, 3]}),
        ),
        "other weekdays"
    );
    assert!(
        !same(
            json!({"type": "fixed_time", "timeOfDay": "09:00"}),
            json!({"type": "fixed_time", "timeOfDay": "09:30"}),
        ),
        "other time"
    );
    assert!(
        !same(
            json!({"type": "interval", "everyMs": 60_000}),
            json!({"type": "fixed_time", "timeOfDay": "09:00"}),
        ),
        "other kind"
    );
    assert!(
        same(
            json!({"type": "fixed_time", "timeOfDay": "9:00"}),
            json!({"type": "fixed_time", "timeOfDay": "09:00"}),
        ),
        "a padded hour is the same time"
    );
}

/// `persists elapsed interval $zone from $from`: intervals count elapsed time in every zone,
/// also across both daylight-saving changes.
#[test]
fn intervals_advance_elapsed_time_in_every_zone() {
    for (name, from, every, expected) in [
        (
            "America/New_York",
            "2026-03-08T06:30:00.000Z",
            7_200_000,
            "2026-03-08T08:30:00.000Z",
        ),
        (
            "America/New_York",
            "2026-11-01T05:30:00.000Z",
            7_200_000,
            "2026-11-01T07:30:00.000Z",
        ),
        (
            "America/New_York",
            "2026-11-01T06:30:00.000Z",
            60_000,
            "2026-11-01T06:31:00.000Z",
        ),
        (
            "UTC",
            "2026-11-01T06:30:00.000Z",
            60_000,
            "2026-11-01T06:31:00.000Z",
        ),
        (
            "Asia/Tokyo",
            "2026-03-08T06:30:00.000Z",
            7_200_000,
            "2026-03-08T08:30:00.000Z",
        ),
    ] {
        let next = next_run_at(
            &schedule(json!({"type": "interval", "everyMs": every})),
            ms(from),
            &zone(name),
        );
        assert_eq!(
            next.map(format_iso).as_deref(),
            Some(expected),
            "{name} from {from}"
        );
    }
}

/// `keeps fixed-time schedules on the local calendar from $from`.
#[test]
fn fixed_times_keep_the_local_calendar_across_daylight_saving() {
    let ny = zone("America/New_York");
    for (from, expected) in [
        ("2026-03-07T23:30:00.000Z", "2026-03-08T13:00:00.000Z"),
        ("2026-10-31T23:30:00.000Z", "2026-11-01T14:00:00.000Z"),
    ] {
        let next = next_run_at(
            &schedule(json!({"type": "fixed_time", "timeOfDay": "09:00"})),
            ms(from),
            &ny,
        );
        assert_eq!(
            next.map(format_iso).as_deref(),
            Some(expected),
            "from {from}"
        );
    }
}

#[test]
fn a_one_time_run_is_next_only_while_in_the_future() {
    let utc = zone("UTC");
    let once = schedule(json!({"type": "once", "runAt": "2026-11-01T08:00:00.000Z"}));
    let at = ms("2026-11-01T08:00:00.000Z");
    assert_eq!(next_run_at(&once, at - 1, &utc), Some(at), "before");
    assert_eq!(next_run_at(&once, at, &utc), None, "at the time");
}

/// `stuck-huge` and `due-huge`: an interval that leaves JavaScript's date range has no next
/// run; one that stays in it formats as `toISOString` does past year 9999.
#[test]
fn huge_intervals_end_or_format_extended_years() {
    let utc = zone("UTC");
    let from = ms("2026-09-09T12:00:00.000Z");
    let huge = schedule(json!({"type": "interval", "everyMs": 9_000_000_000_000_000_i64}));
    assert_eq!(next_run_at(&huge, from, &utc), None, "out of range");
    let far = next_run_at(
        &schedule(json!({"type": "interval", "everyMs": 3e14 as i64})),
        from,
        &utc,
    )
    .expect("in range");
    let text = format_iso(far);
    assert!(text.starts_with("+011533-"), "{text}");
    assert_eq!(parse_iso(&text), Some(far), "round trip");
}

#[test]
fn only_late_fixed_times_are_missed() {
    let fixed = schedule(json!({"type": "fixed_time", "timeOfDay": "09:00"}));
    let interval = schedule(json!({"type": "interval", "everyMs": 60_000}));
    assert!(
        !is_missed_fixed_time_run(&fixed, 0, 600_000),
        "ten minutes is in time"
    );
    assert!(
        is_missed_fixed_time_run(&fixed, 0, 600_001),
        "later is missed"
    );
    assert!(
        !is_missed_fixed_time_run(&interval, 0, 6_000_000),
        "intervals still run"
    );
}

/// The contract's schedule checks (`ScheduledTaskUpsertSchedule`).
#[test]
fn decodes_saved_schedules_with_the_contract_checks() {
    let ok = |v| decode_upsert_schedule(&v).expect("valid").expect("timed");
    let bad = |v| decode_upsert_schedule(&v).expect_err("invalid");
    assert_eq!(
        ok(json!({"type": "once", "runAt": " 2026-11-01T03:00:00-05:00 "})),
        schedule(json!({"type": "once", "runAt": "2026-11-01T08:00:00.000Z"})),
        "stored as UTC, trimmed"
    );
    assert_eq!(
        ok(json!({"type": "once", "runAt": "2026-11-01T03:00-05:00"})),
        schedule(json!({"type": "once", "runAt": "2026-11-01T08:00:00.000Z"})),
        "seconds are optional"
    );
    ok(json!({"type": "fixed_time", "timeOfDay": "9:00", "weekdays": [0, 6]}));
    ok(json!({"type": "interval", "everyMs": 60_000}));
    bad(json!({"type": "interval", "everyMs": 59_999}));
    bad(json!({"type": "interval", "everyMs": 60_000.5}));
    bad(json!({"type": "fixed_time", "timeOfDay": "24:00"}));
    bad(json!({"type": "fixed_time", "timeOfDay": "9:0"}));
    bad(json!({"type": "fixed_time", "timeOfDay": "09:00", "weekdays": [7]}));
    for run_at in [
        "2026-02-30T08:00:00Z",
        "2026-11-01T08:00:00",
        "2026-11-01 08:00:00Z",
        "10000-01-01T00:00:00Z",
        "2026-11-01T08:00:00+0500",
    ] {
        bad(json!({"type": "once", "runAt": run_at}));
    }
    assert_eq!(
        decode_upsert_schedule(&json!({"type": "webhook", "signature": null})),
        Ok(None),
        "webhooks are the caller's to refuse"
    );
}
