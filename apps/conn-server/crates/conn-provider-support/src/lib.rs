//! Pieces every CLI provider needs, with nothing provider-specific in them:
//!
//! - [`attachments`]: chat attachments as T3 stores them and lists them in a prompt.
//! - [`ids`]: `IdAllocatorV2` id formats, an injectable clock and uuids.
//! - [`instance`]: a provider instance's settings envelope, its environment and `~` expansion.
//! - [`lines`]: newline framing with a per-line cap.
//! - [`redact`]: secrets out of provider failure text, length capped (T3 `failure.ts`).
//! - [`probe`]: a CLI run for a status probe, as T3's `spawnAndCollect`.
//! - [`process`]: one child process with bounded stdin/stdout, a stderr tail, reaping and a
//!   process-group kill.
//!
//! Used by `conn-provider-claude` and `conn-provider-codex`. Id helpers take the driver kind.

pub mod attachments;
pub mod host_files;
pub mod ids;
pub mod instance;
pub mod lines;
pub mod notification;
pub mod probe;
pub mod process;
// Reads `/proc`; on other Unix hosts it finds no tree and does nothing.
#[cfg(unix)]
pub mod process_tree;
pub mod redact;
pub mod sdk_host;
