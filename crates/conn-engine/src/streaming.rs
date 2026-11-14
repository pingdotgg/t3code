//! Buffered delivery of streamed assistant text, as T3's `assistantStreaming.ts` and
//! `RunExecutionService` do it.
//!
//! - A running `assistant_message` node is never stored or shown.
//! - A streaming assistant message, or a streaming `assistant_message` or `reasoning` turn
//!   item, is stored only when this filter lets it through. In `paragraph` mode (T3's
//!   default) that is at a Markdown boundary, at most every 400 ms, with the text cut at the
//!   boundary; a held snapshot is stored whole once its message has been idle for 800 ms. In
//!   `turn` mode no streaming snapshot is stored.
//! - The final (`streaming: false`) version always goes through.
//!
//! What passes is stored like any event and stays in the log, so the stored sequence has no
//! gaps, and a subscriber that joins mid-turn sees the last delivered snapshot.
//!
//! Memory: one track per open streamed message, at most [`MAX_TRACKS`]; each holds the text
//! delivered so far, the latest snapshot's text, and the held snapshot.

use serde_json::Value;

use crate::store::Draft;

/// `ResponseStreamingMode` (`responseStreamingMode` in the server settings).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ResponseStreamingMode {
    /// Only the final text of a message is stored.
    Turn,
    /// Text is delivered at Markdown boundaries (T3's default).
    #[default]
    Paragraph,
}

impl ResponseStreamingMode {
    /// The settings value; anything but `"turn"` (also the retired `"token"`) is `paragraph`,
    /// as the T3 server decodes it with its default.
    pub fn from_setting(value: Option<&str>) -> Self {
        match value {
            Some("turn") => Self::Turn,
            _ => Self::Paragraph,
        }
    }
}

/// Long enough to ride out normal gaps between chunks; short enough that text written before a
/// long tool call does not look lost (T3's `ASSISTANT_IDLE_FLUSH_MS`).
pub(crate) const IDLE_FLUSH_MS: u64 = 800;
/// At most one delivery per message in this window (T3's throttle).
const THROTTLE_MS: u64 = 400;
/// Open streamed messages tracked at once. A provider that never finishes a message cannot
/// grow the list: the oldest track goes.
pub(crate) const MAX_TRACKS: usize = 64;

/// Where the scan of a message's terminated lines stands (T3's `AssistantTextScan`).
#[derive(Clone, Debug, Default, PartialEq)]
struct Scan {
    text: String,
    /// Start of the partial line; every line before it has been scanned.
    line_start: usize,
    /// The open code fence: its marker character, length and indent.
    open_fence: Option<(u8, usize, usize)>,
    /// The last place the text may be cut, or `None`.
    boundary: Option<usize>,
    title_awaiting_content: bool,
}

/// The line `text[start..end]` without trailing spaces, tabs and carriage returns.
fn trim_line_end(text: &str, start: usize, end: usize) -> &str {
    let line = text.get(start..end).unwrap_or("");
    line.trim_end_matches([' ', '\t', '\r'])
}

/// `^( *)(`{3,}|~{3,})`: the indent, the marker character and its length.
fn fence(line: &str) -> Option<(usize, u8, usize)> {
    let bytes = line.as_bytes();
    let indent = bytes.iter().take_while(|&&b| b == b' ').count();
    let marker = *bytes.get(indent)?;
    if marker != b'`' && marker != b'~' {
        return None;
    }
    let len = bytes
        .iter()
        .skip(indent)
        .take_while(|&&b| b == marker)
        .count();
    (len >= 3).then_some((indent, marker, len))
}

/// `^[ \t]*$`
fn blank(line: &str) -> bool {
    line.bytes().all(|b| b == b' ' || b == b'\t')
}

/// `[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]` at the start of `bytes`: the length of the match.
fn list_marker(bytes: &[u8]) -> Option<usize> {
    let mut i = bytes
        .iter()
        .take_while(|&&b| b == b' ' || b == b'\t')
        .count();
    match bytes.get(i)? {
        b'-' | b'*' | b'+' => i += 1,
        b'0'..=b'9' => {
            let digits = bytes
                .iter()
                .skip(i)
                .take_while(|b| b.is_ascii_digit())
                .count();
            if digits > 9 {
                return None;
            }
            i += digits;
            if !matches!(bytes.get(i)?, b'.' | b')') {
                return None;
            }
            i += 1;
        }
        _ => return None,
    }
    matches!(bytes.get(i)?, b' ' | b'\t').then_some(i + 1)
}

/// `^#{1,6}(?:[ \t]|$)`
fn atx_heading(bytes: &[u8]) -> bool {
    let hashes = bytes.iter().take_while(|&&b| b == b'#').count();
    (1..=6).contains(&hashes) && matches!(bytes.get(hashes), None | Some(b' ' | b'\t'))
}

/// `^ {0,3}(?:#{1,6}(?:[ \t]|$)|\*\*(?:[^*]|\*(?!\*))+\*\*:?$)`
fn section_title(line: &str) -> bool {
    let bytes = line.as_bytes();
    let indent = bytes.iter().take(3).take_while(|&&b| b == b' ').count();
    let rest = bytes.get(indent..).unwrap_or_default();
    if atx_heading(rest) {
        return true;
    }
    let Some(inner) = rest.strip_prefix(b"**") else {
        return false;
    };
    // The bold text has no `**` in it, so it closes at the first `**`.
    let Some(close) = inner.windows(2).position(|w| w == b"**") else {
        return false;
    };
    close > 0 && matches!(inner.get(close + 2..), Some(b"" | b":"))
}

/// T3's `advanceScan`: scans the terminated lines of `text`, resuming after `previous` when
/// `text` extends it.
fn advance(previous: &Scan, text: &str) -> Scan {
    let resumed = text.starts_with(previous.text.as_str());
    let (mut open_fence, mut boundary, mut line_start, mut title_awaiting) = if resumed {
        (
            previous.open_fence,
            previous.boundary,
            previous.line_start,
            previous.title_awaiting_content,
        )
    } else {
        (None, None, 0, false)
    };
    let mut search_from = if resumed { previous.text.len() } else { 0 };
    while let Some(offset) = text.get(search_from..).and_then(|rest| rest.find('\n')) {
        let newline = search_from + offset;
        let line = trim_line_end(text, line_start, newline);
        if open_fence.is_none()
            && line_start > 0
            && !title_awaiting
            && list_marker(line.as_bytes()).is_some()
        {
            boundary = Some(line_start);
        }
        if let Some((indent, marker, len)) = fence(line) {
            match open_fence {
                None => {
                    open_fence = Some((marker, len, indent));
                    title_awaiting = false;
                }
                Some((open_marker, open_len, open_indent))
                    if marker == open_marker
                        && len >= open_len
                        && indent <= open_indent + 3
                        && line.len() == indent + len =>
                {
                    // CommonMark: a closing fence carries no info string.
                    open_fence = None;
                    boundary = Some(newline + 1);
                }
                Some(_) => {}
            }
        } else if open_fence.is_none() && blank(line) && line_start > 0 {
            if !title_awaiting {
                boundary = Some(newline + 1);
            }
        } else if open_fence.is_none() {
            if line_start > 0 && !title_awaiting && atx_heading(line.as_bytes()) {
                boundary = Some(line_start);
            }
            title_awaiting = section_title(line);
        }
        line_start = newline + 1;
        search_from = line_start;
    }
    Scan {
        text: text.to_owned(),
        line_start,
        open_fence,
        boundary,
        title_awaiting_content: title_awaiting,
    }
}

/// T3's `readyBoundary`: the partial line may still change, so its list item start is
/// checked here, not kept in the scan.
fn ready_boundary(scan: &Scan) -> Option<usize> {
    if scan.open_fence.is_none() && scan.line_start > 0 && !scan.title_awaiting_content {
        let partial = scan
            .text
            .as_bytes()
            .get(scan.line_start..)
            .unwrap_or_default();
        // `[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t][ \t\r]*[^ \t\r]`
        if let Some(after) = list_marker(partial)
            && partial
                .get(after..)
                .unwrap_or_default()
                .iter()
                .any(|b| !matches!(b, b' ' | b'\t' | b'\r'))
        {
            return Some(scan.line_start);
        }
    }
    scan.boundary
}

/// T3's `splitBufferedAssistantText`: the part that may be shown, and the rest.
#[cfg(test)]
fn split(text: &str) -> (&str, &str) {
    match ready_boundary(&advance(&Scan::default(), text)) {
        Some(at) => (text.get(..at).unwrap_or(""), text.get(at..).unwrap_or(text)),
        None => ("", text),
    }
}

struct Track {
    key: String,
    thread_id: String,
    /// The text delivered so far.
    delivered: String,
    /// When it was last delivered; `None` before the first delivery.
    at: Option<u64>,
    /// The newest snapshot whose text has not all been delivered yet.
    held: Option<Draft>,
    due_at: u64,
    scan: Scan,
}

/// The streamed text of one draft, when it is an assistant message or an assistant or
/// reasoning turn item.
fn streamed(draft: &Draft) -> Option<(&str, bool, &str)> {
    let payload = &draft.payload;
    let streamed = match draft.event_type {
        "message.updated" => payload["role"] == "assistant",
        "turn-item.updated" => matches!(
            payload["type"].as_str(),
            Some("assistant_message" | "reasoning")
        ),
        _ => false,
    };
    if !streamed {
        return None;
    }
    Some((
        payload["id"].as_str().unwrap_or(""),
        payload["streaming"] == true,
        payload["text"].as_str().unwrap_or(""),
    ))
}

fn with_text(mut draft: Draft, text: &str) -> Draft {
    if let Some(map) = draft.payload.as_object_mut() {
        map.insert("text".into(), Value::String(text.to_owned()));
    }
    draft
}

/// The filter T3's `makeAssistantStreamingFilter` makes, one per provider session's event
/// pump. Times are milliseconds by the engine's clock.
pub(crate) struct AssistantStreaming {
    mode: ResponseStreamingMode,
    idle_flush_ms: u64,
    tracks: Vec<Track>,
}

impl AssistantStreaming {
    pub(crate) fn new(mode: ResponseStreamingMode) -> Self {
        Self::with_idle_flush(mode, IDLE_FLUSH_MS)
    }

    pub(crate) fn with_idle_flush(mode: ResponseStreamingMode, idle_flush_ms: u64) -> Self {
        Self {
            mode,
            idle_flush_ms,
            tracks: Vec::new(),
        }
    }

    /// The mode for the next snapshots (T3 reads it at each run start).
    pub(crate) fn set_mode(&mut self, mode: ResponseStreamingMode) {
        self.mode = mode;
    }

    fn track(&mut self, track: Track) {
        match self.tracks.iter_mut().find(|t| t.key == track.key) {
            Some(slot) => *slot = track,
            None => {
                if self.tracks.len() >= MAX_TRACKS {
                    self.tracks.remove(0);
                }
                self.tracks.push(track);
            }
        }
    }

    /// The draft to store now, or `None` to store nothing.
    pub(crate) fn filter(&mut self, draft: Draft, now: u64) -> Option<Draft> {
        if draft.event_type == "node.updated"
            && draft.payload["kind"] == "assistant_message"
            && draft.payload["status"] == "running"
        {
            return None;
        }
        let Some((id, streaming, text)) = streamed(&draft) else {
            return Some(draft);
        };
        let key = format!("{}:{id}", draft.event_type);
        if !streaming {
            self.tracks.retain(|t| t.key != key);
            return Some(draft);
        }
        if self.mode == ResponseStreamingMode::Turn {
            return None;
        }
        let text = text.to_owned();
        let thread_id = draft.thread_id.clone();
        let previous = self
            .tracks
            .iter()
            .position(|t| t.key == key)
            .map(|at| self.tracks.swap_remove(at));
        let delivered = previous
            .as_ref()
            .map(|p| p.delivered.clone())
            .unwrap_or_default();
        let previous_at = previous.as_ref().and_then(|p| p.at);
        let due_at = now.saturating_add(self.idle_flush_ms);
        if previous_at.is_some_and(|at| now.saturating_sub(at) < THROTTLE_MS) {
            let scan = previous.map(|p| p.scan).unwrap_or_default();
            let held = (text != delivered).then_some(draft);
            self.track(Track {
                key,
                thread_id,
                delivered,
                at: previous_at,
                held,
                due_at,
                scan,
            });
            return None;
        }
        let scan = advance(
            previous
                .as_ref()
                .map(|p| &p.scan)
                .unwrap_or(&Scan::default()),
            &text,
        );
        let ready = ready_boundary(&scan)
            .and_then(|at| text.get(..at))
            .unwrap_or("")
            .to_owned();
        // An idle delivery may already show more than the next boundary; never shrink it. A
        // provider rewrite or truncation is not a prefix and replaces it.
        if delivered.starts_with(ready.as_str()) {
            let held = (text != delivered).then_some(draft);
            self.track(Track {
                key,
                thread_id,
                delivered,
                at: previous_at,
                held,
                due_at,
                scan,
            });
            return None;
        }
        let out = with_text(draft.clone(), &ready);
        let held = (ready != text).then_some(draft);
        self.track(Track {
            key,
            thread_id,
            delivered: ready,
            at: Some(now),
            held,
            due_at,
            scan,
        });
        Some(out)
    }

    /// When the next held snapshot comes due, if any.
    pub(crate) fn next_idle_flush_at(&self) -> Option<u64> {
        self.tracks
            .iter()
            .filter(|t| t.held.is_some())
            .map(|t| t.due_at)
            .min()
    }

    /// The held snapshots due by `now`, counted as delivered.
    pub(crate) fn take_idle_flushes(&mut self, now: u64) -> Vec<Draft> {
        let mut due = Vec::new();
        for track in &mut self.tracks {
            if track.due_at > now {
                continue;
            }
            let Some(draft) = track.held.take() else {
                continue;
            };
            if let Some((_, _, text)) = streamed(&draft) {
                track.delivered = text.to_owned();
            }
            track.at = Some(now);
            track.due_at = now;
            due.push(draft);
        }
        due
    }

    /// The root run of `thread_id` settled: its messages are closed, nothing of it is flushed
    /// later (T3 skips the root thread's idle flushes once the run is finalized).
    pub(crate) fn forget_thread(&mut self, thread_id: &str) {
        self.tracks.retain(|t| t.thread_id != thread_id);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.tracks.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_code_fences_intact() {
        assert_eq!(
            split("Intro\n\n```ts\nx()\n\n"),
            ("Intro\n\n", "```ts\nx()\n\n")
        );
        assert_eq!(
            split("```ts\nx()\n```\nrest"),
            ("```ts\nx()\n```\n", "rest")
        );
    }

    #[test]
    fn holds_a_streamed_section_heading_until_its_content_has_a_boundary() {
        assert_eq!(
            split("Intro\n\n## Results\n\n"),
            ("Intro\n\n", "## Results\n\n")
        );
        assert_eq!(
            split("**Results**\n\nBody\n\nNext"),
            ("**Results**\n\nBody\n\n", "Next")
        );
    }

    fn snapshot(id: &str, text: &str, streaming: bool) -> Draft {
        Draft::new(
            "thread",
            "message.updated",
            json!({"id": id, "role": "assistant", "text": text, "streaming": streaming}),
        )
    }

    fn shown(draft: Option<Draft>) -> Option<String> {
        draft.and_then(|d| d.payload["text"].as_str().map(str::to_owned))
    }

    enum Step {
        Text(u64, &'static str, Option<&'static str>),
        Final(u64, &'static str),
        Id(&'static str, u64, &'static str, &'static str),
        Idle(u64, &'static [&'static str]),
        DueAt(Option<u64>),
    }
    use Step::*;

    fn run(mode: ResponseStreamingMode, steps: &[Step]) {
        let mut filter = AssistantStreaming::with_idle_flush(mode, 800);
        for (n, step) in steps.iter().enumerate() {
            match step {
                Text(at, text, shows) => assert_eq!(
                    shown(filter.filter(snapshot("m", text, true), *at)).as_deref(),
                    *shows,
                    "step {n}"
                ),
                Final(at, text) => assert_eq!(
                    shown(filter.filter(snapshot("m", text, false), *at)).as_deref(),
                    Some(*text),
                    "step {n}"
                ),
                Id(id, at, text, shows) => assert_eq!(
                    shown(filter.filter(snapshot(id, text, true), *at)).as_deref(),
                    Some(*shows),
                    "step {n}"
                ),
                Idle(now, shows) => {
                    let got: Vec<String> = filter
                        .take_idle_flushes(*now)
                        .into_iter()
                        .filter_map(|d| shown(Some(d)))
                        .collect();
                    assert_eq!(got, shows.to_vec(), "step {n}");
                }
                DueAt(at) => assert_eq!(filter.next_idle_flush_at(), *at, "step {n}"),
            }
        }
    }

    const P: ResponseStreamingMode = ResponseStreamingMode::Paragraph;

    // The cases of T3's `assistantStreaming.test.ts`, "paragraph streaming holds and
    // idle-delivers".
    #[test]
    fn an_unfinished_code_fence() {
        run(
            P,
            &[
                Text(0, "A\n\n```ts\nx()", Some("A\n\n")),
                DueAt(Some(800)),
                Idle(799, &[]),
                Idle(800, &["A\n\n```ts\nx()"]),
                DueAt(None),
                Text(
                    1_300,
                    "A\n\n```ts\nx()\n```\n\nB",
                    Some("A\n\n```ts\nx()\n```\n\n"),
                ),
            ],
        );
    }

    #[test]
    fn a_lists_partial_last_item() {
        run(
            P,
            &[
                Text(0, "Steps:\n\n- one\n- tw", Some("Steps:\n\n- one\n")),
                Idle(800, &["Steps:\n\n- one\n- tw"]),
                Text(
                    1_300,
                    "Steps:\n\n- one\n- two\n- th",
                    Some("Steps:\n\n- one\n- two\n"),
                ),
            ],
        );
    }

    #[test]
    fn an_incomplete_table_row() {
        run(
            P,
            &[
                Text(
                    0,
                    "Intro.\n\n| a | b |\n|---|---|\n| 1 |",
                    Some("Intro.\n\n"),
                ),
                Idle(800, &["Intro.\n\n| a | b |\n|---|---|\n| 1 |"]),
                Text(
                    1_300,
                    "Intro.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter",
                    Some("Intro.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n"),
                ),
            ],
        );
    }

    #[test]
    fn more_of_the_same_paragraph_after_an_idle_delivery() {
        run(
            P,
            &[
                Text(0, "A\n\nB", Some("A\n\n")),
                Idle(800, &["A\n\nB"]),
                Text(900, "A\n\nB more", None),
                Idle(1_699, &[]),
                Idle(1_700, &["A\n\nB more"]),
                Idle(5_000, &[]),
                Text(5_100, "A\n\nB more and", None),
                Text(5_200, "A\n\nB more and.\n\nC", Some("A\n\nB more and.\n\n")),
                Final(5_300, "A\n\nB more and.\n\nC."),
                Idle(10_000, &[]),
            ],
        );
    }

    #[test]
    fn completion_at_the_idle_deadline() {
        run(
            P,
            &[
                Text(0, "A\n\nB", Some("A\n\n")),
                Final(800, "A\n\nB."),
                Idle(800, &[]),
            ],
        );
    }

    #[test]
    fn completion_right_after_an_idle_delivery_at_the_same_instant() {
        run(
            P,
            &[
                Text(0, "A\n\nB", Some("A\n\n")),
                Idle(800, &["A\n\nB"]),
                Final(800, "A\n\nB."),
                Idle(5_000, &[]),
            ],
        );
    }

    #[test]
    fn several_fast_paragraphs_inside_the_throttle() {
        run(
            P,
            &[
                Text(0, "A\n\nB", Some("A\n\n")),
                Text(100, "A\n\nB\n\nC", None),
                Text(200, "A\n\nB\n\nC\n\nD", None),
                Text(300, "A\n\nB\n\nC\n\nD\n\nE", None),
                Idle(1_099, &[]),
                Idle(1_100, &["A\n\nB\n\nC\n\nD\n\nE"]),
            ],
        );
    }

    #[test]
    fn two_messages_due_at_different_times() {
        run(
            P,
            &[
                Id("a", 0, "A\n\nx", "A\n\n"),
                Id("b", 300, "B\n\ny", "B\n\n"),
                DueAt(Some(800)),
                Idle(800, &["A\n\nx"]),
                DueAt(Some(1_100)),
                Idle(1_100, &["B\n\ny"]),
            ],
        );
    }

    #[test]
    fn empty_text() {
        run(P, &[Text(0, "", None), DueAt(None)]);
    }

    #[test]
    fn whitespace_only_text() {
        run(
            P,
            &[Text(0, " \n", None), Idle(800, &[" \n"]), Idle(5_000, &[])],
        );
    }

    #[test]
    fn provider_rewrites_and_truncation() {
        run(
            P,
            &[
                Text(
                    0,
                    "Original long paragraph.\n\n",
                    Some("Original long paragraph.\n\n"),
                ),
                Text(1_000, "New.\n\n", Some("New.\n\n")),
                Text(1_100, "Old.\n\n", None),
                Idle(1_900, &["Old.\n\n"]),
                Text(2_500, "Old", None),
                Idle(3_300, &["Old"]),
                Text(4_000, "", None),
                Idle(4_800, &[""]),
            ],
        );
    }

    #[test]
    fn a_rewrite_that_drops_an_open_code_fence() {
        run(
            P,
            &[
                Text(0, "Intro\n\n```ts\nx()\n", Some("Intro\n\n")),
                Text(400, "Retry\n\n- a\n- b", Some("Retry\n\n- a\n")),
            ],
        );
    }

    #[test]
    fn turn_mode() {
        run(
            ResponseStreamingMode::Turn,
            &[Text(0, "A\n\nB", None), DueAt(None)],
        );
    }

    #[test]
    fn a_long_open_code_fence_is_scanned_once_and_shown_when_closed() {
        let mut filter = AssistantStreaming::new(P);
        let mut text = String::from("Intro\n\n```ts\n");
        for line in 0..400u64 {
            text.push_str(&format!("const value{line} = {line};\n"));
            filter.filter(snapshot("m", &text, true), line * 400);
        }
        text.push_str("```\n");
        assert_eq!(
            shown(filter.filter(snapshot("m", &text, true), 400 * 400)),
            Some(text)
        );
    }

    #[test]
    fn a_running_assistant_node_is_never_stored() {
        let mut filter = AssistantStreaming::new(P);
        let node = |status: &str| {
            Draft::new(
                "thread",
                "node.updated",
                json!({"id": "n", "kind": "assistant_message", "status": status}),
            )
        };
        assert!(filter.filter(node("running"), 0).is_none());
        assert!(filter.filter(node("completed"), 0).is_some());
        let tool = Draft::new(
            "thread",
            "node.updated",
            json!({"id": "t", "kind": "tool", "status": "running"}),
        );
        assert!(filter.filter(tool, 0).is_some());
    }

    #[test]
    fn reasoning_items_are_buffered_and_user_messages_are_not() {
        let mut filter = AssistantStreaming::new(P);
        let item = Draft::new(
            "thread",
            "turn-item.updated",
            json!({"id": "i", "type": "reasoning", "text": "think", "streaming": true}),
        );
        assert!(filter.filter(item, 0).is_none());
        let user = Draft::new(
            "thread",
            "message.updated",
            json!({"id": "u", "role": "user", "text": "hi", "streaming": true}),
        );
        assert!(filter.filter(user, 0).is_some());
    }

    #[test]
    fn open_messages_are_bounded() {
        let mut filter = AssistantStreaming::new(P);
        for n in 0..(MAX_TRACKS * 3) {
            filter.filter(snapshot(&format!("m{n}"), "no boundary", true), 0);
        }
        assert_eq!(filter.len(), MAX_TRACKS);
    }

    #[test]
    fn a_settled_thread_flushes_nothing_later() {
        let mut filter = AssistantStreaming::new(P);
        filter.filter(snapshot("m", "A\n\nB", true), 0);
        filter.forget_thread("thread");
        assert_eq!(filter.next_idle_flush_at(), None);
        assert!(filter.take_idle_flushes(10_000).is_empty());
    }

    #[test]
    fn the_retired_token_mode_reads_as_paragraph() {
        assert_eq!(ResponseStreamingMode::from_setting(Some("token")), P);
        assert_eq!(ResponseStreamingMode::from_setting(None), P);
        assert_eq!(
            ResponseStreamingMode::from_setting(Some("turn")),
            ResponseStreamingMode::Turn
        );
    }
}
