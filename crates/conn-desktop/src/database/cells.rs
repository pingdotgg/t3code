//! Cells the panel can show (`cell` in Conn's `database.ts`): strings, numbers, booleans or
//! null. Dates become text, binary becomes hex, big numbers become text, and structured values
//! (JSON, arrays) become JSON text.
//!
//! The values follow what Conn's Node drivers return: `mysql2` with `dateStrings` and
//! `bigNumberStrings`, `postgres` (dates as ISO text, `int8` and `numeric` as text), and
//! `node:sqlite`.

use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use serde_json::Value;
use sqlx::mysql::MySqlRow;
use sqlx::mysql::types::MySqlTime;
use sqlx::postgres::PgRow;
use sqlx::postgres::types::PgInterval;
use sqlx::sqlite::SqliteRow;
use sqlx::types::{BigDecimal, JsonValue, Uuid};
use sqlx::{Row, TypeInfo, ValueRef};

/// The largest integer a JavaScript number holds exactly.
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// Binary as `0x…`: the first 64 bytes, then the full length when there is more.
pub(crate) fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(2 + 128 + 24);
    out.push_str("0x");
    for byte in bytes.iter().take(64) {
        let _ = write!(out, "{byte:02x}");
    }
    if bytes.len() > 64 {
        let _ = write!(out, "… ({} bytes)", bytes.len());
    }
    out
}

/// Text when the bytes are UTF-8, else hex.
fn text_or_hex(bytes: &[u8]) -> Value {
    match std::str::from_utf8(bytes) {
        Ok(text) => Value::String(text.to_owned()),
        Err(_) => Value::String(hex(bytes)),
    }
}

fn number(value: f64) -> Value {
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}

/// A 4-byte float as JavaScript reads its text: `1.1`, not `1.100000023841858`.
fn float32(value: f32) -> Value {
    value.to_string().parse::<f64>().map_or(Value::Null, number)
}

fn integer(value: i64) -> Value {
    if value.abs() <= MAX_SAFE_INTEGER {
        Value::from(value)
    } else {
        Value::String(value.to_string())
    }
}

/// JSON text, as `JSON.stringify` writes it.
fn json_text(value: &JsonValue) -> Value {
    Value::String(value.to_string())
}

/// A JavaScript `Date` as `toISOString` writes it.
fn iso(value: NaiveDateTime) -> Value {
    Value::String(value.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

/// `1 year 2 mons 3 days 04:05:06`, PostgreSQL's default interval text.
pub(crate) fn interval_text(interval: &PgInterval) -> String {
    fn unit(parts: &mut Vec<String>, count: i64, singular: &str, plural: &str) {
        if count != 0 {
            let word = if count.abs() == 1 { singular } else { plural };
            parts.push(format!("{count} {word}"));
        }
    }
    let mut parts = Vec::new();
    unit(&mut parts, i64::from(interval.months / 12), "year", "years");
    unit(&mut parts, i64::from(interval.months % 12), "mon", "mons");
    unit(&mut parts, i64::from(interval.days), "day", "days");
    if interval.microseconds != 0 || parts.is_empty() {
        let sign = if interval.microseconds < 0 { "-" } else { "" };
        let micros = interval.microseconds.unsigned_abs();
        let seconds = micros / 1_000_000;
        let fraction = micros % 1_000_000;
        let mut time = format!(
            "{sign}{:02}:{:02}:{:02}",
            seconds / 3600,
            seconds / 60 % 60,
            seconds % 60
        );
        if fraction != 0 {
            let digits = format!("{fraction:06}");
            time.push('.');
            time.push_str(digits.trim_end_matches('0'));
        }
        parts.push(time);
    }
    parts.join(" ")
}

fn array<T>(items: Vec<Option<T>>, convert: impl Fn(T) -> Value) -> Value {
    let values: Vec<Value> = items
        .into_iter()
        .map(|item| item.map_or(Value::Null, &convert))
        .collect();
    Value::String(Value::Array(values).to_string())
}

// ─── MySQL / MariaDB ─────────────────────────────────────────────────────────

/// The cell at `index`, as `mysql2` with `dateStrings` and `bigNumberStrings` returns it.
pub(crate) fn mysql_cell(row: &MySqlRow, index: usize) -> Value {
    let Ok(raw) = row.try_get_raw(index) else {
        return Value::Null;
    };
    if raw.is_null() {
        return Value::Null;
    }
    let type_name = raw.type_info().name().to_owned();
    let decoded = match type_name.as_str() {
        "BOOLEAN" | "TINYINT" | "SMALLINT" | "INT" | "MEDIUMINT" | "YEAR" => {
            row.try_get_unchecked::<i64, _>(index).ok().map(integer)
        }
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "INT UNSIGNED" | "MEDIUMINT UNSIGNED" => row
            .try_get_unchecked::<u64, _>(index)
            .ok()
            .map(|value| i64::try_from(value).map_or(Value::String(value.to_string()), integer)),
        "BIGINT" => row
            .try_get_unchecked::<i64, _>(index)
            .ok()
            .map(|value| Value::String(value.to_string())),
        "BIGINT UNSIGNED" => row
            .try_get_unchecked::<u64, _>(index)
            .ok()
            .map(|value| Value::String(value.to_string())),
        "FLOAT" => row.try_get_unchecked::<f32, _>(index).ok().map(float32),
        "DOUBLE" => row.try_get_unchecked::<f64, _>(index).ok().map(number),
        "DATE" => Some(
            row.try_get_unchecked::<NaiveDate, _>(index)
                .map_or_else(|_| "0000-00-00".to_owned(), |date| date.to_string())
                .into(),
        ),
        "DATETIME" | "TIMESTAMP" => Some(
            row.try_get_unchecked::<NaiveDateTime, _>(index)
                .map_or_else(
                    |_| "0000-00-00 00:00:00".to_owned(),
                    |value| value.format("%Y-%m-%d %H:%M:%S%.f").to_string(),
                )
                .into(),
        ),
        "TIME" => row
            .try_get_unchecked::<MySqlTime, _>(index)
            .ok()
            .map(|time| Value::String(time.to_string())),
        "JSON" => row
            .try_get_unchecked::<JsonValue, _>(index)
            .ok()
            .map(|value| json_text(&value)),
        "BIT" | "GEOMETRY" => row
            .try_get_unchecked::<Vec<u8>, _>(index)
            .ok()
            .map(|bytes| Value::String(hex(&bytes))),
        name if name.contains("BINARY") || name.contains("BLOB") => row
            .try_get_unchecked::<Vec<u8>, _>(index)
            .ok()
            .map(|bytes| Value::String(hex(&bytes))),
        _ => None,
    };
    decoded.unwrap_or_else(|| {
        row.try_get_unchecked::<Vec<u8>, _>(index)
            .map_or(Value::Null, |bytes| text_or_hex(&bytes))
    })
}

// ─── PostgreSQL ──────────────────────────────────────────────────────────────

/// The cell at `index`, as the `postgres` package returns it.
pub(crate) fn postgres_cell(row: &PgRow, index: usize) -> Value {
    let Ok(raw) = row.try_get_raw(index) else {
        return Value::Null;
    };
    if raw.is_null() {
        return Value::Null;
    }
    let type_name = raw.type_info().name().to_owned();
    let decoded = match type_name.as_str() {
        "BOOL" => row
            .try_get_unchecked::<bool, _>(index)
            .ok()
            .map(Value::Bool),
        "INT2" => row
            .try_get_unchecked::<i16, _>(index)
            .ok()
            .map(|value| Value::from(i64::from(value))),
        "INT4" => row
            .try_get_unchecked::<i32, _>(index)
            .ok()
            .map(|value| Value::from(i64::from(value))),
        "OID" => row
            .try_get_unchecked::<Vec<u8>, _>(index)
            .ok()
            .and_then(|bytes| <[u8; 4]>::try_from(bytes.as_slice()).ok())
            .map(|bytes| Value::from(u32::from_be_bytes(bytes))),
        "INT8" => row
            .try_get_unchecked::<i64, _>(index)
            .ok()
            .map(|value| Value::String(value.to_string())),
        "FLOAT4" => row.try_get_unchecked::<f32, _>(index).ok().map(float32),
        "FLOAT8" => row.try_get_unchecked::<f64, _>(index).ok().map(number),
        "NUMERIC" => Some(Value::String(
            row.try_get_unchecked::<BigDecimal, _>(index)
                .map_or_else(|_| "NaN".to_owned(), |value| value.to_plain_string()),
        )),
        "UUID" => row
            .try_get_unchecked::<Uuid, _>(index)
            .ok()
            .map(|value| Value::String(value.to_string())),
        "JSON" | "JSONB" => row
            .try_get_unchecked::<JsonValue, _>(index)
            .ok()
            .map(|value| json_text(&value)),
        "BYTEA" => row
            .try_get_unchecked::<Vec<u8>, _>(index)
            .ok()
            .map(|bytes| Value::String(hex(&bytes))),
        "DATE" => row
            .try_get_unchecked::<NaiveDate, _>(index)
            .ok()
            .map(|date| iso(date.and_time(NaiveTime::MIN))),
        "TIMESTAMP" => row
            .try_get_unchecked::<NaiveDateTime, _>(index)
            .ok()
            .map(iso),
        "TIMESTAMPTZ" => row
            .try_get_unchecked::<DateTime<Utc>, _>(index)
            .ok()
            .map(|value| iso(value.naive_utc())),
        "TIME" => row
            .try_get_unchecked::<NaiveTime, _>(index)
            .ok()
            .map(|time| Value::String(time.format("%H:%M:%S%.f").to_string())),
        "INTERVAL" => row
            .try_get_unchecked::<PgInterval, _>(index)
            .ok()
            .map(|interval| Value::String(interval_text(&interval))),
        "TEXT[]" | "VARCHAR[]" | "CHAR[]" | "NAME[]" => row
            .try_get_unchecked::<Vec<Option<String>>, _>(index)
            .ok()
            .map(|items| array(items, Value::String)),
        "INT2[]" => row
            .try_get_unchecked::<Vec<Option<i16>>, _>(index)
            .ok()
            .map(|items| array(items, |item| Value::from(i64::from(item)))),
        "INT4[]" => row
            .try_get_unchecked::<Vec<Option<i32>>, _>(index)
            .ok()
            .map(|items| array(items, |item| Value::from(i64::from(item)))),
        "INT8[]" => row
            .try_get_unchecked::<Vec<Option<i64>>, _>(index)
            .ok()
            .map(|items| array(items, |item| Value::String(item.to_string()))),
        "BOOL[]" => row
            .try_get_unchecked::<Vec<Option<bool>>, _>(index)
            .ok()
            .map(|items| array(items, Value::Bool)),
        "FLOAT8[]" => row
            .try_get_unchecked::<Vec<Option<f64>>, _>(index)
            .ok()
            .map(|items| array(items, number)),
        "UUID[]" => row
            .try_get_unchecked::<Vec<Option<Uuid>>, _>(index)
            .ok()
            .map(|items| array(items, |item| Value::String(item.to_string()))),
        _ => None,
    };
    // Text-like types (text, varchar, enums, citext, xml, …) are UTF-8 in binary format too.
    decoded.unwrap_or_else(|| {
        row.try_get_unchecked::<Vec<u8>, _>(index)
            .map_or(Value::Null, |bytes| text_or_hex(&bytes))
    })
}

// ─── SQLite ──────────────────────────────────────────────────────────────────

/// The cell at `index`, by the value's own storage class, as `node:sqlite` returns it.
pub(crate) fn sqlite_cell(row: &SqliteRow, index: usize) -> Value {
    let Ok(raw) = row.try_get_raw(index) else {
        return Value::Null;
    };
    if raw.is_null() {
        return Value::Null;
    }
    let type_name = raw.type_info().name().to_owned();
    match type_name.as_str() {
        "INTEGER" => row
            .try_get_unchecked::<i64, _>(index)
            .map_or(Value::Null, integer),
        "REAL" => row
            .try_get_unchecked::<f64, _>(index)
            .map_or(Value::Null, number),
        "BLOB" => row
            .try_get_unchecked::<Vec<u8>, _>(index)
            .map_or(Value::Null, |bytes| Value::String(hex(&bytes))),
        _ => row
            .try_get_unchecked::<String, _>(index)
            .map_or(Value::Null, Value::String),
    }
}

/// The text of a catalog cell, `""` for null (`text` in `database.ts`).
pub(crate) fn text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests assert and use ? for setup"
)]
mod tests {
    use super::*;

    #[test]
    fn binary_is_hex_with_length_past_64_bytes() {
        assert_eq!(hex(&[0xde, 0xad]), "0xdead");
        let long = vec![0u8; 70];
        let shown = hex(&long);
        assert!(shown.ends_with("… (70 bytes)"), "{shown}");
        assert_eq!(shown.len(), 2 + 128 + "… (70 bytes)".len());
    }

    #[test]
    fn numbers_follow_javascript() {
        assert_eq!(float32(1.1), Value::from(1.1));
        assert_eq!(integer(42), Value::from(42));
        assert_eq!(integer(1 << 60), Value::String((1i64 << 60).to_string()));
        assert_eq!(number(f64::NAN), Value::Null);
    }

    #[test]
    fn intervals_read_like_postgres() {
        let interval = |months, days, microseconds| PgInterval {
            months,
            days,
            microseconds,
        };
        assert_eq!(
            interval_text(&interval(14, 3, 14_706_000_000)),
            "1 year 2 mons 3 days 04:05:06"
        );
        assert_eq!(interval_text(&interval(0, 1, 0)), "1 day");
        assert_eq!(interval_text(&interval(0, 0, 0)), "00:00:00");
        assert_eq!(interval_text(&interval(0, 0, -1_500_000)), "-00:00:01.5");
    }

    #[test]
    fn dates_read_like_to_iso_string() -> Result<(), String> {
        let date = NaiveDate::from_ymd_opt(2024, 1, 2).ok_or("date")?;
        assert_eq!(
            iso(date.and_time(NaiveTime::MIN)),
            Value::String("2024-01-02T00:00:00.000Z".into())
        );
        Ok(())
    }
}
