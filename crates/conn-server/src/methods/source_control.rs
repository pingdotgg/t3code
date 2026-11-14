//! `server.discoverSourceControl` (and, step by step, `sourceControl.*`, `git.*` and
//! `pullRequests.*`). Owner: the pull requests and source control track. The host work lives
//! in `conn-source-control`; `git` and `jj` come from `conn-vcs`.

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Arc,
};

use conn_contract::SourceControlDiscoveryResult;
use conn_source_control::{
    hosts::{self, DiscoveryContext, Endpoints, Environment},
    settings::Settings,
};
use serde_json::Value;

use super::Deps;
use crate::table::{Failure, MethodTable};

pub(super) fn register(table: &mut MethodTable, deps: &Deps) {
    let environment = deps.environment.clone();
    let cwd = Arc::new(
        environment
            .as_ref()
            .map_or_else(std::env::temp_dir, |e| e.cwd.clone()),
    );
    let home: Option<Arc<PathBuf>> = std::env::var_os("HOME").map(|h| Arc::new(PathBuf::from(h)));
    table.unary("server.discoverSourceControl", move |_, _: Value| {
        let cwd = cwd.clone();
        let home = home.clone();
        // Read fresh on each call, as `getWithSecrets` does, so a saved token counts at once.
        let settings = Settings::new(
            environment
                .as_ref()
                .map(|e| e.settings.raw())
                .unwrap_or_default(),
        );
        async move {
            let result = discover(
                &cwd,
                home.as_deref().map(PathBuf::as_path),
                &settings,
                &Environment::process(),
                &[],
            )
            .await;
            Ok::<_, Failure>(result)
        }
    });
}

/// `SourceControlDiscovery.discover`: `git` and `jj`, and every host, all at once.
async fn discover(
    cwd: &Path,
    home: Option<&Path>,
    settings: &Settings,
    env: &Environment,
    child_env: &[(&'static str, OsString)],
) -> SourceControlDiscoveryResult {
    let endpoints = Endpoints::default();
    let ctx = DiscoveryContext {
        cwd,
        home,
        settings,
        env,
        endpoints: &endpoints,
        child_env,
    };
    let (version_control_systems, source_control_providers) = tokio::join!(
        conn_vcs::discovery::version_control_systems(cwd),
        Box::pin(hosts::discover(ctx)),
    );
    SourceControlDiscoveryResult {
        version_control_systems,
        source_control_providers,
    }
}

#[cfg(test)]
mod tests {
    use conn_contract::to_json;

    use super::*;
    use crate::table::Handler;

    /// The answer has git and jj, then all seven hosts in the T3 server's order. No host CLI
    /// runs (the children's `PATH` is an empty folder) and no variable is read, so nothing on
    /// this machine is asked about its logins.
    #[tokio::test(flavor = "current_thread")]
    async fn lists_every_host_in_t3_order() {
        let mut table = MethodTable::new();
        register(&mut table, &Deps::default());
        assert!(
            matches!(
                table.get("server.discoverSourceControl"),
                Some(Handler::Unary(_))
            ),
            "registered"
        );
        let empty = std::env::temp_dir().join(format!("conn-sc-empty-path-{}", std::process::id()));
        std::fs::create_dir_all(&empty).expect("dir");
        let answer = to_json(
            &discover(
                &empty,
                None,
                &Settings::default(),
                &Environment::fixed([]),
                &[("PATH", empty.clone().into_os_string())],
            )
            .await,
        );
        let _ = std::fs::remove_dir_all(&empty);
        let kinds = |key: &str| -> Vec<String> {
            answer[key]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|i| i["kind"].as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default()
        };
        assert_eq!(kinds("versionControlSystems"), ["git", "jj"], "VCS");
        assert_eq!(
            kinds("sourceControlProviders"),
            [
                "github",
                "cursor-origin",
                "gitlab",
                "gitcafe",
                "forgejo",
                "bitbucket",
                "azure-devops"
            ],
            "hosts"
        );
        let github = &answer["sourceControlProviders"][0];
        assert_eq!(github["status"], "missing", "no gh on the empty PATH");
        assert_eq!(github["auth"]["status"], "unknown", "{github}");
    }
}
