//! One module per host, as the T3 server splits them into `packages/source-control-*`.
//!
//! Each module serves its host's discovery probe today. The repository and pull request
//! operations follow host by host, behind the same module.

use std::{collections::BTreeMap, ffi::OsString, fmt, path::Path};

use conn_contract::SourceControlProviderDiscoveryItem;

use crate::settings::Settings;

pub mod azure_devops;
pub mod bitbucket;
pub mod cursor_origin;
pub mod forgejo;
pub mod forgejo_cli;
pub mod gitcafe;
pub mod gitcafe_api;
pub mod github;
pub mod github_graphql;
pub mod gitlab;
pub mod repositories;

pub use repositories::Hosts;

/// The server's environment, as `HostProcess.Environment` gives it to a driver. Tests pass a
/// fixed set instead of changing the process's own variables.
#[derive(Clone, Default)]
pub struct Environment {
    fixed: Option<BTreeMap<String, String>>,
}

impl Environment {
    /// The process's own variables, read on each call.
    pub fn process() -> Self {
        Self { fixed: None }
    }

    /// A fixed set, for tests.
    pub fn fixed<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        Self {
            fixed: Some(
                pairs
                    .into_iter()
                    .map(|(k, v)| (k.to_owned(), v.to_owned()))
                    .collect(),
            ),
        }
    }

    pub fn get(&self, name: &str) -> Option<String> {
        match &self.fixed {
            Some(vars) => vars.get(name).cloned(),
            None => std::env::var(name).ok(),
        }
    }

    /// The value when it is not blank, trimmed.
    pub fn non_blank(&self, name: &str) -> Option<String> {
        self.get(name)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    }
}

impl fmt::Debug for Environment {
    // The variables may hold tokens; only their names are shown.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.fixed {
            Some(vars) => f
                .debug_struct("Environment")
                .field("fixed", &vars.keys().collect::<Vec<_>>())
                .finish(),
            None => f.write_str("Environment(process)"),
        }
    }
}

/// API roots a test points at a local fake server. Empty in the server: each host's own
/// default (or its own environment variable) applies.
#[derive(Clone, Debug, Default)]
pub struct Endpoints {
    /// Replaces `https://api.github.com` for host `github.com`.
    pub github_rest: Option<String>,
    /// Replaces `https://api.cursor.com`.
    pub cursor_origin_api: Option<String>,
    /// Replaces `https://<host>` for the Forgejo API.
    pub forgejo_api: Option<String>,
    /// Replaces `https://<host>` for the GitCafe API.
    pub gitcafe_api: Option<String>,
}

/// What every host's discovery reads.
#[derive(Clone, Copy, Debug)]
pub struct DiscoveryContext<'a> {
    /// The server's working directory (`config.cwd`), where probes run.
    pub cwd: &'a Path,
    /// The user's home folder (`HostProcess.HomeDirectory`).
    pub home: Option<&'a Path>,
    pub settings: &'a Settings,
    pub env: &'a Environment,
    pub endpoints: &'a Endpoints,
    /// Added to every child's environment. Empty in the server; tests put a stub folder first
    /// on the children's `PATH` (std looks the program up in the child's `PATH`).
    pub child_env: &'a [(&'static str, OsString)],
}

impl DiscoveryContext<'_> {
    /// The probe context for one host, with `extra` added after [`Self::child_env`].
    pub(crate) fn probe_env(
        &self,
        extra: &[(&'static str, OsString)],
    ) -> Vec<(&'static str, OsString)> {
        self.child_env.iter().chain(extra).cloned().collect()
    }
}

/// Every host's discovery item, in `BUILT_IN_SOURCE_CONTROL_DRIVER_LIST` order, all probed at
/// once (`concurrency: "unbounded"`).
pub async fn discover(ctx: DiscoveryContext<'_>) -> Vec<SourceControlProviderDiscoveryItem> {
    // Each on the heap: together they are tens of kilobytes (clippy's `large_futures`).
    let (github, origin, gitlab, gitcafe, forgejo, bitbucket, azure) = tokio::join!(
        Box::pin(github::discover(ctx)),
        Box::pin(cursor_origin::discover(ctx)),
        Box::pin(gitlab::discover(ctx)),
        Box::pin(gitcafe::discover(ctx)),
        Box::pin(forgejo::discover(ctx)),
        Box::pin(bitbucket::discover(ctx)),
        Box::pin(azure_devops::discover(ctx)),
    );
    vec![github, origin, gitlab, gitcafe, forgejo, bitbucket, azure]
}
