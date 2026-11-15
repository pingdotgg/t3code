//! A host CLI call outside discovery (`glab api`, `az repos`, `origin auth token`, ...), as
//! `VcsProcess.run` runs it for a driver: the server's environment plus
//! `safe.bareRepository=explicit`, 30 s and 1,000,000 bytes by default.

use std::{ffi::OsString, path::Path, time::Duration};

use conn_vcs::process::{GitCommand, OnLimit, ProcessError};

use crate::discovery::{ALL_EXIT_CODES, classify_exit_detail};

/// `VcsProcess.ts` defaults.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
pub const DEFAULT_MAX_OUTPUT_BYTES: usize = 1_000_000;

/// One CLI call.
#[derive(Clone, Debug)]
pub struct CliCall<'a> {
    pub operation: &'static str,
    pub program: &'a str,
    pub args: Vec<String>,
    pub cwd: &'a Path,
    pub timeout: Duration,
    /// Added to the server's environment. A credential goes here only through
    /// [`crate::Secret::expose`].
    pub env: Vec<(&'static str, OsString)>,
    pub stdin: Option<Vec<u8>>,
    /// Exit codes other than 0 return the output instead of failing.
    pub allow_non_zero_exit: bool,
}

impl<'a> CliCall<'a> {
    pub fn new(
        operation: &'static str,
        program: &'a str,
        args: impl IntoIterator<Item = impl Into<String>>,
        cwd: &'a Path,
    ) -> Self {
        Self {
            operation,
            program,
            args: args.into_iter().map(Into::into).collect(),
            cwd,
            timeout: DEFAULT_TIMEOUT,
            env: Vec::new(),
            stdin: None,
            allow_non_zero_exit: false,
        }
    }
}

/// What a finished call printed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CliOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Why a call failed. The stderr of an exit is kept for classification only; it never goes
/// into a client's error text.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CliFailure {
    #[error("{program} is not on PATH")]
    Missing { program: String },
    #[error("{program} exited with {code}: {detail}")]
    Exit {
        program: String,
        code: i32,
        detail: &'static str,
        stderr: String,
    },
    #[error("{program} timed out")]
    Timeout { program: String },
    #[error("{program} failed: {message}")]
    Failed { program: String, message: String },
}

impl CliFailure {
    pub fn stderr(&self) -> &str {
        match self {
            CliFailure::Exit { stderr, .. } => stderr,
            _ => "",
        }
    }
}

pub async fn run(call: CliCall<'_>) -> Result<CliOutput, CliFailure> {
    let program = call.program.to_owned();
    let mut command = GitCommand::host_cli(
        call.operation,
        call.program,
        call.cwd,
        call.args.iter().map(OsString::from),
    )
    .timeout(call.timeout)
    .max_stdout(DEFAULT_MAX_OUTPUT_BYTES, OnLimit::Fail);
    if call.allow_non_zero_exit {
        command = command.allow_exit(ALL_EXIT_CODES);
    }
    command.env = call.env;
    command.stdin = call.stdin;
    match command.run().await {
        Ok(output) => Ok(CliOutput {
            stdout: output.stdout_text(),
            stderr: output.stderr,
            exit_code: output.code,
        }),
        Err(ProcessError::Spawn {
            not_found: true, ..
        }) => Err(CliFailure::Missing { program }),
        Err(ProcessError::Timeout { .. }) => Err(CliFailure::Timeout { program }),
        Err(ProcessError::Exit { code, stderr, .. }) => Err(CliFailure::Exit {
            program,
            code,
            detail: classify_exit_detail(&stderr),
            stderr,
        }),
        Err(error) => Err(CliFailure::Failed {
            program,
            message: error.to_string(),
        }),
    }
}
