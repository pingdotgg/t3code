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
    SourceControlAppAccess, SourceControlAppAccessStatus, SourceControlCloneRepositoryInput,
    SourceControlDiscoveryResult, SourceControlPublishRepositoryInput,
    SourceControlRepositoryLookupInput, SourceControlSignInError, SourceControlSignInFailure,
    SourceControlSignInInput, SourceControlStarredInput, lit,
};
use conn_source_control::{
    hosts::{self, DiscoveryContext, Endpoints, Environment, Hosts},
    repository::{self, CLONE_TIMEOUT, RepositoryError, ServiceContext},
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

fn host_inputs(deps: &Deps) -> HostInputs {
    let environment = deps.environment.clone();
    HostInputs {
        cwd: Arc::from(
            environment
                .as_ref()
                .map_or_else(std::env::temp_dir, |e| e.cwd.clone()),
        ),
        home: std::env::var_os("HOME").map(|h| Arc::from(PathBuf::from(h))),
        environment,
    }
}

/// `sourceControl.cloneRepository` for `t3_project_clone` (`conn_mcp::McpConfig`).
pub(crate) fn clone_host(deps: &Deps) -> conn_mcp::MethodHost {
    let inputs = host_inputs(deps);
    Arc::new(move |input: Value| {
        let host = inputs.clone();
        Box::pin(async move {
            let input: SourceControlCloneRepositoryInput = conn_contract::from_json(input)
                .map_err(|e| serde_json::json!({"_tag": "SourceControlRepositoryError", "detail": e.to_string()}))?;
            let call = RepositoryCall::new(&host);
            repository::clone(&call.hosts(&host), call.service(&host), &input)
                .await
                .map(|result| conn_contract::to_json(&result))
                .map_err(|e| conn_contract::to_json(&e.to_contract()))
        }) as conn_engine::BoxFuture<'static, Result<Value, Value>>
    })
}

pub(super) fn register(table: &mut MethodTable, deps: &Deps) {
    let inputs = host_inputs(deps);

    let host = inputs.clone();
    table.unary("server.discoverSourceControl", move |_, _: Value| {
        let host = host.clone();
        let settings = host.settings();
        async move {
            refresh_login_path().await;
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

    register_repositories(table, &inputs, deps);

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

/// What a repository call needs, built once per call: the hosts read the settings of the
/// moment, and the process's working folder resolves a relative clone destination.
#[derive(Debug)]
struct RepositoryCall {
    settings: Settings,
    env: Environment,
    endpoints: Endpoints,
    process_cwd: PathBuf,
}

impl RepositoryCall {
    fn new(inputs: &HostInputs) -> Self {
        Self {
            settings: inputs.settings(),
            env: Environment::process(),
            endpoints: Endpoints::default(),
            process_cwd: std::env::current_dir().unwrap_or_else(|_| inputs.cwd.to_path_buf()),
        }
    }

    fn hosts<'a>(&'a self, inputs: &'a HostInputs) -> Hosts<'a> {
        Hosts {
            ctx: DiscoveryContext {
                cwd: &inputs.cwd,
                home: inputs.home.as_deref(),
                settings: &self.settings,
                env: &self.env,
                endpoints: &self.endpoints,
                child_env: &[],
            },
        }
    }

    fn service<'a>(&'a self, inputs: &'a HostInputs) -> ServiceContext<'a> {
        ServiceContext {
            server_cwd: &inputs.cwd,
            process_cwd: &self.process_cwd,
            home: inputs.home.as_deref(),
            child_env: &[],
            clone_timeout: CLONE_TIMEOUT,
        }
    }
}

fn repository_failure(error: &RepositoryError) -> Failure {
    Failure::fail(&error.to_contract())
}

/// `sourceControl.lookupRepository`, `cloneRepository`, `publishRepository`
/// (`SourceControlRepositoryService.ts`), for GitHub.
fn register_repositories(table: &mut MethodTable, inputs: &HostInputs, deps: &Deps) {
    let host = inputs.clone();
    table.unary(
        "sourceControl.lookupRepository",
        move |_, input: SourceControlRepositoryLookupInput| {
            let host = host.clone();
            async move {
                let call = RepositoryCall::new(&host);
                repository::lookup(&call.hosts(&host), call.service(&host), &input)
                    .await
                    .map_err(|e| repository_failure(&e))
            }
        },
    );
    let host = inputs.clone();
    table.unary(
        "sourceControl.cloneRepository",
        move |_, input: SourceControlCloneRepositoryInput| {
            let host = host.clone();
            async move {
                let call = RepositoryCall::new(&host);
                repository::clone(&call.hosts(&host), call.service(&host), &input)
                    .await
                    .map_err(|e| repository_failure(&e))
            }
        },
    );
    let host = inputs.clone();
    let hub = deps.vcs.hub.clone();
    table.unary(
        "sourceControl.publishRepository",
        move |_, input: SourceControlPublishRepositoryInput| {
            let host = host.clone();
            let hub = hub.clone();
            async move {
                let call = RepositoryCall::new(&host);
                let result =
                    repository::publish(&call.hosts(&host), call.service(&host), &input).await;
                // A failed push still leaves the new remote added (`Effect.ensuring` in ws.ts).
                let _ = hub
                    .refresh_status(input.cwd.trim(), conn_vcs::hub::Remote::Read)
                    .await;
                result.map_err(|e| repository_failure(&e))
            }
        },
    );
}

/// `refreshPathFromLoginShell` before discovery, at most every 10 s, so a CLI installed since
/// the start is found here and by every later child (`conn_support::login_env`).
async fn refresh_login_path() {
    use conn_support::login_env;
    if !(cfg!(target_os = "macos") || cfg!(target_os = "linux")) {
        return;
    }
    static LOGIN_REFRESH: LoginRefresh = LoginRefresh::new();
    LOGIN_REFRESH
        .run(|| async {
            let Some(shell) = login_env::login_shell(std::env::var_os("SHELL").as_deref(), None)
            else {
                return;
            };
            let _ =
                tokio::task::spawn_blocking(move || login_env::refresh(&shell, login_env::TIMEOUT))
                    .await;
        })
        .await;
}

/// One login-shell refresh at a time, and none within [`login_env::REFRESH_TTL`] of the last
/// one's end. A caller that arrives while a refresh runs waits for it and then uses its result,
/// as `Effect.cachedWithTTL` does in the T3 server's discovery.
///
/// [`login_env::REFRESH_TTL`]: conn_support::login_env::REFRESH_TTL
struct LoginRefresh {
    /// When the last refresh ended. The lock is held across a refresh.
    finished_at: tokio::sync::Mutex<Option<std::time::Instant>>,
}

impl LoginRefresh {
    const fn new() -> Self {
        Self {
            finished_at: tokio::sync::Mutex::const_new(None),
        }
    }

    async fn run<F, Fut>(&self, refresh: F)
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        let mut finished_at = self.finished_at.lock().await;
        let fresh =
            finished_at.is_some_and(|at| at.elapsed() < conn_support::login_env::REFRESH_TTL);
        if fresh {
            return;
        }
        refresh().await;
        *finished_at = Some(std::time::Instant::now());
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

/// `SourceControlDiscovery.discover`: `git`, `jj` and GitHub.
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

    /// A caller that arrives while a refresh runs waits for it and runs none of its own.
    #[tokio::test(flavor = "current_thread")]
    async fn concurrent_login_refreshes_coalesce() {
        use std::{cell::RefCell, time::Duration};
        let refresher = LoginRefresh::new();
        let events = RefCell::new(Vec::new());
        let first = async {
            refresher
                .run(|| async {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    events.borrow_mut().push("first refreshed");
                })
                .await;
        };
        let second = async {
            tokio::task::yield_now().await;
            refresher
                .run(|| async { events.borrow_mut().push("second refreshed") })
                .await;
            events.borrow_mut().push("second returned");
        };
        tokio::join!(first, second);
        assert_eq!(*events.borrow(), ["first refreshed", "second returned"]);
        // Within the window, a later caller runs no refresh either.
        refresher
            .run(|| async { events.borrow_mut().push("third refreshed") })
            .await;
        assert_eq!(events.borrow().len(), 2);
    }

    /// The answer has git, jj and GitHub. No host CLI
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
        assert_eq!(kinds("sourceControlProviders"), ["github"], "hosts");
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
        let other = sign_in_refusal(&sign_in("unknown", "example.com"), SignInStep::Cancel);
        assert_eq!(
            other.reason,
            SourceControlSignInFailure::Unsupported,
            "other host"
        );
        assert_eq!(
            other.detail, "This server cannot sign in to unknown. Use a token or the host's CLI.",
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
            provider: "unknown".into(),
            host: "example.com".into(),
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
