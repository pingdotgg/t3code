//! `server.discoverSourceControl` and the sign-in and star methods of `sourceControl.*`; step by
//! step the rest of `sourceControl.*`, `git.*` and `pullRequests.*`. Owner: the pull requests
//! and source control track. The host work lives in `conn-source-control`; `git` and `jj` come
//! from `conn-vcs`.
//!
//! The sign-in methods answer as a T3 server without `T3CODE_GITHUB_APP_CLIENT_ID` does
//! (`SourceControlSignIn.ts`, `GitHubAppSignIn.ts`): GitHub's app sign-in is not built here, so
//! discovery offers none, and a client that asks anyway gets T3's own refusal.

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Arc,
};

use conn_contract::{
    SourceControlAppAccess, SourceControlAppAccessStatus, SourceControlDiscoveryResult,
    SourceControlSignInError, SourceControlSignInFailure, SourceControlSignInInput,
    SourceControlStarredInput, lit,
};
use conn_source_control::{
    hosts::{self, DiscoveryContext, Endpoints, Environment},
    settings::Settings,
};
use serde_json::Value;

use super::Deps;
use crate::{
    environment::Environment as ServerEnvironment,
    table::{Failure, MethodTable},
};

/// What a host call reads, built fresh per call (settings may have changed).
#[derive(Clone)]
struct HostInputs {
    cwd: Arc<Path>,
    home: Option<Arc<Path>>,
    environment: Option<Arc<ServerEnvironment>>,
}

impl HostInputs {
    fn settings(&self) -> Settings {
        // Read fresh on each call, as `getWithSecrets` does, so a saved token counts at once.
        Settings::new(
            self.environment
                .as_ref()
                .map(|e| e.settings.raw())
                .unwrap_or_default(),
        )
    }
}

pub(super) fn register(table: &mut MethodTable, deps: &Deps) {
    let environment = deps.environment.clone();
    let inputs = HostInputs {
        cwd: Arc::from(
            environment
                .as_ref()
                .map_or_else(std::env::temp_dir, |e| e.cwd.clone()),
        ),
        home: std::env::var_os("HOME").map(|h| Arc::from(PathBuf::from(h))),
        environment,
    };

    let host = inputs.clone();
    table.unary("server.discoverSourceControl", move |_, _: Value| {
        let host = host.clone();
        let settings = host.settings();
        async move {
            let result = discover(
                &host.cwd,
                host.home.as_deref(),
                &settings,
                &Environment::process(),
                &[],
            )
            .await;
            Ok::<_, Failure>(result)
        }
    });

    table.unary(
        "sourceControl.signInStart",
        |_, input: SourceControlSignInInput| async move {
            Err::<Value, _>(Failure::fail(&sign_in_refusal(&input, SignInStep::Start)))
        },
    );
    table.unary(
        "sourceControl.signInWait",
        |_, input: SourceControlSignInInput| async move {
            Err::<Value, _>(Failure::fail(&sign_in_refusal(&input, SignInStep::Wait)))
        },
    );
    table.unary(
        "sourceControl.signInCancel",
        |_, input: SourceControlSignInInput| async move {
            // GitHub has nothing pending to cancel; another host cannot sign in at all.
            if provider_of(&input.provider) == conn_source_control::hosts::github::KIND {
                Ok(Value::Null)
            } else {
                Err(Failure::fail(&sign_in_refusal(&input, SignInStep::Cancel)))
            }
        },
    );
    table.unary(
        "sourceControl.appAccess",
        |_, _: SourceControlStarredInput| async move {
            // Without an app sign-in every host reads `signed-out` (`SourceControlSignIn.access`,
            // `GitHubAppAccess.reach` when the app is off).
            Ok::<_, Failure>(SourceControlAppAccess {
                status: SourceControlAppAccessStatus::SignedOut,
            })
        },
    );
    for (tag, star) in [
        ("sourceControl.starred", false),
        ("sourceControl.star", true),
    ] {
        let host = inputs.clone();
        table.unary(tag, move |_, input: SourceControlStarredInput| {
            let host = host.clone();
            let settings = host.settings();
            async move {
                let env = Environment::process();
                Ok::<_, Failure>(
                    starred(
                        &host.cwd,
                        host.home.as_deref(),
                        &settings,
                        &env,
                        &input,
                        star,
                    )
                    .await,
                )
            }
        });
    }
}

/// `SourceControlProviderKind` and `TrimmedNonEmptyString` decode by trimming.
fn provider_of(provider: &str) -> &str {
    provider.trim()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SignInStep {
    Start,
    Wait,
    Cancel,
}

/// The `SourceControlSignInError` a T3 server without an app client id answers.
fn sign_in_refusal(input: &SourceControlSignInInput, step: SignInStep) -> SourceControlSignInError {
    let provider = provider_of(&input.provider);
    let host = input.host.trim();
    let error = |host: String, reason, detail: String| SourceControlSignInError {
        tag: lit::SourceControlSignInError,
        provider: provider.to_owned(),
        host,
        reason,
        detail,
        cause: None,
    };
    if provider != conn_source_control::hosts::github::KIND {
        return error(
            host.to_owned(),
            SourceControlSignInFailure::Unsupported,
            format!("This server cannot sign in to {provider}. Use a token or the host's CLI."),
        );
    }
    let host = host.to_lowercase();
    match step {
        SignInStep::Start => error(
            host,
            SourceControlSignInFailure::Unsupported,
            "This server is not set up to sign in with T3 Code for GitHub.".into(),
        ),
        SignInStep::Wait | SignInStep::Cancel => error(
            host,
            SourceControlSignInFailure::NotStarted,
            "No sign-in is in progress. Start again.".into(),
        ),
    }
}

/// `SourceControlSignIn.starred` / `.star`: only GitHub's driver can; any other host is `false`.
async fn starred(
    cwd: &Path,
    home: Option<&Path>,
    settings: &Settings,
    env: &Environment,
    input: &SourceControlStarredInput,
    star: bool,
) -> bool {
    if provider_of(&input.provider) != conn_source_control::hosts::github::KIND {
        return false;
    }
    let endpoints = Endpoints::default();
    let ctx = DiscoveryContext {
        cwd,
        home,
        settings,
        env,
        endpoints: &endpoints,
        child_env: &[],
    };
    conn_source_control::hosts::github::starred(
        ctx,
        input.host.trim(),
        input.repository.trim(),
        star,
    )
    .await
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

    fn sign_in(provider: &str, host: &str) -> SourceControlSignInInput {
        SourceControlSignInInput {
            provider: provider.into(),
            host: host.into(),
        }
    }

    // SourceControlSignIn.ts and GitHubAppSignIn.ts without T3CODE_GITHUB_APP_CLIENT_ID.
    #[test]
    fn sign_in_answers_as_t3_without_an_app() {
        let github = sign_in_refusal(&sign_in("github", " GitHub.com "), SignInStep::Start);
        assert_eq!(
            github.reason,
            SourceControlSignInFailure::Unsupported,
            "start"
        );
        assert_eq!(github.host, "github.com", "host lowercased");
        assert_eq!(
            github.detail, "This server is not set up to sign in with T3 Code for GitHub.",
            "start detail"
        );
        let waiting = sign_in_refusal(&sign_in("github", "github.com"), SignInStep::Wait);
        assert_eq!(
            waiting.reason,
            SourceControlSignInFailure::NotStarted,
            "wait"
        );
        assert_eq!(
            waiting.detail, "No sign-in is in progress. Start again.",
            "wait detail"
        );
        let other = sign_in_refusal(&sign_in("gitlab", "gitlab.com"), SignInStep::Cancel);
        assert_eq!(
            other.reason,
            SourceControlSignInFailure::Unsupported,
            "other host"
        );
        assert_eq!(
            other.detail, "This server cannot sign in to gitlab. Use a token or the host's CLI.",
            "other detail"
        );
        assert_eq!(
            to_json(&github)["_tag"],
            "SourceControlSignInError",
            "tagged for the client"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn only_github_can_star() {
        let input = SourceControlStarredInput {
            provider: "gitlab".into(),
            host: "gitlab.com".into(),
            repository: "group/project".into(),
        };
        let dir = std::env::temp_dir();
        assert!(
            !starred(
                &dir,
                None,
                &Settings::default(),
                &Environment::fixed([]),
                &input,
                true
            )
            .await,
            "another host cannot star"
        );
        let bad = SourceControlStarredInput {
            provider: "github".into(),
            host: "github.com".into(),
            repository: "../repos".into(),
        };
        assert!(
            !starred(
                &dir,
                None,
                &Settings::default(),
                &Environment::fixed([]),
                &bad,
                false
            )
            .await,
            "an invalid repository asks nothing"
        );
    }
}
