//! Pieces every CLI provider needs, with nothing provider-specific in them:
//!
//! - [`ids`]: `IdAllocatorV2` id formats, an injectable clock and uuids.
//! - [`lines`]: newline framing with a per-line cap.
//! - [`process`]: one child process with bounded stdin/stdout, a stderr tail, reaping and a
//!   process-group kill.
//!
//! `conn-provider-claude` keeps its own copies for now; it can switch to this crate as is.

pub mod ids;
pub mod lines;
pub mod process;
