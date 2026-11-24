//! Native clients keep this index when the corresponding transcript bodies age out.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadOutline {
    pub snapshot_sequence: u64,
    pub markers: Vec<ThreadOutlineMarker>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadOutlineMarker {
    pub entry_id: String,
    pub preview: String,
    pub assistant_preview: Option<String>,
    pub is_agent_prompt: bool,
    pub has_checkpoint: bool,
    pub has_error: bool,
}
