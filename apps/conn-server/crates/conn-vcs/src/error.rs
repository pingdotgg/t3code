//! Errors of this crate and their contract shapes.
//!
//! Git stderr can echo credentials from argv and remote URLs, so no stderr text reaches a
//! contract error: only a fixed `reason` from [`classify`], as `GitCommandError` does.

use conn_contract::support::JsNumber;
use conn_contract::{
    GitActionProgressStream, GitCommandError, ReviewGetDiffPreviewError, VcsDriverKind,
    VcsInitError, VcsProcessExitError, VcsProcessExitErrorFailureKind, VcsProcessOutputLimitError,
    VcsProcessSpawnError, VcsProcessTimeoutError, VcsUnsupportedOperationError, lit,
};
use serde_json::Value;

use crate::process::{ProcessContext, ProcessError};

/// A failure of one VCS operation.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum VcsError {
    /// A `git` child failed.
    #[error(transparent)]
    Process(#[from] ProcessError),
    /// A precondition failed before or between git commands (bad input, not a repo, ...).
    #[error("{operation}: {detail}")]
    Invalid {
        operation: &'static str,
        cwd: String,
        detail: String,
        reason: Option<&'static str>,
    },
    #[error("{operation}: {detail}")]
    Unsupported {
        operation: &'static str,
        kind: VcsDriverKind,
        detail: String,
    },
}

pub type VcsResult<T> = Result<T, VcsError>;

impl VcsError {
    pub fn invalid(operation: &'static str, cwd: &str, detail: impl Into<String>) -> Self {
        VcsError::Invalid {
            operation,
            cwd: cwd.to_owned(),
            detail: detail.into(),
            reason: None,
        }
    }

    pub fn with_reason(mut self, why: &'static str) -> Self {
        if let VcsError::Invalid { reason, .. } = &mut self {
            *reason = Some(why);
        }
        self
    }

    /// The fixed failure reason, from stderr for a process exit.
    pub fn reason(&self) -> Option<&'static str> {
        match self {
            VcsError::Process(ProcessError::Exit { stderr, .. }) => classify(stderr),
            VcsError::Invalid { reason, .. } => *reason,
            _ => None,
        }
    }

    /// `GitCommandError`, the error of `vcs.*` and `subscribeVcs*`.
    pub fn to_git_command_error(&self) -> GitCommandError {
        let reason = self.reason().map(|r| Value::String(r.into()));
        match self {
            VcsError::Process(error) => {
                let c = error.context();
                let (exit_code, stderr_length, detail) = match error {
                    ProcessError::Exit { code, stderr, .. } => (
                        Some(JsNumber(f64::from(*code))),
                        Some(JsNumber(stderr.len() as f64)),
                        format!("{} failed with exit code {code}.", c.command),
                    ),
                    ProcessError::Timeout { timeout_ms, .. } => (
                        None,
                        None,
                        format!("{} timed out after {timeout_ms}ms.", c.command),
                    ),
                    ProcessError::OutputLimit { max_bytes, .. } => (
                        None,
                        None,
                        format!("{} output exceeded {max_bytes} bytes.", c.command),
                    ),
                    ProcessError::Spawn { .. } => {
                        (None, None, format!("{} could not start.", c.command))
                    }
                };
                GitCommandError {
                    tag: lit::GitCommandError,
                    operation: c.operation.into(),
                    command: c.command.clone(),
                    cwd: c.cwd.clone(),
                    argument_count: Some(JsNumber(c.argument_count as f64)),
                    exit_code,
                    stdout_length: None,
                    stderr_length,
                    output_length: None,
                    reason,
                    detail,
                    cause: None,
                }
            }
            VcsError::Invalid {
                operation,
                cwd,
                detail,
                ..
            } => GitCommandError {
                tag: lit::GitCommandError,
                operation: (*operation).into(),
                command: "git".into(),
                cwd: cwd.clone(),
                argument_count: None,
                exit_code: None,
                stdout_length: None,
                stderr_length: None,
                output_length: None,
                reason,
                detail: detail.clone(),
                cause: None,
            },
            VcsError::Unsupported {
                operation, detail, ..
            } => GitCommandError {
                tag: lit::GitCommandError,
                operation: (*operation).into(),
                command: "git".into(),
                cwd: String::new(),
                argument_count: None,
                exit_code: None,
                stdout_length: None,
                stderr_length: None,
                output_length: None,
                reason: None,
                detail: detail.clone(),
                cause: None,
            },
        }
    }

    /// `ReviewGetDiffPreviewError`: the process errors as `VcsProcess*Error`, others as
    /// `GitCommandError`.
    pub fn to_review_error(&self) -> ReviewGetDiffPreviewError {
        match self {
            VcsError::Process(error) => match process_error(error) {
                ProcessErrorShape::Spawn(e) => ReviewGetDiffPreviewError::VcsProcessSpawnError(e),
                ProcessErrorShape::Exit(e) => ReviewGetDiffPreviewError::VcsProcessExitError(e),
                ProcessErrorShape::Timeout(e) => {
                    ReviewGetDiffPreviewError::VcsProcessTimeoutError(e)
                }
                ProcessErrorShape::Limit(e) => {
                    ReviewGetDiffPreviewError::VcsProcessOutputLimitError(e)
                }
            },
            VcsError::Unsupported {
                operation,
                kind,
                detail,
            } => ReviewGetDiffPreviewError::VcsUnsupportedOperationError(unsupported(
                operation, *kind, detail,
            )),
            VcsError::Invalid { .. } => {
                ReviewGetDiffPreviewError::GitCommandError(self.to_git_command_error())
            }
        }
    }

    /// `VcsInitError` for `vcs.init`.
    pub fn to_init_error(&self) -> VcsInitError {
        match self {
            VcsError::Process(error) => match process_error(error) {
                ProcessErrorShape::Spawn(e) => VcsInitError::VcsProcessSpawnError(e),
                ProcessErrorShape::Exit(e) => VcsInitError::VcsProcessExitError(e),
                ProcessErrorShape::Timeout(e) => VcsInitError::VcsProcessTimeoutError(e),
                ProcessErrorShape::Limit(e) => VcsInitError::VcsProcessOutputLimitError(e),
            },
            VcsError::Unsupported {
                operation,
                kind,
                detail,
            } => VcsInitError::VcsUnsupportedOperationError(unsupported(operation, *kind, detail)),
            VcsError::Invalid {
                operation, detail, ..
            } => VcsInitError::VcsUnsupportedOperationError(unsupported(
                operation,
                VcsDriverKind::Git,
                detail,
            )),
        }
    }
}

fn unsupported(operation: &str, kind: VcsDriverKind, detail: &str) -> VcsUnsupportedOperationError {
    VcsUnsupportedOperationError {
        tag: lit::VcsUnsupportedOperationError,
        operation: operation.into(),
        kind,
        detail: detail.into(),
    }
}

enum ProcessErrorShape {
    Spawn(VcsProcessSpawnError),
    Exit(VcsProcessExitError),
    Timeout(VcsProcessTimeoutError),
    Limit(VcsProcessOutputLimitError),
}

fn process_error(error: &ProcessError) -> ProcessErrorShape {
    let ProcessContext {
        operation,
        command,
        cwd,
        argument_count,
    } = error.context().clone();
    match error {
        ProcessError::Spawn { message, .. } => ProcessErrorShape::Spawn(VcsProcessSpawnError {
            tag: lit::VcsProcessSpawnError,
            operation: operation.into(),
            command,
            cwd,
            argument_count: Some(argument_count as i64),
            cause: serde_json::json!({ "message": message }),
        }),
        ProcessError::Exit {
            code,
            stderr,
            stderr_truncated,
            ..
        } => {
            let kind = failure_kind(stderr);
            ProcessErrorShape::Exit(VcsProcessExitError {
                tag: lit::VcsProcessExitError,
                operation: operation.into(),
                command,
                cwd,
                argument_count: Some(argument_count as i64),
                exit_code: JsNumber(f64::from(*code)),
                detail: match kind {
                    VcsProcessExitErrorFailureKind::Authentication => "Authentication failed.",
                    VcsProcessExitErrorFailureKind::RateLimited => "API rate limit exceeded.",
                    VcsProcessExitErrorFailureKind::NotFound => "VCS resource not found.",
                    VcsProcessExitErrorFailureKind::CommandFailed => {
                        "Process exited with a non-zero status."
                    }
                }
                .into(),
                failure_kind: Some(kind),
                retryable: None,
                stderr_length: Some(stderr.len() as i64),
                stderr_truncated: Some(*stderr_truncated),
            })
        }
        ProcessError::Timeout { timeout_ms, .. } => {
            ProcessErrorShape::Timeout(VcsProcessTimeoutError {
                tag: lit::VcsProcessTimeoutError,
                operation: operation.into(),
                command,
                cwd,
                argument_count: Some(argument_count as i64),
                timeout_ms: JsNumber(*timeout_ms as f64),
            })
        }
        ProcessError::OutputLimit {
            max_bytes,
            observed_bytes,
            ..
        } => ProcessErrorShape::Limit(VcsProcessOutputLimitError {
            tag: lit::VcsProcessOutputLimitError,
            operation: operation.into(),
            command,
            cwd,
            argument_count: Some(argument_count as i64),
            stream: GitActionProgressStream::Stdout,
            max_bytes: *max_bytes as i64,
            observed_bytes: *observed_bytes as i64,
        }),
    }
}

fn failure_kind(stderr: &str) -> VcsProcessExitErrorFailureKind {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("authentication failed")
        || lower.contains("could not read username")
        || lower.contains("permission denied (publickey)")
    {
        VcsProcessExitErrorFailureKind::Authentication
    } else if lower.contains("rate limit") {
        VcsProcessExitErrorFailureKind::RateLimited
    } else {
        VcsProcessExitErrorFailureKind::CommandFailed
    }
}

/// `GitCommandFailureReason` from git's stderr. Only these fixed strings reach the client.
pub fn classify(stderr: &str) -> Option<&'static str> {
    let s = stderr.to_ascii_lowercase();
    let has = |needle: &str| s.contains(needle);
    Some(if has("not a git repository") {
        "not_a_repository"
    } else if has("authentication failed")
        || has("could not read username")
        || has("permission denied (publickey)")
    {
        "authentication_failed"
    } else if has("host key verification failed") {
        "host_key_unverified"
    } else if has("could not resolve host")
        || has("unable to access")
        || has("could not read from remote repository")
        || has("connection refused")
        || has("connection timed out")
    {
        "remote_unreachable"
    } else if has("is already checked out at") || has("is already used by worktree at") {
        "branch_checked_out_in_worktree"
    } else if has("a branch named") && has("already exists") {
        "branch_already_exists"
    } else if has("already exists") {
        "path_already_exists"
    } else if has("could not lock config file") {
        "config_locked"
    } else if has("cannot lock ref") || has("is not a valid branch name") && has("exists") {
        "ref_name_conflict"
    } else if has("invalid reference")
        || has("did not match any")
        || has("unknown revision")
        || has("not a valid object name")
        || has("bad revision")
    {
        "ref_not_found"
    } else if has("would clobber existing tag") {
        "tag_would_be_clobbered"
    } else if has("non-fast-forward") || has("fetch first") {
        "push_rejected_non_fast_forward"
    } else if has("[remote rejected]") || has("pre-receive hook declined") {
        "push_rejected_by_remote"
    } else {
        return None;
    })
}
