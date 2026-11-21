//! The Laravel Toolbar data an API response carries, and the formatting the panel shares with
//! the toolbar.
//!
//! Ports of Conn's `packages/shared/src/laravelToolbarHeaders.ts`,
//! `apps/web/src/laravelToolbar/headers.ts`, the API-panel parts of
//! `apps/web/src/laravelToolbar/model.ts` (`rowFromData`, `formatMs`, `formatBytes`,
//! `formatCount`) and the toolbar plumbing in `apps/web/src/api/ApiPanel.tsx`.
//!
//! nckrtl/laravel-toolbar and php-data-bridge send `x-toolbar` (a base64 JSON payload) or, when
//! the payload is too big for a header, `x-toolbar-summary` (base64
//! `{ request_id, history_row }`); the full payload then comes from `/_toolbar/requests/{id}`.
//! The payload stays a JSON object here: the toolbar reads many optional parts of it.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{ApiHeader, ApiRequest, ApiResponse};
use crate::api_request::store::ApiRequestDraft;

/// A toolbar payload (`ToolbarData`), as JSON.
pub type ToolbarData = Map<String, Value>;

/// A request as the toolbar's history lists it (`ToolbarHistoryRow`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolbarHistoryRow {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_xhr: Option<bool>,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_type: Option<String>,
    /// `redirect`: the next hop of a redirect; `partial`: a partial reload (deferred props).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow_up: Option<String>,
}

impl ToolbarHistoryRow {
    /// Reads a row from JSON; `None` when it has no string `id` or has wrongly typed fields.
    pub fn from_json(value: &Value) -> Option<Self> {
        if !value.get("id").is_some_and(Value::is_string) {
            return None;
        }
        Self::deserialize(value).ok()
    }
}

/// What a response's toolbar headers hold.
#[derive(Debug, Clone, PartialEq)]
pub enum ToolbarHeaderPayload {
    /// The whole payload; it has a string `request_id`.
    Full { data: ToolbarData },
    /// Too big for a header: the id to fetch, with its history row when usable.
    Summary {
        id: String,
        row: Option<ToolbarHistoryRow>,
    },
}

fn decode_base64_json(value: &str) -> Option<ToolbarData> {
    // The servers may send URL-safe base64 without padding.
    // `atob` skips ASCII whitespace, takes missing padding and ignores stray trailing bits.
    const LENIENT: base64::engine::GeneralPurpose = base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    let normalized: String = value
        .chars()
        .filter(|char| !char.is_ascii_whitespace())
        .map(|char| match char {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    let bytes = LENIENT.decode(normalized).ok()?;
    // Invalid UTF-8 is rejected, not replaced.
    let text = std::str::from_utf8(&bytes).ok()?;
    match serde_json::from_str(text).ok()? {
        Value::Object(object) => Some(object),
        _ => None,
    }
}

/// The toolbar data in the `x-toolbar` and `x-toolbar-summary` header values, or `None` when
/// there is none or only broken data. A full payload wins over a summary.
pub fn decode_toolbar_headers(
    full: Option<&str>,
    summary: Option<&str>,
) -> Option<ToolbarHeaderPayload> {
    let data = full
        .filter(|value| !value.is_empty())
        .and_then(decode_base64_json);
    if let Some(data) = data
        && data.get("request_id").is_some_and(Value::is_string)
    {
        return Some(ToolbarHeaderPayload::Full { data });
    }
    let decoded = summary
        .filter(|value| !value.is_empty())
        .and_then(decode_base64_json)?;
    let id = decoded.get("request_id")?.as_str()?.to_owned();
    let row = decoded
        .get("history_row")
        .filter(|row| row.is_object())
        .and_then(ToolbarHistoryRow::from_json);
    Some(ToolbarHeaderPayload::Summary { id, row })
}

/// The toolbar data a response carries, from headers in any case.
pub fn toolbar_payload_from_headers(headers: &[ApiHeader]) -> Option<ToolbarHeaderPayload> {
    let value = |name: &str| {
        headers
            .iter()
            .find(|header| header.name.eq_ignore_ascii_case(name))
            .map(|header| header.value.as_str())
    };
    decode_toolbar_headers(value("x-toolbar"), value("x-toolbar-summary"))
}

/// A history row for a summary that came without one: the request's method (upper-cased,
/// else GET) and its URL's path and query (else `/`).
pub fn minimal_toolbar_row(id: &str, method: Option<&str>, url: Option<&str>) -> ToolbarHistoryRow {
    let uri = url
        .and_then(|url| url::Url::parse(url).ok())
        .map(|url| match url.query() {
            Some(query) if !query.is_empty() => format!("{}?{query}", url.path()),
            _ => url.path().to_owned(),
        })
        .unwrap_or_else(|| "/".to_owned());
    let method = method
        .filter(|method| !method.is_empty())
        .map_or_else(|| "GET".to_owned(), str::to_ascii_uppercase);
    ToolbarHistoryRow {
        id: id.to_owned(),
        is_xhr: None,
        method,
        uri,
        name: None,
        action: None,
        status_code: None,
        size: None,
        duration: None,
        response_type: None,
        follow_up: None,
    }
}

fn path<'a>(data: &'a ToolbarData, keys: &[&str]) -> Option<&'a Value> {
    let (first, rest) = keys.split_first()?;
    rest.iter()
        .try_fold(data.get(*first)?, |value, key| value.get(key))
}

fn path_str<'a>(data: &'a ToolbarData, keys: &[&str]) -> Option<&'a str> {
    path(data, keys).and_then(Value::as_str)
}

/// Newer package versions send the response size as a measurement, older ones as text.
fn response_size(data: &ToolbarData) -> Option<String> {
    match path(data, &["response", "size"])? {
        Value::String(text) => Some(text.clone()),
        Value::Object(measurement) => measurement
            .get("formattedValue")
            .and_then(Value::as_str)
            .map(str::to_owned),
        _ => None,
    }
}

/// The history row for a full payload, when the response sent none.
pub fn row_from_data(data: &ToolbarData) -> Option<ToolbarHistoryRow> {
    if let Some(row) = data.get("history_row").filter(|row| row.is_object()) {
        return ToolbarHistoryRow::from_json(row);
    }
    let id = data
        .get("request_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())?;
    let owned = |keys: &[&str]| path_str(data, keys).map(str::to_owned);
    let is_inertia = path(data, &["request", "is_inertia"])
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(ToolbarHistoryRow {
        id: id.to_owned(),
        is_xhr: Some(false),
        method: owned(&["request", "method"]).unwrap_or_else(|| "GET".to_owned()),
        uri: owned(&["request", "uri"]).unwrap_or_else(|| "/".to_owned()),
        name: owned(&["request", "route_name"]),
        action: owned(&["request", "controller_action"]),
        status_code: path(data, &["response", "status_code"])
            .and_then(Value::as_u64)
            .and_then(|code| u16::try_from(code).ok()),
        size: response_size(data),
        duration: owned(&["profiler", "total_wall_time", "formattedValue"]),
        response_type: is_inertia.then(|| "Inertia".to_owned()),
        follow_up: None,
    })
}

/// What the API panel hands the toolbar bar after a response.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolbarReceipt {
    /// The toolbar request id.
    pub id: String,
    /// The origin that served it, where [`toolbar_details_request`] loads its full payload.
    pub origin: String,
    /// The bar's history row.
    pub row: ToolbarHistoryRow,
    /// The full payload, when the headers carried it.
    pub data: Option<ToolbarData>,
}

/// The toolbar data in a successful API response, ready for the bar (`receiveToolbarData`).
/// `None` when the response has none, its URL has no origin, or a full payload yields no row.
pub fn toolbar_receipt(
    request: &ApiRequestDraft,
    response: &ApiResponse,
) -> Option<ToolbarReceipt> {
    if response.error.is_some() {
        return None;
    }
    let payload = toolbar_payload_from_headers(&response.headers)?;
    let origin = url::Url::parse(&response.url)
        .ok()?
        .origin()
        .ascii_serialization();
    match payload {
        ToolbarHeaderPayload::Full { data } => {
            let row = row_from_data(&data)?;
            let id = data
                .get("request_id")
                .and_then(Value::as_str)
                .unwrap_or(&row.id)
                .to_owned();
            Some(ToolbarReceipt {
                id,
                origin,
                row,
                data: Some(data),
            })
        }
        ToolbarHeaderPayload::Summary { id, row } => {
            let row = row.unwrap_or_else(|| {
                let uri = url::Url::parse(&request.url)
                    .map(|url| url.path().to_owned())
                    .unwrap_or_else(|_| request.url.clone());
                ToolbarHistoryRow {
                    is_xhr: Some(true),
                    method: request.method.clone(),
                    uri,
                    ..minimal_toolbar_row(&id, None, None)
                }
            });
            Some(ToolbarReceipt {
                id,
                origin,
                row,
                data: None,
            })
        }
    }
}

/// `GET {origin}/_toolbar/requests/{id}`, which returns the full payload.
pub fn toolbar_details_request(origin: &str, id: &str) -> ApiRequest {
    ApiRequest {
        method: "GET".to_owned(),
        url: format!("{origin}/_toolbar/requests/{}", encode_uri_component(id)),
        headers: vec![
            ApiHeader::new("Accept", "application/json"),
            ApiHeader::new("X-Laravel-Toolbar-Internal", "true"),
        ],
        body: None,
        timeout_ms: None,
    }
}

/// The payload in a [`toolbar_details_request`] response: its `raw` object, else the body.
pub fn parse_toolbar_details(response: &ApiResponse) -> Option<ToolbarData> {
    if response.error.is_some() || !(200..300).contains(&response.status) {
        return None;
    }
    let mut parsed: Value = serde_json::from_str(&response.body).ok()?;
    let raw = match parsed.get_mut("raw") {
        Some(raw) if !raw.is_null() => raw.take(),
        _ => parsed,
    };
    match raw {
        Value::Object(object) => Some(object),
        _ => None,
    }
}

/// JavaScript's `encodeURIComponent`.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Rounds half away from zero on the exact value, as `toFixed` and `Intl.NumberFormat` do,
/// and writes `digits` decimals.
fn fixed(value: f64, digits: usize) -> String {
    let scale = 10f64.powi(i32::try_from(digits).unwrap_or(0));
    let scaled = value * scale;
    // A true tie (exactly representable): Rust's formatting would round it to even.
    if scaled.fract().abs() == 0.5 && scaled / scale == value {
        return format!("{:.digits$}", scaled.round() / scale);
    }
    format!("{value:.digits$}")
}

/// `Intl.NumberFormat("en-US")` with fixed decimals: grouped thousands.
fn format_number(value: f64, digits: usize) -> String {
    let text = fixed(value, digits);
    let (sign, unsigned) = match text.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", text.as_str()),
    };
    let (whole, fraction) = match unsigned.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (unsigned, None),
    };
    let mut grouped = String::with_capacity(whole.len() + whole.len() / 3);
    for (index, char) in whole.chars().enumerate() {
        if index > 0 && (whole.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(char);
    }
    // Intl writes no sign for a value that rounds to zero.
    let sign = if grouped.chars().all(|c| c == '0')
        && fraction.is_none_or(|f| f.chars().all(|c| c == '0'))
    {
        ""
    } else {
        sign
    };
    match fraction {
        Some(fraction) => format!("{sign}{grouped}.{fraction}"),
        None => format!("{sign}{grouped}"),
    }
}

/// `12,345`.
pub fn format_count(value: f64) -> String {
    format_number(value, 0)
}

/// Three significant digits up to a minute, as `4.27 ms`, `245 ms` or `30.2 s`.
pub fn format_ms(value: f64) -> String {
    if value < 10.0 {
        return format!("{} ms", format_number(value, 2));
    }
    if value < 100.0 {
        return format!("{} ms", format_number(value, 1));
    }
    if value < 999.5 {
        return format!("{} ms", format_number(value, 0));
    }
    let seconds = value / 1000.0;
    if seconds < 9.995 {
        return format!("{} s", format_number(seconds, 2));
    }
    if seconds < 59.95 {
        return format!("{} s", format_number(seconds, 1));
    }
    // Math.round: half up.
    let rounded = (seconds + 0.5).floor();
    let minutes = (rounded / 60.0).floor();
    let rest = rounded % 60.0;
    if minutes < 60.0 && rest > 0.0 {
        format!("{minutes} min {rest} s")
    } else {
        format!("{} min", format_count(minutes))
    }
}

/// `512 B`, `9.97 KB`, `1.50 MB`, `-13.83 KB`.
pub fn format_bytes(value: i64) -> String {
    let size = value.unsigned_abs();
    let sign = if value < 0 { "-" } else { "" };
    const KB: u64 = 1024;
    #[expect(
        clippy::cast_precision_loss,
        reason = "byte counts far below 2^53; JavaScript numbers are f64 too"
    )]
    let size_f = size as f64;
    if size >= KB.pow(3) {
        format!("{sign}{} GB", fixed(size_f / (KB.pow(3) as f64), 2))
    } else if size >= KB.pow(2) {
        format!("{sign}{} MB", fixed(size_f / 1024.0 / 1024.0, 2))
    } else if size >= KB {
        format!("{sign}{} KB", fixed(size_f / 1024.0, 2))
    } else {
        format!("{sign}{size} B")
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn base64(value: &Value) -> String {
        base64::engine::general_purpose::STANDARD.encode(value.to_string())
    }

    fn base64_url(value: &Value) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
    }

    fn object(value: Value) -> ToolbarData {
        match value {
            Value::Object(object) => object,
            _ => Map::new(),
        }
    }

    #[test]
    fn reads_a_full_payload_also_url_safe_base64_without_padding() {
        let data = json!({ "request_id": "abc", "request": { "uri": "/é?x=>>>" } });
        let expected = Some(ToolbarHeaderPayload::Full {
            data: object(data.clone()),
        });
        assert_eq!(
            decode_toolbar_headers(Some(&base64(&data)), None),
            expected,
            "standard"
        );
        assert_eq!(
            decode_toolbar_headers(Some(&base64_url(&data)), None),
            expected,
            "url-safe"
        );
    }

    #[test]
    fn prefers_the_full_payload_over_the_summary() {
        let summary = base64(&json!({ "request_id": "abc", "history_row": { "id": "abc" } }));
        let payload = decode_toolbar_headers(
            Some(&base64(&json!({ "request_id": "abc" }))),
            Some(&summary),
        );
        assert!(
            matches!(payload, Some(ToolbarHeaderPayload::Full { .. })),
            "full wins"
        );
    }

    #[test]
    fn falls_back_to_the_summary_with_or_without_a_usable_row() {
        let row = json!({ "id": "abc", "method": "GET", "uri": "/api" });
        let payload = decode_toolbar_headers(
            None,
            Some(&base64(&json!({ "request_id": "abc", "history_row": row }))),
        );
        assert_eq!(
            payload,
            Some(ToolbarHeaderPayload::Summary {
                id: "abc".to_owned(),
                row: Some(ToolbarHistoryRow {
                    method: "GET".to_owned(),
                    uri: "/api".to_owned(),
                    ..minimal_toolbar_row("abc", None, None)
                }),
            }),
            "row kept"
        );
        let payload = decode_toolbar_headers(
            None,
            Some(&base64(&json!({ "request_id": "abc", "history_row": [1] }))),
        );
        assert_eq!(
            payload,
            Some(ToolbarHeaderPayload::Summary {
                id: "abc".to_owned(),
                row: None
            }),
            "bad row"
        );
    }

    #[test]
    fn ignores_garbage() {
        assert_eq!(decode_toolbar_headers(None, None), None, "nothing");
        assert_eq!(
            decode_toolbar_headers(Some("not base64 json"), Some("%%%")),
            None,
            "garbage"
        );
        assert_eq!(
            decode_toolbar_headers(Some(&base64(&json!([1, 2]))), None),
            None,
            "array"
        );
        assert_eq!(
            decode_toolbar_headers(Some(&base64(&json!({ "request_id": 7 }))), None),
            None,
            "number id"
        );
        assert_eq!(
            decode_toolbar_headers(
                None,
                Some(&base64(&json!({ "history_row": { "id": "a" } })))
            ),
            None,
            "no id"
        );
        let invalid_utf8 = base64::engine::general_purpose::STANDARD.encode([0xFF, 0xFE]);
        assert_eq!(
            decode_toolbar_headers(Some(&invalid_utf8), None),
            None,
            "bad UTF-8"
        );
    }

    #[test]
    fn reads_headers_in_any_case() {
        let data = json!({ "request_id": "abc", "request": { "uri": "/é" } });
        let headers = [ApiHeader::new("X-Toolbar", base64(&data))];
        assert_eq!(
            toolbar_payload_from_headers(&headers),
            Some(ToolbarHeaderPayload::Full { data: object(data) }),
            "mixed case"
        );
        assert_eq!(
            toolbar_payload_from_headers(&[ApiHeader::new("content-type", "text/html")]),
            None,
            "none"
        );
    }

    #[test]
    fn minimal_row_uses_the_requests_method_and_path() {
        let row = minimal_toolbar_row("r1", Some("post"), Some("https://app.test/a/b?c=1#h"));
        assert_eq!(
            (row.method.as_str(), row.uri.as_str()),
            ("POST", "/a/b?c=1"),
            "method and path"
        );
        let row = minimal_toolbar_row("r1", None, Some("not a url"));
        assert_eq!(
            (row.method.as_str(), row.uri.as_str()),
            ("GET", "/"),
            "fallback"
        );
    }

    #[test]
    fn builds_a_history_row_for_a_payload_that_sent_none() {
        let page = object(json!({
            "request_id": "r1",
            "profiler": { "total_wall_time": { "formattedValue": "41ms", "value": 41.27 } },
            "request": { "method": "GET", "uri": "/", "route_name": "home", "is_inertia": true },
            "response": { "status_code": 200, "size": "9.97 KB" }
        }));
        let row = row_from_data(&page).expect("row");
        assert_eq!(row.id, "r1", "id");
        assert_eq!(row.is_xhr, Some(false), "page load");
        assert_eq!(row.status_code, Some(200), "status");
        assert_eq!(row.size.as_deref(), Some("9.97 KB"), "text size");
        assert_eq!(row.duration.as_deref(), Some("41ms"), "duration");
        assert_eq!(row.response_type.as_deref(), Some("Inertia"), "inertia");
        assert_eq!(row.name.as_deref(), Some("home"), "route name");

        let mut measured = page;
        measured.insert(
            "response".to_owned(),
            json!({ "size": { "formattedValue": "9.97 KB", "value": 10209 } }),
        );
        assert_eq!(
            row_from_data(&measured).and_then(|r| r.size),
            Some("9.97 KB".to_owned()),
            "measured size"
        );

        let with_row = object(
            json!({ "request_id": "r1", "history_row": { "id": "h", "method": "POST", "uri": "/x", "is_xhr": true } }),
        );
        assert_eq!(
            row_from_data(&with_row).map(|r| r.id),
            Some("h".to_owned()),
            "sent row wins"
        );
        assert_eq!(row_from_data(&Map::new()), None, "no id");
        let bare = row_from_data(&object(json!({ "request_id": "r2" }))).expect("bare row");
        assert_eq!(
            (bare.method.as_str(), bare.uri.as_str()),
            ("GET", "/"),
            "defaults"
        );
    }

    fn response(url: &str, headers: Vec<ApiHeader>) -> ApiResponse {
        ApiResponse {
            error: None,
            status: 200,
            status_text: "OK".to_owned(),
            url: url.to_owned(),
            headers,
            body: String::new(),
            body_encoding: crate::api_request::BodyEncoding::Text,
            size: 0,
            truncated: false,
            duration_ms: 1.0,
        }
    }

    #[test]
    fn receipt_carries_the_origin_and_row() {
        let draft = ApiRequestDraft {
            method: "POST".to_owned(),
            url: "https://app.test:8443/api/users?x=1".to_owned(),
            ..ApiRequestDraft::new(None)
        };
        let full =
            json!({ "request_id": "r1", "request": { "method": "POST", "uri": "/api/users" } });
        let receipt = toolbar_receipt(
            &draft,
            &response(
                "https://app.test:8443/api/users",
                vec![ApiHeader::new("x-toolbar", base64(&full))],
            ),
        )
        .expect("receipt");
        assert_eq!(receipt.origin, "https://app.test:8443", "origin");
        assert_eq!(
            (receipt.id.as_str(), receipt.row.uri.as_str()),
            ("r1", "/api/users"),
            "row"
        );
        assert!(receipt.data.is_some(), "payload");

        let summary = json!({ "request_id": "r2" });
        let receipt = toolbar_receipt(
            &draft,
            &response(
                "https://app.test/api/users",
                vec![ApiHeader::new("x-toolbar-summary", base64(&summary))],
            ),
        )
        .expect("receipt");
        assert_eq!(receipt.origin, "https://app.test", "default port left out");
        assert_eq!(
            (
                receipt.row.method.as_str(),
                receipt.row.uri.as_str(),
                receipt.row.is_xhr
            ),
            ("POST", "/api/users", Some(true)),
            "row from the draft, path only"
        );
        assert!(receipt.data.is_none(), "no payload");
        assert!(
            toolbar_receipt(&draft, &response("https://app.test/", Vec::new())).is_none(),
            "none"
        );
    }

    #[test]
    fn details_request_and_parsing() {
        let request = toolbar_details_request("https://app.test", "a b/é");
        assert_eq!(
            request.url, "https://app.test/_toolbar/requests/a%20b%2F%C3%A9",
            "encoded id"
        );
        assert_eq!(
            request.headers[1],
            ApiHeader::new("X-Laravel-Toolbar-Internal", "true"),
            "internal"
        );
        let mut details = response("https://app.test/", Vec::new());
        details.body = json!({ "raw": { "request_id": "r1" } }).to_string();
        assert_eq!(
            parse_toolbar_details(&details).map(|d| d.len()),
            Some(1),
            "raw"
        );
        details.body = json!({ "request_id": "r1", "raw": null }).to_string();
        assert!(parse_toolbar_details(&details).is_some(), "body itself");
        details.body = "[1]".to_owned();
        assert!(parse_toolbar_details(&details).is_none(), "array");
        details.body = "{}".to_owned();
        details.status = 404;
        assert!(parse_toolbar_details(&details).is_none(), "not ok");
    }

    #[test]
    fn formats_durations_with_a_readable_unit_a_space_and_grouped_digits() {
        assert_eq!(format_ms(4.271), "4.27 ms", "small");
        assert_eq!(format_ms(41.27), "41.3 ms", "tens");
        assert_eq!(format_ms(245.4), "245 ms", "hundreds");
        assert_eq!(format_ms(999.6), "1.00 s", "rounds to a second");
        assert_eq!(format_ms(1234.0), "1.23 s", "seconds");
        assert_eq!(format_ms(30168.0), "30.2 s", "tens of seconds");
        assert_eq!(format_ms(125_000.0), "2 min 5 s", "minutes");
        assert_eq!(format_ms(7_260_000.0), "121 min", "long");
        assert_eq!(format_ms(0.125), "0.13 ms", "tie rounds up");
        assert_eq!(format_count(12345.0), "12,345", "grouped");
        assert_eq!(format_count(1_234_567.0), "1,234,567", "grouped millions");
    }

    #[test]
    fn formats_bytes() {
        assert_eq!(format_bytes(512), "512 B", "bytes");
        assert_eq!(format_bytes(10209), "9.97 KB", "kilobytes");
        assert_eq!(format_bytes(-14162), "-13.83 KB", "freed memory");
        assert_eq!(format_bytes(20 * 1024 * 1024), "20.00 MB", "megabytes");
        assert_eq!(format_bytes(3 * 1024 * 1024 * 1024), "3.00 GB", "gigabytes");
    }
}
