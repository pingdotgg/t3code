//! GitHub source control for the Conn Server, reached as the T3 server reaches it
//! (`packages/source-control-*`). See `README.md` for the map of the whole area and what is
//! served.

pub mod cache;
pub mod checkout;
pub mod cli;
pub mod detect;
pub mod discovery;
pub mod hosts;
pub mod http;
pub mod pull_requests;
pub mod registry;
pub mod remote;
pub mod repository;
pub mod secret;
pub mod settings;

pub use secret::Secret;
