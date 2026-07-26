//! Windows port of `apps/mac/Sources/SidecarKit`.
//!
//! Spawns `node <server>/dist/bin.mjs --mode desktop --bootstrap-fd 0` on a
//! free loopback port, writes one line of `DesktopBackendBootstrap` JSON to
//! its stdin, polls it to readiness, and restarts it with exponential backoff
//! if it dies. See `apps/windows/ARCHITECTURE.md` for the full contract.

pub mod bootstrap;
pub mod config;
pub mod job;
pub mod node;
pub mod process;

pub use bootstrap::{generate_bootstrap_token, BootstrapEnvelope};
pub use config::SidecarConfig;
pub use job::ProcessJob;
pub use process::{ServerProcess, SidecarState};
