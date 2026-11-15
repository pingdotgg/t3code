//! Conn's own server areas beside the engine. Each area keeps its state in the state folder
//! and serves the RPC methods and `/mcp` tools `conn-server` and `conn-mcp` register for it.
//! `README.md` maps every method and tool of these areas and what each needs.

pub mod annotations;
pub mod clock;
pub mod scheduled;
