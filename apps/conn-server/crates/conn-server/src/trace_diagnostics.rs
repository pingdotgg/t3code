//! `server.getTraceDiagnostics`: T3's `TraceDiagnostics.read` and
//! `makeTraceDiagnosticsAggregator` (`apps/server/src/diagnostics/TraceDiagnostics.ts`).
//!
//! This server writes no trace, but its state folder can be the one a T3 server used
//! (`<T3 home>/userdata`), with that server's `logs/server.trace.ndjson` and rotations. They
//! are read as T3 reads them: the oldest backup first, line by line (never a whole file in
//! memory), with bounded top lists. Blocking: call it on a blocking thread.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufRead, BufReader};
use std::path::Path;

use serde_json::{Map, Value, json};

/// T3's `DEFAULT_SLOW_SPAN_THRESHOLD_MS`, `TOP_LIMIT`, `RECENT_LIMIT` and `traceMaxFiles`.
const SLOW_SPAN_THRESHOLD_MS: f64 = 1_000.0;
const TOP_LIMIT: usize = 10;
const RECENT_LIMIT: usize = 20;
const MAX_FILES: usize = 10;

/// JavaScript's `Date` range, ±8.64e15 ms; four-digit years only (see [`iso`]).
const MIN_MS: i64 = -62_167_219_200_000; // 0000-01-01T00:00:00.000Z
const MAX_MS: i64 = 253_402_300_799_999; // 9999-12-31T23:59:59.999Z

/// The answer for the trace file `<state>/logs/server.trace.ndjson`, read at `read_at` (ISO).
/// Names, ids, causes, levels and messages are kept as read and trimmed only in the answer:
/// the contract's `TrimmedNonEmptyString` trims them when T3 encodes it.
pub fn read(state_dir: &Path, read_at: &str) -> Value {
    let trace = state_dir.join("logs").join("server.trace.ndjson");
    let trace = trace.to_string_lossy().into_owned();
    // `toRotatedTracePaths`: `.10` down to `.1`, then the live file.
    let mut paths: Vec<String> = (1..=MAX_FILES)
        .rev()
        .map(|n| format!("{trace}.{n}"))
        .collect();
    paths.push(trace.clone());
    let mut aggregator = Aggregator::default();
    let mut found = false;
    let mut read_failure: Option<String> = None;
    for path in &paths {
        match stream_lines(path, &mut |line| aggregator.add_line(line)) {
            Ok(true) => found = true,
            Ok(false) => {}
            Err(()) => {
                if read_failure.is_none() {
                    read_failure = Some(format!("Failed to read local trace file '{path}'."));
                }
            }
        }
    }
    let read_error =
        read_failure.map(|message| json!({"kind": "trace-file-read-failed", "message": message}));
    if !found {
        let error = read_error.unwrap_or_else(|| {
            json!({"kind": "trace-file-not-found", "message": "No local trace files were found."})
        });
        return Aggregator::default().finish(&trace, &paths, read_at, Some(error), false);
    }
    let partial = read_error.is_some();
    aggregator.finish(&trace, &paths, read_at, read_error, partial)
}

/// `streamTraceFileLines`: `Ok(false)` when the file is absent, `Err` on any other failure.
/// Lines read before a failure still count, as in T3's stream. Effect's `splitLines` ends a
/// line at `\n`, `\r\n` or a lone `\r`; only the unfinished line is held between reads.
fn stream_lines(path: &str, on_line: &mut dyn FnMut(&str)) -> Result<bool, ()> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(()),
    };
    let mut reader = BufReader::new(file);
    let mut line: Vec<u8> = Vec::new();
    let mut after_cr = false;
    loop {
        let chunk = match reader.fill_buf() {
            Ok(chunk) => chunk,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(()),
        };
        if chunk.is_empty() {
            if !line.is_empty() {
                on_line(&String::from_utf8_lossy(&line));
            }
            return Ok(true);
        }
        for &byte in chunk {
            match byte {
                b'\n' if after_cr => after_cr = false,
                b'\n' | b'\r' => {
                    on_line(&String::from_utf8_lossy(&line));
                    line.clear();
                    after_cr = byte == b'\r';
                }
                _ => {
                    line.push(byte);
                    after_cr = false;
                }
            }
        }
        let read = chunk.len();
        reader.consume(read);
    }
}

/// JavaScript's `String.prototype.trim`: its whitespace and line terminators, which differ from
/// Rust's (`U+FEFF` is one, `U+0085` is not).
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| {
        matches!(
            c,
            '\u{9}'..='\u{D}'
                | ' '
                | '\u{A0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
        )
    })
}

/// `toStringValue`: a string with something besides whitespace, as it is (not trimmed).
fn string(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !js_trim(text).is_empty())
}

/// `unixNanoToDateTime`: decimal nanoseconds to whole milliseconds, toward zero.
fn time(value: Option<&Value>) -> Option<i64> {
    let text = js_trim(string(value)?);
    let nanos: i128 = text.parse().ok()?;
    let millis = i64::try_from(nanos / 1_000_000).ok()?;
    (MIN_MS..=MAX_MS).contains(&millis).then_some(millis)
}

fn iso(millis: i64) -> String {
    conn_support::time::iso_from_millis(millis)
}

#[derive(Clone)]
struct Occurrence {
    name: String,
    duration_ms: f64,
    ended_at: i64,
    trace_id: String,
    span_id: String,
}

impl Occurrence {
    fn to_json(&self) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert("name".into(), json!(js_trim(&self.name)));
        map.insert("durationMs".into(), json!(self.duration_ms));
        map.insert("endedAt".into(), json!(iso(self.ended_at)));
        map.insert("traceId".into(), json!(js_trim(&self.trace_id)));
        map.insert("spanId".into(), json!(js_trim(&self.span_id)));
        map
    }
}

struct LogEvent {
    span_name: String,
    level: String,
    message: String,
    seen_at: i64,
    trace_id: String,
    span_id: String,
}

#[derive(Default)]
struct SpanSummary {
    count: u64,
    failure_count: u64,
    total_duration_ms: f64,
    max_duration_ms: f64,
}

struct FailureSummary {
    name: String,
    cause: String,
    count: u64,
    last_seen_at: i64,
    trace_id: String,
    span_id: String,
}

/// `insertBounded`: keeps the `limit` first items in `order`; equal items keep their arrival
/// order (a stable sort, as JavaScript's).
fn insert_bounded<A>(
    items: &mut Vec<A>,
    item: A,
    limit: usize,
    order: impl Fn(&A, &A) -> std::cmp::Ordering,
) {
    if items.len() >= limit
        && items
            .last()
            .is_some_and(|last| order(&item, last) != std::cmp::Ordering::Less)
    {
        return;
    }
    items.push(item);
    items.sort_by(&order);
    items.truncate(limit);
}

fn descending(left: f64, right: f64) -> std::cmp::Ordering {
    right
        .partial_cmp(&left)
        .unwrap_or(std::cmp::Ordering::Equal)
}

#[derive(Default)]
struct Aggregator {
    parse_error_count: u64,
    record_count: u64,
    failure_count: u64,
    interruption_count: u64,
    slow_span_count: u64,
    first_span_at: Option<i64>,
    last_span_at: Option<i64>,
    /// In first-seen order, as T3's `Map`.
    spans: Vec<(String, SpanSummary)>,
    span_index: HashMap<String, usize>,
    failures: Vec<FailureSummary>,
    failure_index: HashMap<(String, String), usize>,
    latest_failures: Vec<(Occurrence, String)>,
    slowest_spans: Vec<Occurrence>,
    latest_logs: Vec<LogEvent>,
    /// In first-seen order: encoding trims the keys, and a later key wins a collision.
    log_level_counts: Vec<(String, u64)>,
    log_level_index: HashMap<String, usize>,
}

impl Aggregator {
    fn add_line(&mut self, line: &str) {
        if js_trim(line).is_empty() {
            return;
        }
        let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(line) else {
            self.parse_error_count += 1;
            return;
        };
        let name = string(parsed.get("name"));
        let trace_id = string(parsed.get("traceId"));
        let span_id = string(parsed.get("spanId"));
        let duration_ms = parsed.get("durationMs").and_then(Value::as_f64);
        let ended_at = time(parsed.get("endTimeUnixNano"));
        let started_at = time(parsed.get("startTimeUnixNano"));
        let (Some(name), Some(trace_id), Some(span_id), Some(duration_ms), Some(ended_at)) =
            (name, trace_id, span_id, duration_ms, ended_at)
        else {
            self.parse_error_count += 1;
            return;
        };

        // A span name's total must stay a finite number: an infinite total encodes as `null`,
        // which the client's schema refuses for the whole answer. T3 would send that; here
        // the record counts as unparsable instead (a known difference).
        let prior_total = self
            .span_index
            .get(name)
            .and_then(|i| self.spans.get(*i))
            .map_or(0.0, |(_, summary)| summary.total_duration_ms);
        if !(prior_total + duration_ms).is_finite() {
            self.parse_error_count += 1;
            return;
        }

        self.record_count += 1;
        if let Some(started) = started_at
            && self.first_span_at.is_none_or(|first| started < first)
        {
            self.first_span_at = Some(started);
        }
        if self.last_span_at.is_none_or(|last| ended_at > last) {
            self.last_span_at = Some(ended_at);
        }

        let empty = Map::new();
        let exit = parsed.get("exit").and_then(Value::as_object);
        let exit_tag = exit.and_then(|exit| string(exit.get("_tag")));
        let status = parsed
            .get("status")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        let attributes = parsed
            .get("attributes")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        let is_failure = exit_tag == Some("Failure") || status.get("code") == Some(&json!("2"));
        let is_interrupted = exit_tag == Some("Interrupted")
            || attributes.get("effect.fiber.interrupted") == Some(&Value::Bool(true))
            || status.get("message") == Some(&json!("Interrupted"));
        if is_failure {
            self.failure_count += 1;
        }
        if is_interrupted {
            self.interruption_count += 1;
        }

        let index = match self.span_index.get(name) {
            Some(index) => *index,
            None => {
                self.spans.push((name.to_owned(), SpanSummary::default()));
                let index = self.spans.len() - 1;
                self.span_index.insert(name.to_owned(), index);
                index
            }
        };
        if let Some((_, summary)) = self.spans.get_mut(index) {
            summary.count += 1;
            summary.total_duration_ms += duration_ms;
            summary.max_duration_ms = summary.max_duration_ms.max(duration_ms);
            if is_failure {
                summary.failure_count += 1;
            }
        }

        let span = Occurrence {
            name: name.to_owned(),
            duration_ms,
            ended_at,
            trace_id: trace_id.to_owned(),
            span_id: span_id.to_owned(),
        };
        if duration_ms >= SLOW_SPAN_THRESHOLD_MS {
            self.slow_span_count += 1;
        }
        insert_bounded(&mut self.slowest_spans, span.clone(), TOP_LIMIT, |l, r| {
            descending(l.duration_ms, r.duration_ms)
        });

        if is_failure {
            // `readExitCause`, or the status message.
            let cause = if exit_tag == Some("Failure") {
                exit.and_then(|exit| string(exit.get("cause")))
                    .map_or("Failure", js_trim)
            } else {
                string(status.get("message")).map_or("Failure", js_trim)
            }
            .to_owned();
            insert_bounded(
                &mut self.latest_failures,
                (span, cause.clone()),
                RECENT_LIMIT,
                |l, r| r.0.ended_at.cmp(&l.0.ended_at),
            );
            let key = (name.to_owned(), cause.clone());
            match self
                .failure_index
                .get(&key)
                .and_then(|i| self.failures.get_mut(*i))
            {
                Some(existing) => {
                    existing.count += 1;
                    if ended_at > existing.last_seen_at {
                        existing.last_seen_at = ended_at;
                        existing.trace_id = trace_id.to_owned();
                        existing.span_id = span_id.to_owned();
                    }
                }
                None => {
                    self.failures.push(FailureSummary {
                        name: name.to_owned(),
                        cause,
                        count: 1,
                        last_seen_at: ended_at,
                        trace_id: trace_id.to_owned(),
                        span_id: span_id.to_owned(),
                    });
                    self.failure_index.insert(key, self.failures.len() - 1);
                }
            }
        }

        // `isTraceEvent` takes any object, arrays included; an array has no attributes.
        if let Some(Value::Array(events)) = parsed.get("events") {
            for event in events {
                let event_attributes = match event {
                    Value::Object(event) => event.get("attributes").and_then(Value::as_object),
                    Value::Array(_) => None,
                    _ => continue,
                };
                let Some(level) = event_attributes.and_then(|a| string(a.get("effect.logLevel")))
                else {
                    continue;
                };
                match self
                    .log_level_index
                    .get(level)
                    .and_then(|i| self.log_level_counts.get_mut(*i))
                {
                    Some((_, count)) => *count += 1,
                    None => {
                        self.log_level_counts.push((level.to_owned(), 1));
                        self.log_level_index
                            .insert(level.to_owned(), self.log_level_counts.len() - 1);
                    }
                }
                let normalized = level.to_lowercase();
                if !matches!(normalized.as_str(), "warning" | "warn" | "error" | "fatal") {
                    continue;
                }
                let seen_at = time(event.get("timeUnixNano")).unwrap_or(ended_at);
                let message = string(event.get("name")).map_or("Log event", js_trim);
                insert_bounded(
                    &mut self.latest_logs,
                    LogEvent {
                        span_name: name.to_owned(),
                        level: level.to_owned(),
                        message: message.to_owned(),
                        seen_at,
                        trace_id: trace_id.to_owned(),
                        span_id: span_id.to_owned(),
                    },
                    RECENT_LIMIT,
                    |l, r| r.seen_at.cmp(&l.seen_at),
                );
            }
        }
    }

    fn finish(
        self,
        trace: &str,
        paths: &[String],
        read_at: &str,
        error: Option<Value>,
        partial_failure: bool,
    ) -> Value {
        let option = |value: Option<Value>| match value {
            Some(value) => json!({"_tag": "Some", "value": value}),
            None => json!({"_tag": "None"}),
        };
        let mut spans: Vec<&(String, SpanSummary)> = self.spans.iter().collect();
        spans.sort_by(|(_, l), (_, r)| {
            r.count
                .cmp(&l.count)
                .then_with(|| descending(l.max_duration_ms, r.max_duration_ms))
        });
        let top_spans: Vec<Value> = spans
            .into_iter()
            .take(TOP_LIMIT)
            .map(|(name, s)| {
                // `count` is at least 1 for every stored span.
                let average = s.total_duration_ms / s.count.max(1) as f64;
                json!({
                    "name": js_trim(name),
                    "count": s.count,
                    "failureCount": s.failure_count,
                    "totalDurationMs": s.total_duration_ms,
                    "averageDurationMs": average,
                    "maxDurationMs": s.max_duration_ms,
                })
            })
            .collect();
        let mut failures: Vec<&FailureSummary> = self.failures.iter().collect();
        failures.sort_by(|l, r| {
            r.count
                .cmp(&l.count)
                .then_with(|| r.last_seen_at.cmp(&l.last_seen_at))
        });
        let common_failures: Vec<Value> = failures
            .into_iter()
            .take(TOP_LIMIT)
            .map(|f| {
                json!({
                    "name": js_trim(&f.name), "cause": js_trim(&f.cause), "count": f.count,
                    "lastSeenAt": iso(f.last_seen_at),
                    "traceId": js_trim(&f.trace_id), "spanId": js_trim(&f.span_id),
                })
            })
            .collect();
        let latest_failures: Vec<Value> = self
            .latest_failures
            .iter()
            .map(|(span, cause)| {
                let mut map = span.to_json();
                map.insert("cause".into(), json!(js_trim(cause)));
                Value::Object(map)
            })
            .collect();
        let slowest: Vec<Value> = self
            .slowest_spans
            .iter()
            .map(|s| Value::Object(s.to_json()))
            .collect();
        let logs: Vec<Value> = self
            .latest_logs
            .iter()
            .map(|e| {
                json!({
                    "spanName": js_trim(&e.span_name), "level": js_trim(&e.level),
                    "message": js_trim(&e.message), "seenAt": iso(e.seen_at),
                    "traceId": js_trim(&e.trace_id), "spanId": js_trim(&e.span_id),
                })
            })
            .collect();
        let mut level_counts = Map::new();
        for (level, count) in &self.log_level_counts {
            level_counts.insert(js_trim(level).to_owned(), json!(count));
        }
        json!({
            "traceFilePath": trace,
            "scannedFilePaths": paths,
            "readAt": read_at,
            "recordCount": self.record_count,
            "parseErrorCount": self.parse_error_count,
            "firstSpanAt": option(self.first_span_at.map(|t| json!(iso(t)))),
            "lastSpanAt": option(self.last_span_at.map(|t| json!(iso(t)))),
            "failureCount": self.failure_count,
            "interruptionCount": self.interruption_count,
            "slowSpanThresholdMs": SLOW_SPAN_THRESHOLD_MS,
            "slowSpanCount": self.slow_span_count,
            "logLevelCounts": level_counts,
            "topSpansByCount": top_spans,
            "slowestSpans": slowest,
            "commonFailures": common_failures,
            "latestFailures": latest_failures,
            "latestWarningAndErrorLogs": logs,
            "partialFailure": option(partial_failure.then_some(json!(true))),
            "error": option(error),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("conn-trace-{}", crate::auth::random_hex(6)));
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        dir
    }

    #[test]
    fn a_home_without_traces_answers_not_found() {
        let dir = temp();
        let result = read(&dir, "2026-11-21T00:00:00.000Z");
        assert_eq!(result["recordCount"], 0);
        assert_eq!(result["error"]["value"]["kind"], "trace-file-not-found");
        assert_eq!(result["scannedFilePaths"].as_array().unwrap().len(), 11);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn spans_failures_and_logs_are_counted() {
        let dir = temp();
        let span = |name: &str, ms: f64, end: u64, extra: &str| {
            format!(
                r#"{{"name":"{name}","traceId":"t","spanId":"s{end}","durationMs":{ms},"startTimeUnixNano":"{}","endTimeUnixNano":"{}"{extra}}}"#,
                end * 1_000_000,
                (end + 1) * 1_000_000
            )
        };
        let lines = [
            span("a", 5.0, 1, ""),
            span(
                "a",
                1500.0,
                2,
                r#","exit":{"_tag":"Failure","cause":" boom "}"#,
            ),
            span(
                "b",
                2.0,
                3,
                r#","status":{"code":"2","message":"Interrupted"}"#,
            ),
            span(
                "b",
                1.0,
                4,
                r#","events":[{"name":"careful","attributes":{"effect.logLevel":"Warning"}},{"attributes":{"effect.logLevel":"Info"}}]"#,
            ),
            "not json".into(),
            String::new(),
        ];
        std::fs::write(dir.join("logs/server.trace.ndjson.1"), lines.join("\r\n")).unwrap();
        let result = read(&dir, "2026-11-21T00:00:00.000Z");
        assert_eq!(result["recordCount"], 4);
        assert_eq!(result["parseErrorCount"], 1);
        assert_eq!(result["failureCount"], 2);
        assert_eq!(result["interruptionCount"], 1);
        assert_eq!(result["slowSpanCount"], 1);
        // Equal counts: the latest failure first.
        assert_eq!(result["commonFailures"][1]["cause"], "boom");
        assert_eq!(result["latestFailures"][0]["cause"], "Interrupted");
        assert_eq!(result["latestWarningAndErrorLogs"][0]["message"], "careful");
        assert_eq!(result["logLevelCounts"], json!({"Warning": 1, "Info": 1}));
        assert_eq!(result["error"], json!({"_tag": "None"}));
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Review findings: JavaScript's trim (a name of only U+FEFF is empty, as in T3), and a
    /// total that would overflow to infinity (encoded `null`, refused by the client).
    #[test]
    fn js_whitespace_and_overflowing_totals_count_as_unparsable() {
        let dir = temp();
        let line = |name: &str, ms: &str| {
            format!(
                r#"{{"name":"{name}","traceId":"t","spanId":"s","durationMs":{ms},"endTimeUnixNano":"5000000"}}"#
            )
        };
        let lines = [
            line("\u{feff}", "1"),
            line("\\u0085x\\u0085", "1"),
            line("big", "1e308"),
            line("big", "1e308"),
        ];
        std::fs::write(dir.join("logs/server.trace.ndjson"), lines.join("\n")).unwrap();
        let result = read(&dir, "2026-11-21T00:00:00.000Z");
        assert_eq!(result["recordCount"], 2);
        assert_eq!(result["parseErrorCount"], 2);
        let names: Vec<&str> = result["topSpansByCount"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"\u{85}x\u{85}"), "{names:?}");
        assert!(
            result["topSpansByCount"]
                .as_array()
                .unwrap()
                .iter()
                .all(|s| s["totalDurationMs"].is_number())
        );
        assert_eq!(js_trim("\u{feff} a \u{3000}"), "a");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lines_end_at_lf_crlf_and_lone_cr() {
        let dir = temp();
        let path = dir.join("logs/server.trace.ndjson");
        std::fs::write(&path, b"a\r\nb\rc\n\rd").unwrap();
        let mut seen = vec![];
        let found = stream_lines(&path.to_string_lossy(), &mut |l| seen.push(l.to_owned()));
        assert_eq!(found, Ok(true));
        assert_eq!(seen, ["a", "b", "c", "", "d"]);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
