//! The thread transcript body (`OrchestrationV2ThreadTranscript`) and the size of the file the
//! client builds from it (`threadTranscriptHeader` plus one JSON line per item).

use serde_json::{Value, json};

/// The byte length of `threadTranscriptHeader` for title, environment id, thread id and
/// `updatedAt`, newline included.
pub(crate) fn header_bytes(values: [&str; 4]) -> u64 {
    let fixed: usize = conn_contract::THREAD_TRANSCRIPT_HEADER_PARTS
        .iter()
        .map(|part| part.len())
        .sum();
    values.iter().fold(fixed as u64, |size, value| {
        size.saturating_add(json_len(&Value::from(*value)))
    })
}

fn json_len(value: &Value) -> u64 {
    serde_json::to_vec(value).map_or(0, |text| text.len() as u64)
}

/// The rows of the JSON body, written as they arrive into `{"items":[...],"threadId":..,
/// "title":..,"updatedAt":..}`, with the file size counted against the limit. Each row is
/// encoded once; its length is what its file line costs.
pub(crate) struct Rows {
    out: Vec<u8>,
    position: u64,
    size: u64,
    limit: u64,
}

impl Rows {
    /// Starts with the header line counted.
    pub(crate) fn new(header: u64, limit: u64) -> Self {
        Self {
            out: b"{\"items\":[".to_vec(),
            position: 0,
            size: header,
            limit,
        }
    }

    pub(crate) fn fits(&self) -> bool {
        self.size <= self.limit
    }

    /// Whether a row of at least `bytes` could still fit.
    pub(crate) fn has_room(&self, bytes: u64) -> bool {
        self.size.saturating_add(bytes).saturating_add(1) <= self.limit
    }

    /// Appends one row; `false` when it passes the limit (the body is then useless).
    pub(crate) fn push(
        &mut self,
        visibility: &str,
        source_thread_id: Value,
        source_item_id: Value,
        item: Value,
    ) -> Result<bool, String> {
        let row = json!({
            "position": self.position,
            "visibility": visibility,
            "sourceThreadId": source_thread_id,
            "sourceItemId": source_item_id,
            "item": item,
        });
        if self.position > 0 {
            self.out.push(b',');
        }
        let before = self.out.len();
        serde_json::to_writer(&mut self.out, &row).map_err(|e| e.to_string())?;
        let line = (self.out.len() - before) as u64 + 1;
        self.size = self.size.saturating_add(line);
        self.position += 1;
        Ok(self.fits())
    }

    pub(crate) fn finish(
        mut self,
        thread_id: &str,
        title: &str,
        updated_at: &str,
    ) -> Result<Vec<u8>, String> {
        let text = |value: &str| serde_json::to_string(value).map_err(|e| e.to_string());
        self.out.extend_from_slice(b"],\"threadId\":");
        self.out.extend_from_slice(text(thread_id)?.as_bytes());
        self.out.extend_from_slice(b",\"title\":");
        self.out.extend_from_slice(text(title)?.as_bytes());
        self.out.extend_from_slice(b",\"updatedAt\":");
        self.out.extend_from_slice(text(updated_at)?.as_bytes());
        self.out.push(b'}');
        Ok(self.out)
    }
}
