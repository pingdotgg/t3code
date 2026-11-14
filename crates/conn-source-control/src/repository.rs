//! `sourceControl.lookupRepository`, `cloneRepository` and `publishRepository`, as
//! `apps/server/src/sourceControl/SourceControlRepositoryService.ts` serves them.
//!
//! The host part (a repository's clone URLs, a new repository) goes through
//! [`RepositoryHosts`]; the server passes [`crate::hosts::Hosts`], tests a fake. Every other
//! step is `git`: the clone (its own child, see [`run_clone`]), the remote, the push.
//!
//! What reaches the client: a host's failure reads as T3's fixed "could not be completed" text
//! unless the host gives a user-facing detail (only Bitbucket's "workspace/repository"
//! complaint does); git's stderr only through the redacted last lines of a failed clone; a
//! failed push only through T3's fixed texts.

use std::{
    collections::VecDeque,
    ffi::OsString,
    future::Future,
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use conn_contract::{
    ProjectCloneStartInputProtocol as Protocol, SourceControlCloneRepositoryInput,
    SourceControlCloneRepositoryResult, SourceControlPublishRepositoryInput,
    SourceControlPublishRepositoryResult, SourceControlPublishStatus, SourceControlRepositoryError,
    SourceControlRepositoryInfo, SourceControlRepositoryLookupInput,
    SourceControlRepositoryVisibility, lit,
};
use conn_vcs::{
    error::classify,
    process::{GitCommand, ProcessError, explicit_bare_repository_env},
};
use tokio::{io::AsyncReadExt, process::Command};

use crate::remote::{
    CloneProtocol, clone_url_for_protocol, clone_url_protocol, normalize_clone_url,
    redact_remote_url, redact_url_credentials, repository_key_from_remote,
};

/// `CLONE_TIMEOUT_MS`.
pub const CLONE_TIMEOUT: Duration = Duration::from_secs(120);
const GENERIC_DETAIL: &str = "The source control operation could not be completed.";
const UNKNOWN: &str = "unknown";
/// Git's stderr lines kept for a failed clone's text (`stderrTail`).
const STDERR_TAIL_LINES: usize = 4;
/// The most of one stderr line, and of the text classified, that a clone keeps.
const MAX_LINE_BYTES: usize = 64 * 1024;

/// `SourceControlRepositoryCloneUrls`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloneUrls {
    pub name_with_owner: String,
    pub url: String,
    pub ssh_url: String,
}

/// A host operation that failed. `user_facing` is the host error's `userFacingDetail`, the only
/// part of it a client sees.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{detail}")]
pub struct HostFailure {
    pub detail: String,
    pub user_facing: Option<String>,
}

impl HostFailure {
    pub fn new(detail: impl Into<String>) -> Self {
        Self {
            detail: detail.into(),
            user_facing: None,
        }
    }

    pub fn user_facing(detail: impl Into<String>) -> Self {
        let detail = detail.into();
        Self {
            user_facing: Some(detail.clone()),
            detail,
        }
    }
}

pub type HostResult<T> = Result<T, HostFailure>;

/// The host half of the service (`SourceControlProvider.getRepositoryCloneUrls` and
/// `createRepository`), by provider kind.
pub trait RepositoryHosts: Sync {
    fn clone_urls(
        &self,
        kind: &str,
        cwd: &Path,
        repository: &str,
    ) -> impl Future<Output = HostResult<CloneUrls>> + Send;

    fn create_repository(
        &self,
        kind: &str,
        cwd: &Path,
        repository: &str,
        visibility: SourceControlRepositoryVisibility,
    ) -> impl Future<Output = HostResult<CloneUrls>> + Send;
}

/// `SourceControlRepositoryError` before it goes on the wire. `ssh_rejected` is the
/// `GitCommandError` reason the clone fallback reads.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{operation} failed for {provider}: {detail}")]
pub struct RepositoryError {
    pub provider: String,
    pub operation: &'static str,
    pub detail: String,
    ssh_rejected: bool,
}

impl RepositoryError {
    fn new(operation: &'static str, provider: &str, detail: impl Into<String>) -> Self {
        Self {
            provider: provider.to_owned(),
            operation,
            detail: detail.into(),
            ssh_rejected: false,
        }
    }

    /// `mapRepositoryError` for a failure that is not already a repository error.
    fn generic(operation: &'static str, provider: &str) -> Self {
        Self::new(operation, provider, GENERIC_DETAIL)
    }

    fn from_host(operation: &'static str, provider: &str, failure: HostFailure) -> Self {
        Self::new(
            operation,
            provider,
            failure.user_facing.unwrap_or_else(|| GENERIC_DETAIL.into()),
        )
    }

    /// The contract error. The T3 server also sends a `cause`; clients read `detail`.
    pub fn to_contract(&self) -> SourceControlRepositoryError {
        SourceControlRepositoryError {
            tag: lit::SourceControlRepositoryError,
            provider: self.provider.clone(),
            operation: self.operation.into(),
            detail: self.detail.clone(),
            cause: None,
        }
    }
}

pub type RepositoryResult<T> = Result<T, RepositoryError>;

/// What the service reads besides its input.
#[derive(Clone, Copy, Debug)]
pub struct ServiceContext<'a> {
    /// `config.cwd`: where a lookup without a `cwd` runs.
    pub server_cwd: &'a Path,
    /// The process's working folder, against which `path.resolve` reads a relative destination.
    pub process_cwd: &'a Path,
    pub home: Option<&'a Path>,
    /// Added to every `git` child. Empty in the server; tests put a stub first on `PATH`.
    pub child_env: &'a [(&'static str, OsString)],
    pub clone_timeout: Duration,
}

fn info(provider: &str, urls: &CloneUrls) -> SourceControlRepositoryInfo {
    SourceControlRepositoryInfo {
        provider: provider.to_owned(),
        name_with_owner: urls.name_with_owner.clone(),
        url: urls.url.clone(),
        ssh_url: urls.ssh_url.clone(),
    }
}

/// `selectRemoteUrl`: SSH unless HTTPS is asked for.
fn select_remote_url(urls: &CloneUrls, protocol: Option<&Protocol>) -> String {
    match protocol {
        Some(Protocol::Https) => urls.url.clone(),
        _ => urls.ssh_url.clone(),
    }
}

fn is_ssh(protocol: Option<&Protocol>) -> bool {
    matches!(protocol, Some(Protocol::Ssh))
}

/// `ensureConcreteProvider`.
fn concrete(operation: &'static str, provider: &str) -> RepositoryResult<()> {
    if provider == UNKNOWN {
        return Err(RepositoryError::new(
            operation,
            provider,
            "Choose a source control provider before continuing.",
        ));
    }
    Ok(())
}

/// `lookupRepository`.
pub async fn lookup<H: RepositoryHosts>(
    hosts: &H,
    ctx: ServiceContext<'_>,
    input: &SourceControlRepositoryLookupInput,
) -> RepositoryResult<SourceControlRepositoryInfo> {
    let provider = input.provider.trim();
    concrete("lookupRepository", provider)?;
    let cwd = input
        .cwd
        .as_deref()
        .map(str::trim)
        .map_or_else(|| ctx.server_cwd.to_owned(), PathBuf::from);
    let urls = hosts
        .clone_urls(provider, &cwd, input.repository.trim())
        .await
        .map_err(|failure| RepositoryError::from_host("lookupRepository", provider, failure))?;
    Ok(info(provider, &urls))
}

/// `expandHomePath` then `path.resolve`.
fn resolve_destination(ctx: ServiceContext<'_>, destination: &str) -> PathBuf {
    let expanded = match (destination, ctx.home) {
        ("~", Some(home)) => home.to_owned(),
        (path, Some(home)) if path.starts_with("~/") || path.starts_with("~\\") => {
            home.join(path.get(2..).unwrap_or_default())
        }
        (path, _) => PathBuf::from(path),
    };
    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        ctx.process_cwd.join(expanded)
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// What `prepareDestination` finds.
#[derive(Debug)]
enum Destination {
    Ready,
    NotDirectory,
    NotEmpty,
    Failed,
}

/// `prepareDestination`: an empty folder, or a missing path whose parent then exists.
fn prepare_destination_blocking(destination: &Path) -> Destination {
    match std::fs::metadata(destination) {
        Ok(_) => match std::fs::read_dir(destination) {
            Ok(mut entries) => {
                if entries.next().is_some() {
                    Destination::NotEmpty
                } else {
                    Destination::Ready
                }
            }
            Err(_) => Destination::NotDirectory,
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let Some(parent) = destination.parent() else {
                return Destination::Ready;
            };
            match std::fs::metadata(parent) {
                Ok(_) => Destination::Ready,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    match std::fs::create_dir_all(parent) {
                        Ok(()) => Destination::Ready,
                        Err(_) => Destination::Failed,
                    }
                }
                Err(_) => Destination::Failed,
            }
        }
        // A probe failure is not a missing path.
        Err(_) => Destination::Failed,
    }
}

/// `prepareClone`'s answer.
#[derive(Clone, Debug)]
struct PreparedClone {
    destination: PathBuf,
    remote_url: String,
    clone_url: String,
    repository: Option<SourceControlRepositoryInfo>,
}

async fn prepare_clone<H: RepositoryHosts>(
    hosts: &H,
    ctx: ServiceContext<'_>,
    input: &SourceControlCloneRepositoryInput,
    provider: &str,
) -> RepositoryResult<PreparedClone> {
    let destination = resolve_destination(ctx, input.destination_path.trim());
    let probe = destination.clone();
    let state = tokio::task::spawn_blocking(move || prepare_destination_blocking(&probe))
        .await
        .unwrap_or(Destination::Failed);
    let refuse = |detail: &str| RepositoryError::new("cloneRepository", UNKNOWN, detail);
    match state {
        Destination::Ready => {}
        Destination::NotDirectory => {
            return Err(refuse(
                "Destination path already exists and is not a directory.",
            ));
        }
        Destination::NotEmpty => {
            return Err(refuse("Destination path already exists and is not empty."));
        }
        Destination::Failed => return Err(RepositoryError::generic("cloneRepository", provider)),
    }
    let parent = destination
        .parent()
        .map_or_else(|| destination.clone(), Path::to_path_buf);
    let mut remote_url = input
        .remote_url
        .as_deref()
        .map(|u| u.trim().to_owned())
        .filter(|u| !u.is_empty());
    let mut repository = None;
    if let (Some(kind), Some(name)) = (input.provider.as_deref(), input.repository.as_deref()) {
        // The inner `lookupRepository`: its own refusal keeps its operation; a host failure is
        // mapped by the clone's forwarder.
        let kind = kind.trim();
        concrete("lookupRepository", kind)?;
        let urls = hosts
            .clone_urls(kind, &parent, name.trim())
            .await
            .map_err(|failure| RepositoryError::from_host("cloneRepository", provider, failure))?;
        remote_url = Some(select_remote_url(&urls, input.protocol.as_ref()));
        repository = Some(info(kind, &urls));
    }
    let Some(clone_url) = remote_url else {
        return Err(RepositoryError::new(
            "cloneRepository",
            provider,
            "Enter a repository path or clone URL before cloning.",
        ));
    };
    Ok(PreparedClone {
        destination,
        remote_url: redact_remote_url(&clone_url),
        clone_url,
        repository,
    })
}

/// `httpsFallbackUrl`: the HTTPS URL to retry a refused SSH clone with, unless SSH was asked
/// for or the URL cannot be rewritten.
fn https_fallback_url(
    input: &SourceControlCloneRepositoryInput,
    prepared: &PreparedClone,
) -> Option<String> {
    if is_ssh(input.protocol.as_ref())
        || clone_url_protocol(&prepared.clone_url) != Some(CloneProtocol::Ssh)
    {
        return None;
    }
    if let Some(repository) = &prepared.repository
        && repository.ssh_url == prepared.clone_url
    {
        return Some(repository.url.clone());
    }
    clone_url_for_protocol(&prepared.clone_url, CloneProtocol::Https)
}

/// `cloneRepository`, with T3's two-minute deadline in `ctx.clone_timeout`.
pub async fn clone<H: RepositoryHosts>(
    hosts: &H,
    ctx: ServiceContext<'_>,
    input: &SourceControlCloneRepositoryInput,
) -> RepositoryResult<SourceControlCloneRepositoryResult> {
    let provider = input
        .provider
        .as_deref()
        .map_or(UNKNOWN, str::trim)
        .to_owned();
    let prepared = prepare_clone(hosts, ctx, input, &provider).await?;
    let https = https_fallback_url(input, &prepared);
    let first = run_clone(ctx, &provider, &prepared.destination, &prepared.clone_url).await;
    let remote_url = match (first, https) {
        (Ok(()), _) => prepared.remote_url.clone(),
        (Err(ssh_error), Some(https_url)) if ssh_error.ssh_rejected => {
            match run_clone(ctx, &provider, &prepared.destination, &https_url).await {
                Ok(()) => redact_remote_url(&https_url),
                Err(https_error) => {
                    return Err(RepositoryError {
                        detail: format!(
                            "{} Cloning over HTTPS instead also failed: {}",
                            ssh_error.detail, https_error.detail
                        ),
                        ssh_rejected: https_error.ssh_rejected,
                        ..ssh_error
                    });
                }
            }
        }
        (Err(error), _) => return Err(error),
    };
    Ok(SourceControlCloneRepositoryResult {
        cwd: prepared.destination.to_string_lossy().into_owned(),
        remote_url,
        repository: prepared.repository,
    })
}

/// What a clone's stderr left: the last non-progress lines, redacted, and the text git's
/// failure reason is read from. Every part is bounded.
#[derive(Debug, Default)]
struct CloneStderr {
    tail: VecDeque<String>,
    classified: String,
    pending: Vec<u8>,
}

/// `parseGitCloneProgressLine` is not null: the line starts with a progress stage.
fn is_progress_line(line: &str) -> bool {
    [
        "remote: Enumerating objects",
        "remote: Counting objects",
        "remote: Compressing objects",
        "Receiving objects",
        "Resolving deltas",
        "Updating files",
        "Checking out files",
    ]
    .iter()
    .any(|prefix| line.starts_with(prefix))
}

impl CloneStderr {
    /// `onStderrLine` in `runClone`.
    fn line(&mut self, raw: &[u8]) {
        let text = String::from_utf8_lossy(raw);
        let line = text.trim();
        if line.is_empty() || is_progress_line(line) || line.starts_with("Cloning into") {
            return;
        }
        if self.classified.len() + line.len() < MAX_LINE_BYTES {
            self.classified.push_str(line);
            self.classified.push('\n');
        }
        self.tail.push_back(redact_url_credentials(line));
        if self.tail.len() > STDERR_TAIL_LINES {
            self.tail.pop_front();
        }
    }

    /// Splits on `\r\n`, `\r` and `\n`: a bare `\r` is a progress redraw.
    fn feed(&mut self, chunk: &[u8], end: bool) {
        self.pending.extend_from_slice(chunk);
        let mut start = 0;
        let mut index = 0;
        while let Some(&byte) = self.pending.get(index) {
            if byte != b'\n' && byte != b'\r' {
                index += 1;
                continue;
            }
            // A `\r` at the end of a chunk may be the first half of `\r\n`.
            if byte == b'\r' && index + 1 == self.pending.len() && !end {
                break;
            }
            let line = self.pending.get(start..index).unwrap_or_default().to_vec();
            self.line(&line);
            let crlf = byte == b'\r' && self.pending.get(index + 1) == Some(&b'\n');
            index += if crlf { 2 } else { 1 };
            start = index;
        }
        self.pending.drain(..start.min(self.pending.len()));
        if end && !self.pending.is_empty() {
            let rest = std::mem::take(&mut self.pending);
            self.line(&rest);
        }
        self.pending.truncate(MAX_LINE_BYTES);
    }
}

/// `runClone`: `git clone --progress -- <url> <name>` in the destination's parent, with
/// `CLONE_ENV`, stderr read line by line.
async fn run_clone(
    ctx: ServiceContext<'_>,
    provider: &str,
    destination: &Path,
    clone_url: &str,
) -> RepositoryResult<()> {
    let parent = destination.parent().unwrap_or(destination);
    let name = destination.file_name().unwrap_or_default();
    let mut command = Command::new("git");
    command
        .arg("clone")
        .arg("--progress")
        .arg("--")
        .arg(normalize_clone_url(clone_url))
        .arg(name)
        .current_dir(parent)
        .env("GIT_OPTIONAL_LOCKS", "0");
    for (key, value) in explicit_bare_repository_env() {
        command.env(key, value);
    }
    command
        // Piped progress at once; no credential prompt that would hang without a tty; English
        // progress without overriding LC_CTYPE, which a global post-checkout hook inherits.
        .env("GIT_PROGRESS_DELAY", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LANGUAGE", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in ctx.child_env {
        command.env(key, value);
    }
    let failed = |stderr: &CloneStderr| {
        let detail = if stderr.tail.is_empty() {
            "The repository could not be cloned.".to_owned()
        } else {
            stderr.tail.iter().cloned().collect::<Vec<_>>().join(" ")
        };
        RepositoryError {
            provider: provider.to_owned(),
            operation: "cloneRepository",
            detail,
            ssh_rejected: matches!(
                classify(&stderr.classified),
                Some("authentication_failed" | "host_key_unverified")
            ),
        }
    };
    let Ok(mut child) = command.spawn() else {
        return Err(failed(&CloneStderr::default()));
    };
    let mut stdout = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let mut stderr = CloneStderr::default();
    let work = async {
        let drain_stdout = async {
            if let Some(out) = stdout.as_mut() {
                let mut sink = [0u8; 4096];
                while matches!(out.read(&mut sink).await, Ok(n) if n > 0) {}
            }
        };
        let read_stderr = async {
            if let Some(err) = stderr_pipe.as_mut() {
                let mut buffer = [0u8; 4096];
                while let Ok(n) = err.read(&mut buffer).await {
                    if n == 0 {
                        break;
                    }
                    stderr.feed(buffer.get(..n).unwrap_or_default(), false);
                }
            }
            stderr.feed(&[], true);
        };
        tokio::join!(drain_stdout, read_stderr);
        child.wait().await
    };
    let outcome = tokio::time::timeout(ctx.clone_timeout, work).await;
    match outcome {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(_) => Err(failed(&stderr)),
        // Dropping the child kills it.
        Err(_) => Err(RepositoryError::new(
            "cloneRepository",
            provider,
            format!(
                "The clone timed out after {}.",
                format_duration(ctx.clone_timeout)
            ),
        )),
    }
}

/// Effect's `Duration.format` for whole units: `2m`, `1h 5m`, `30s`, `500ms`.
fn format_duration(duration: Duration) -> String {
    let millis = duration.as_millis();
    let parts = [
        (millis / 86_400_000, "d"),
        (millis / 3_600_000 % 24, "h"),
        (millis / 60_000 % 60, "m"),
        (millis / 1000 % 60, "s"),
        (millis % 1000, "ms"),
    ];
    let text: Vec<String> = parts
        .iter()
        .filter(|(n, _)| *n > 0)
        .map(|(n, unit)| format!("{n}{unit}"))
        .collect();
    if text.is_empty() {
        "0".into()
    } else {
        text.join(" ")
    }
}

fn git(ctx: ServiceContext<'_>, operation: &'static str, cwd: &Path, args: &[&str]) -> GitCommand {
    let mut command = GitCommand::new(operation, cwd, args.iter().copied());
    command.env = ctx.child_env.to_vec();
    command
}

/// The checked-out branch (also an unborn one), `None` on a detached HEAD.
async fn current_branch(ctx: ServiceContext<'_>, cwd: &Path) -> Option<String> {
    let head = git(
        ctx,
        "GitVcsDriver.statusDetails",
        cwd,
        &["symbolic-ref", "--quiet", "HEAD"],
    )
    .text()
    .await
    .ok()?;
    head.trim().strip_prefix("refs/heads/").map(str::to_owned)
}

/// `parseRemoteFetchUrls`: each remote's fetch URL from `git remote -v`, in order.
fn remote_fetch_urls(stdout: &str) -> Vec<(String, String)> {
    let mut remotes: Vec<(String, String)> = Vec::new();
    for line in stdout.lines() {
        let Some((name, rest)) = line.split_once('\t') else {
            continue;
        };
        if name.is_empty() || name.chars().any(char::is_whitespace) {
            continue;
        }
        // `<url> (fetch)`, with an optional ` [filter]` after it on a partial clone.
        let rest = match rest.rfind(" [") {
            Some(i) if rest.ends_with(']') => rest.get(..i).unwrap_or(rest),
            _ => rest,
        };
        let Some(url) = rest.strip_suffix(" (fetch)") else {
            continue;
        };
        if url.is_empty() {
            continue;
        }
        match remotes.iter_mut().find(|(n, _)| n == name) {
            Some(entry) => url.clone_into(&mut entry.1),
            None => remotes.push((name.to_owned(), url.to_owned())),
        }
    }
    remotes
}

/// `sanitizeRemoteName`.
fn sanitize_remote_name(value: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in value.trim().chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    let sanitized = out.trim_matches('-');
    if sanitized.is_empty() {
        "fork".into()
    } else {
        sanitized.to_owned()
    }
}

/// `retryWhileConfigLocked`: up to 10 more tries, 50 ms apart.
async fn with_config_retry(command: GitCommand) -> Result<(), ProcessError> {
    let mut tries = 0;
    loop {
        match command.clone().run().await {
            Ok(_) => return Ok(()),
            Err(error) if tries < 10 && classify(error.stderr()) == Some("config_locked") => {
                tries += 1;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

/// `ensureRemote`: the remote that already points at the repository, else a new one named
/// after `preferred` (with `-1`, `-2`, ... when the name is taken).
async fn ensure_remote(
    ctx: ServiceContext<'_>,
    cwd: &Path,
    preferred: &str,
    url: &str,
) -> Result<String, ProcessError> {
    let preferred = sanitize_remote_name(preferred);
    let target = repository_key_from_remote(url);
    let list = || {
        git(
            ctx,
            "GitVcsDriver.ensureRemote.listRemoteUrls",
            cwd,
            &["remote", "-v"],
        )
    };
    let find = |remotes: &[(String, String)]| {
        remotes
            .iter()
            .find(|(_, u)| repository_key_from_remote(u) == target)
            .map(|(n, _)| n.clone())
    };
    let remotes = remote_fetch_urls(&list().text().await?);
    if let Some(existing) = find(&remotes) {
        return Ok(existing);
    }
    let mut name = preferred.clone();
    let mut suffix = 1;
    while remotes.iter().any(|(n, _)| *n == name) {
        name = format!("{preferred}-{suffix}");
        suffix += 1;
    }
    let add = git(
        ctx,
        "GitVcsDriver.ensureRemote.add",
        cwd,
        &["remote", "add", "--", &name, url],
    );
    match with_config_retry(add).await {
        Ok(()) => Ok(name),
        // A parallel launch for the same fork may have added it since the listing above.
        Err(error) => match list().text().await.map(|t| find(&remote_fetch_urls(&t))) {
            Ok(Some(added)) => Ok(added),
            _ => Err(error),
        },
    }
}

/// Why a push failed, as `publishPushFailureDetail` reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PushFailure {
    Authentication,
    HostKey,
    Other,
}

/// `pushCurrentBranch(cwd, null, { remoteName })`: push HEAD to the branch of the same name,
/// then record the upstream. Returns the branch.
async fn push_current_branch(
    ctx: ServiceContext<'_>,
    cwd: &Path,
    remote: &str,
) -> Result<String, PushFailure> {
    // "Cannot push from detached HEAD." has no reason.
    let branch = current_branch(ctx, cwd).await.ok_or(PushFailure::Other)?;
    let remote_names = git(ctx, "GitVcsDriver.listRemoteNames", cwd, &["remote"])
        .text()
        .await
        .map(|text| {
            text.lines()
                .map(|l| l.trim().to_owned())
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    // `resolvePublishBranchName`: a branch named `<remote>/<name>` publishes as `<name>`.
    let publish = remote_names
        .iter()
        .find_map(|r| {
            branch
                .trim()
                .strip_prefix(&format!("{r}/"))
                .map(str::trim)
                .filter(|b| !b.is_empty())
        })
        .unwrap_or(&branch)
        .to_owned();
    let refspec = format!("HEAD:refs/heads/{publish}");
    // `timeoutMs: null`: a push has no deadline.
    let push = git(
        ctx,
        "GitVcsDriver.pushCurrentBranch.pushWithRequestedRemote",
        cwd,
        &["push", "--", remote, &refspec],
    )
    .timeout(Duration::MAX);
    if let Err(error) = push.run().await {
        return Err(match classify(error.stderr()) {
            Some("authentication_failed") => PushFailure::Authentication,
            Some("host_key_unverified") => PushFailure::HostKey,
            _ => PushFailure::Other,
        });
    }
    record_pushed_upstream(ctx, cwd, &branch, remote, &publish).await;
    Ok(branch)
}

/// `recordPushedUpstream`. T3 only logs a failure; this server ignores it.
async fn record_pushed_upstream(
    ctx: ServiceContext<'_>,
    cwd: &Path,
    branch: &str,
    remote: &str,
    publish: &str,
) {
    let write = |key: &str, value: &str| {
        git(
            ctx,
            "GitVcsDriver.writeConfigValue",
            cwd,
            &["config", key, value],
        )
    };
    let merge = format!("refs/heads/{publish}");
    if with_config_retry(write(&format!("branch.{branch}.merge"), &merge))
        .await
        .is_err()
        || with_config_retry(write(&format!("branch.{branch}.remote"), remote))
            .await
            .is_err()
    {
        return;
    }
    let rebase = git(
        ctx,
        "GitVcsDriver.readConfigValue",
        cwd,
        &["config", "--get", "branch.autoSetupRebase"],
    )
    .text()
    .await
    .ok();
    if matches!(rebase.as_deref().map(str::trim), Some("always" | "remote")) {
        let _ = with_config_retry(write(&format!("branch.{branch}.rebase"), "true")).await;
    }
}

/// `publishPushFailureDetail`: fixed text, because git's stderr can hold credentials.
fn push_failure_detail(
    urls: &CloneUrls,
    remote_name: &str,
    remote_url: &str,
    failure: PushFailure,
) -> String {
    let created = format!(
        "Created {} and added it as remote \"{remote_name}\", but the push failed",
        urls.name_with_owner
    );
    let switch_to_https = format!("git remote set-url {remote_name} {}", urls.url);
    match failure {
        PushFailure::Authentication if remote_url == urls.ssh_url => format!(
            "{created} because SSH authentication was rejected. Add an SSH key to your account, or switch the remote to HTTPS with \"{switch_to_https}\", then push again."
        ),
        PushFailure::Authentication => format!(
            "{created} because Git could not authenticate. Check your Git credentials, then push again."
        ),
        PushFailure::HostKey => format!(
            "{created} because the host's SSH key is not trusted yet. Verify it by connecting once with ssh, or switch the remote to HTTPS with \"{switch_to_https}\", then push again."
        ),
        PushFailure::Other => format!("{created}. Fix the problem, then push again."),
    }
}

/// `publishRepository`: create the repository on the host, add it as a remote, push.
pub async fn publish<H: RepositoryHosts>(
    hosts: &H,
    ctx: ServiceContext<'_>,
    input: &SourceControlPublishRepositoryInput,
) -> RepositoryResult<SourceControlPublishRepositoryResult> {
    let provider = input.provider.trim();
    concrete("publishRepository", provider)?;
    let cwd = PathBuf::from(input.cwd.trim());
    let urls = hosts
        .create_repository(provider, &cwd, input.repository.trim(), input.visibility)
        .await
        .map_err(|failure| RepositoryError::from_host("publishRepository", provider, failure))?;
    let remote_url = select_remote_url(&urls, input.protocol.as_ref());
    let preferred = input
        .remote_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or("origin");
    let remote_name = ensure_remote(ctx, &cwd, preferred, &remote_url)
        .await
        .map_err(|_| RepositoryError::generic("publishRepository", provider))?;
    let repository = info(provider, &urls);

    // An empty repository cannot push HEAD; the remote exists, so report a partial success.
    let has_commits = git(
        ctx,
        "SourceControlRepositoryService.publishRepository.headCheck",
        &cwd,
        &["rev-parse", "--verify", "HEAD"],
    )
    .run()
    .await
    .is_ok();
    if !has_commits {
        let branch = current_branch(ctx, &cwd)
            .await
            .unwrap_or_else(|| "main".into());
        return Ok(SourceControlPublishRepositoryResult {
            repository,
            remote_name,
            remote_url,
            branch,
            status: SourceControlPublishStatus::RemoteAdded,
        });
    }

    let failed = |pushed_url: &str, failure| {
        RepositoryError::new(
            "publishRepository",
            provider,
            push_failure_detail(&urls, &remote_name, pushed_url, failure),
        )
    };
    let (branch, pushed_url) = match push_current_branch(ctx, &cwd, &remote_name).await {
        Ok(branch) => (branch, remote_url),
        Err(failure) => {
            // Like clone, an auto-selected SSH remote switches to HTTPS when SSH is refused;
            // otherwise every later fetch and push would fail the same way.
            let can_switch = !is_ssh(input.protocol.as_ref()) && remote_url == urls.ssh_url;
            let rejected = matches!(failure, PushFailure::Authentication | PushFailure::HostKey);
            if !(can_switch && rejected) {
                return Err(failed(&remote_url, failure));
            }
            let switched = git(
                ctx,
                "SourceControlRepositoryService.publishRepository.switchToHttps",
                &cwd,
                &["remote", "set-url", &remote_name, &urls.url],
            )
            .run()
            .await;
            if switched.is_err() {
                return Err(failed(&remote_url, failure));
            }
            match push_current_branch(ctx, &cwd, &remote_name).await {
                Ok(branch) => (branch, urls.url.clone()),
                Err(second) => return Err(failed(&urls.url, second)),
            }
        }
    };
    Ok(SourceControlPublishRepositoryResult {
        repository,
        remote_name,
        remote_url: pushed_url,
        branch,
        status: SourceControlPublishStatus::Pushed,
    })
}

#[cfg(test)]
#[path = "repository_tests.rs"]
mod tests;
