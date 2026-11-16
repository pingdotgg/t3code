//! Contract time helpers shared with the other crates.

pub(crate) use conn_support::time::{millis_from_iso as parse_iso_ms, now_iso};

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
