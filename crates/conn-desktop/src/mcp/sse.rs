//! A Server-Sent Events parser for the `http` and `sse` transports.

/// One dispatched event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SseEvent {
    /// The `event:` field; empty means `message`.
    pub(crate) event: String,
    pub(crate) data: String,
}

/// Turns a byte stream into events. Lines end in `\n` or `\r\n`.
#[derive(Debug, Default)]
pub(crate) struct SseParser {
    pending: Vec<u8>,
    event: String,
    data: String,
    has_data: bool,
}

impl SseParser {
    /// Feeds one chunk and returns the events it completes.
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.pending.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(end) = self.pending.iter().position(|byte| *byte == b'\n') {
            let mut line: Vec<u8> = self.pending.drain(..=end).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line = String::from_utf8_lossy(&line);
            if let Some(event) = self.line(&line) {
                events.push(event);
            }
        }
        events
    }

    fn line(&mut self, line: &str) -> Option<SseEvent> {
        if line.is_empty() {
            let event = std::mem::take(&mut self.event);
            let data = std::mem::take(&mut self.data);
            let had_data = std::mem::replace(&mut self.has_data, false);
            return had_data.then_some(SseEvent { event, data });
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "event" => self.event = value.to_owned(),
            "data" => {
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value);
                self.has_data = true;
            }
            _ => {}
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_events_across_chunks() {
        let mut parser = SseParser::default();
        assert!(
            parser.push(b"event: endpoint\r\nda").is_empty(),
            "incomplete"
        );
        let events =
            parser.push(b"ta: /messages?id=1\r\n\r\n: comment\n\ndata: {\"a\"\ndata: :1}\n\n");
        assert_eq!(
            events,
            vec![
                SseEvent {
                    event: "endpoint".into(),
                    data: "/messages?id=1".into()
                },
                SseEvent {
                    event: String::new(),
                    data: "{\"a\"\n:1}".into()
                },
            ],
            "two events"
        );
    }
}
