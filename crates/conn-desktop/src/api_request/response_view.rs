//! Pure helpers for the API panel's response pane.
//!
//! Port of the logic in Conn's `apps/web/src/api/ApiResponseView.tsx` and the badge variants
//! of `apps/web/src/laravelToolbar/ui/parts.tsx` (`StatusBadge`, `MethodBadge`).

use std::io;

use serde::Serialize;
use serde_json::ser::{Formatter, PrettyFormatter};

use super::toolbar::{format_bytes, format_ms};
use super::{ApiResponse, BodyEncoding};

/// The pane before the first send.
pub const IDLE_TEXT: &str = "Send the request to see the response.";
/// The pane while the first send runs (next to a spinner).
pub const SENDING_TEXT: &str = "Sending…";
/// The notice for a body over 20 MB.
pub const TRUNCATED_NOTICE: &str =
    "The body is larger than 20 MB; the panel shows the first 20 MB.";

/// A badge's color role.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BadgeVariant {
    Success,
    Info,
    Warning,
    Error,
}

/// 5xx error, 4xx warning, 3xx info, else success.
pub fn status_variant(status: u16) -> BadgeVariant {
    match status {
        500.. => BadgeVariant::Error,
        400.. => BadgeVariant::Warning,
        300.. => BadgeVariant::Info,
        _ => BadgeVariant::Success,
    }
}

/// GET info, POST success, DELETE error, others warning.
pub fn method_variant(method: &str) -> BadgeVariant {
    match method {
        "GET" => BadgeVariant::Info,
        "POST" => BadgeVariant::Success,
        "DELETE" => BadgeVariant::Error,
        _ => BadgeVariant::Warning,
    }
}

/// The trailing status line of the response tabs: status badge, duration and size.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseSummary {
    pub status: u16,
    pub status_variant: BadgeVariant,
    pub duration: String,
    pub size: String,
}

/// The status line, or `None` for a failed response (it shows the error notice instead).
pub fn response_summary(response: &ApiResponse) -> Option<ResponseSummary> {
    if response.error.is_some() {
        return None;
    }
    Some(ResponseSummary {
        status: response.status,
        status_variant: status_variant(response.status),
        duration: format_ms(response.duration_ms),
        size: format_bytes(i64::try_from(response.size).unwrap_or(i64::MAX)),
    })
}

/// The warning notices above the body, in order.
pub fn response_notices(response: &ApiResponse) -> Vec<String> {
    let mut notices = Vec::new();
    if let Some(error) = &response.error {
        notices.push(error.clone());
    }
    if response.truncated {
        notices.push(TRUNCATED_NOTICE.to_owned());
    }
    notices
}

/// Pretty-printed JSON when the body parses as JSON, the text as sent otherwise; a note for
/// binary bodies.
pub fn format_response_body(response: &ApiResponse) -> String {
    if response.body_encoding == BodyEncoding::Base64 {
        return format!(
            "Binary response ({}). The panel shows text bodies only.",
            format_bytes(i64::try_from(response.size).unwrap_or(i64::MAX))
        );
    }
    let text = &response.body;
    let looks_json = response
        .header("content-type")
        .is_some_and(|value| value.contains("json"))
        || text.trim_start().starts_with(['[', '{']);
    if !looks_json {
        return text.clone();
    }
    pretty_json(text).unwrap_or_else(|| text.clone())
}

/// `JSON.stringify(JSON.parse(text), null, 2)`: two-space indent, keys in source order,
/// numbers written as JavaScript writes them. `None` when `text` is not JSON.
pub fn pretty_json(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let mut out = Vec::new();
    let mut serializer =
        serde_json::Serializer::with_formatter(&mut out, JsFormatter(PrettyFormatter::new()));
    value.serialize(&mut serializer).ok()?;
    String::from_utf8(out).ok()
}

/// JavaScript's `Number.prototype.toString` for a finite double.
fn js_number(value: f64) -> String {
    if value == 0.0 {
        return "0".to_owned();
    }
    let magnitude = value.abs();
    if (1e-6..1e21).contains(&magnitude) {
        return format!("{value}");
    }
    let exponent = format!("{value:e}");
    match exponent.split_once('e') {
        Some((mantissa, power)) if !power.starts_with('-') => format!("{mantissa}e+{power}"),
        _ => exponent,
    }
}

/// serde_json's pretty printer with JavaScript number output.
struct JsFormatter<'a>(PrettyFormatter<'a>);

impl Formatter for JsFormatter<'_> {
    fn write_f64<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        writer.write_all(js_number(value).as_bytes())
    }

    fn begin_array<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.begin_array(writer)
    }

    fn end_array<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.end_array(writer)
    }

    fn begin_array_value<W: ?Sized + io::Write>(
        &mut self,
        writer: &mut W,
        first: bool,
    ) -> io::Result<()> {
        self.0.begin_array_value(writer, first)
    }

    fn end_array_value<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.end_array_value(writer)
    }

    fn begin_object<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.begin_object(writer)
    }

    fn end_object<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.end_object(writer)
    }

    fn begin_object_key<W: ?Sized + io::Write>(
        &mut self,
        writer: &mut W,
        first: bool,
    ) -> io::Result<()> {
        self.0.begin_object_key(writer, first)
    }

    fn begin_object_value<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.begin_object_value(writer)
    }

    fn end_object_value<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.end_object_value(writer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_request::ApiHeader;

    fn response(body: &str, content_type: Option<&str>) -> ApiResponse {
        ApiResponse {
            error: None,
            status: 200,
            status_text: "OK".to_owned(),
            url: "https://app.test/".to_owned(),
            headers: content_type
                .map(|value| vec![ApiHeader::new("Content-Type", value)])
                .unwrap_or_default(),
            body: body.to_owned(),
            body_encoding: BodyEncoding::Text,
            size: body.len() as u64,
            truncated: false,
            duration_ms: 41.27,
        }
    }

    #[test]
    fn pretty_prints_json_bodies_in_source_order() {
        let body = r#"{"b":1.0,"a":[1,{"c":null}],"e":{},"f":[],"big":1e21,"small":1e-7}"#;
        assert_eq!(
            format_response_body(&response(body, Some("application/json"))),
            "{\n  \"b\": 1,\n  \"a\": [\n    1,\n    {\n      \"c\": null\n    }\n  ],\n  \"e\": {},\n  \"f\": [],\n  \"big\": 1e+21,\n  \"small\": 1e-7\n}",
            "JSON.stringify(_, null, 2)"
        );
        assert_eq!(
            format_response_body(&response(" [1,2]", None)),
            "[\n  1,\n  2\n]",
            "looks like JSON"
        );
    }

    #[test]
    fn keeps_text_and_broken_json_as_sent() {
        assert_eq!(
            format_response_body(&response("<p>hi</p>", Some("text/html"))),
            "<p>hi</p>",
            "html"
        );
        assert_eq!(
            format_response_body(&response("{oops", Some("application/json"))),
            "{oops",
            "broken"
        );
        assert_eq!(
            format_response_body(&response("42", None)),
            "42",
            "not object-like"
        );
        assert_eq!(
            format_response_body(&response("42", Some("application/json"))),
            "42",
            "json number"
        );
    }

    #[test]
    fn describes_binary_bodies() {
        let mut binary = response("AAEC", Some("image/png"));
        binary.body_encoding = BodyEncoding::Base64;
        binary.size = 10209;
        assert_eq!(
            format_response_body(&binary),
            "Binary response (9.97 KB). The panel shows text bodies only.",
            "binary note"
        );
    }

    #[test]
    fn writes_numbers_as_javascript_does() {
        assert_eq!(js_number(1.0), "1", "integral");
        assert_eq!(js_number(-0.0), "0", "negative zero");
        assert_eq!(js_number(0.1), "0.1", "fraction");
        assert_eq!(js_number(1.5e300), "1.5e+300", "large");
        assert_eq!(js_number(1e20), "100000000000000000000", "below 1e21");
        assert_eq!(js_number(2.5e-7), "2.5e-7", "tiny");
    }

    #[test]
    fn badges_and_summary() {
        assert_eq!(status_variant(200), BadgeVariant::Success, "2xx");
        assert_eq!(status_variant(302), BadgeVariant::Info, "3xx");
        assert_eq!(status_variant(404), BadgeVariant::Warning, "4xx");
        assert_eq!(status_variant(503), BadgeVariant::Error, "5xx");
        assert_eq!(method_variant("DELETE"), BadgeVariant::Error, "delete");
        assert_eq!(method_variant("PATCH"), BadgeVariant::Warning, "patch");
        let summary = response_summary(&response("{}", None)).expect("summary");
        assert_eq!(
            (summary.duration.as_str(), summary.size.as_str()),
            ("41.3 ms", "2 B"),
            "line"
        );
        let failed = ApiResponse::failure("https://app.test/", "The request timed out.", 3.0);
        assert!(response_summary(&failed).is_none(), "no line for errors");
        let mut truncated = response("x", None);
        truncated.truncated = true;
        assert_eq!(
            response_notices(&truncated),
            [TRUNCATED_NOTICE],
            "truncated notice"
        );
        assert_eq!(
            response_notices(&failed),
            ["The request timed out."],
            "error notice"
        );
    }
}
