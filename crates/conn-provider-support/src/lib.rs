//! Pieces every CLI provider needs, with nothing provider-specific in them:
//!
//! - [`ids`]: `IdAllocatorV2` id formats, an injectable clock and uuids.
//! - [`lines`]: newline framing with a per-line cap.
//! - [`process`]: one child process with bounded stdin/stdout, a stderr tail, reaping and a
//!   process-group kill.
//!
//! Used by `conn-provider-claude` and `conn-provider-codex`. Id helpers take the driver kind.

pub mod ids;
pub mod lines;
pub mod process;
