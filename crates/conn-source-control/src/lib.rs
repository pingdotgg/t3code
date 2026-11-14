//! Source control hosts for the Conn Server: GitHub, Cursor Origin, GitLab, GitCafe, Forgejo,
//! Bitbucket and Azure DevOps, reached exactly as the T3 server's drivers reach them
//! (`packages/source-control-*`). See `README.md` for the map of the whole area and what is
//! served.

pub mod discovery;
pub mod hosts;
pub mod http;
pub mod secret;
pub mod settings;

pub use secret::Secret;
