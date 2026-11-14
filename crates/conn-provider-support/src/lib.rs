//! Pieces every CLI provider needs, with nothing provider-specific in them:
//!
//! - [`attachments`]: chat attachments as T3 stores them and lists them in a prompt.
//! - [`ids`]: `IdAllocatorV2` id formats, an injectable clock and uuids.
//! - [`lines`]: newline framing with a per-line cap.
//! - [`redact`]: secrets out of provider failure text, length capped (T3 `failure.ts`).
//! - [`process`]: one child process with bounded stdin/stdout, a stderr tail, reaping and a
//!   process-group kill.
//!
//! Used by `conn-provider-claude` and `conn-provider-codex`. Id helpers take the driver kind.

pub mod attachments;
pub mod host_files;
pub mod ids;
pub mod lines;
pub mod process;
pub mod redact;
pub mod sdk_host;
