//! Source control hosts for the Conn Server: GitHub, GitLab, Bitbucket, Azure DevOps,
//! Forgejo, GitCafe and Cursor Origin, reached exactly as the T3 server's drivers reach them
//! (`packages/source-control-*`). See `README.md` for the map of the whole area and what is
//! served.

pub mod http;
pub mod secret;

pub use secret::Secret;
