//! Whether a terminal's shell runs anything (`deriveSubprocessInspectResult`,
//! `Manager.ts:804`): one process table read with `ps`, then each terminal's children.

use std::collections::HashMap;
use std::io;
use std::time::Duration;

/// `CLOSE_IDLE_QUERY_TIMEOUT.posix`: a stuck table read keeps every terminal open.
const QUERY_TIMEOUT: Duration = Duration::from_secs(1);

/// `POSIX_PS_ABSOLUTE_PATHS`, before a bare `ps`.
const PS_PATHS: [&str; 2] = ["/bin/ps", "/usr/bin/ps"];

/// A root with one of these names is still an interactive shell, e.g. after `.bashrc` runs
/// `exec zsh` (`INTERACTIVE_SHELL_NAMES`, `Manager.ts:791`).
const INTERACTIVE_SHELL_NAMES: [&str; 10] = [
    "bash", "zsh", "fish", "sh", "dash", "ksh", "mksh", "tcsh", "csh", "nu",
];

/// `TerminalProcessTableSnapshot`: each process's children and command name.
#[derive(Debug, Default)]
pub(crate) struct ProcessTable {
    children: HashMap<i32, Vec<i32>>,
    names: HashMap<i32, String>,
}

impl ProcessTable {
    /// `parsePosixProcessTable`: `pid ppid comm` lines; the name may hold spaces.
    pub(crate) fn parse(stdout: &str) -> Self {
        let mut table = Self::default();
        for line in stdout.lines() {
            let mut fields = line.split_whitespace();
            let (Some(pid), Some(parent)) = (fields.next(), fields.next()) else {
                continue;
            };
            let (Ok(pid), Ok(parent)) = (pid.parse::<i32>(), parent.parse::<i32>()) else {
                continue;
            };
            let name = fields.collect::<Vec<_>>().join(" ");
            if name.is_empty() {
                continue;
            }
            table.names.insert(pid, name);
            table.children.entry(parent).or_default().push(pid);
        }
        table
    }

    fn name(&self, pid: i32) -> Option<&str> {
        self.names.get(&pid).and_then(|name| command_name(name))
    }

    /// `hasRunningSubprocess` for the terminal whose shell is `pid`, started as `shell`. A
    /// shell replaced by `exec <command>` counts as running it. A childless child with the
    /// shell's own name is an async prompt helper, unless another process group holds the
    /// terminal: `foreground` is the PTY's foreground group, `None` when it cannot be read.
    pub(crate) fn has_running_subprocess(
        &self,
        pid: i32,
        shell: Option<&str>,
        foreground: Option<i32>,
    ) -> bool {
        let own = self.name(pid);
        let root_is_command = match (shell.and_then(command_name), own) {
            (Some(shell), Some(own)) => {
                own != shell && !INTERACTIVE_SHELL_NAMES.contains(&own.trim_start_matches('-'))
            }
            _ => false,
        };
        root_is_command
            || self.children.get(&pid).is_some_and(|children| {
                children.iter().any(|&child| {
                    own.is_none()
                        || self.name(child) != own
                        || self.children.get(&child).is_some_and(|c| !c.is_empty())
                        || foreground != Some(pid)
                })
            })
    }
}

/// `normalizeChildCommandName`: without brackets and folders, as `ps` may print it.
fn command_name(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    let trimmed = if (trimmed.starts_with('[') && trimmed.ends_with(']'))
        || (trimmed.starts_with('(') && trimmed.ends_with(')'))
    {
        trimmed[1..trimmed.len() - 1].trim()
    } else {
        trimmed
    };
    let name = trimmed.rsplit('/').next().unwrap_or(trimmed).trim();
    (!name.is_empty()).then_some(name)
}

/// `posixProcessTableSnapshot` within `closeIdle`'s budget. A failed, timed-out or unsuccessful
/// read is an error, never a partial table.
pub(crate) async fn process_table() -> io::Result<ProcessTable> {
    let mut ps = "ps";
    for path in PS_PATHS {
        if tokio::fs::try_exists(path).await.unwrap_or(false) {
            ps = path;
            break;
        }
    }
    let output = tokio::process::Command::new(ps)
        .args(["-eo", "pid=,ppid=,comm="])
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(QUERY_TIMEOUT, output)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "ps timed out"))??;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "ps exited with {}",
            output.status
        )));
    }
    Ok(ProcessTable::parse(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `Manager.test.ts`'s `deriveSubprocessInspectResult` cases.
    #[test]
    fn running_subprocess_follows_t3() {
        let table = ProcessTable::parse(
            "  10     1 /bin/bash\n  11    10 node\n  20     1 zsh\n  21    20 zsh\n\
               30     1 bash\n  31    30 bash\n  32    31 git\n  40     1 node\n\
               50     1 -zsh\n  60     1 (sh)\n  70     1 Google Chrome Helper\n  71    70 sleep\n\
               garbage line\n",
        );
        let cases = [
            (
                10_i32,
                Some("/bin/bash"),
                Some(10_i32),
                true,
                "a child command",
            ),
            (
                20,
                Some("/bin/zsh"),
                Some(20),
                false,
                "a childless prompt helper",
            ),
            (
                20,
                Some("/bin/zsh"),
                Some(21),
                true,
                "a same-name child in the foreground",
            ),
            (
                20,
                Some("/bin/zsh"),
                None,
                true,
                "an unknown foreground counts",
            ),
            (
                30,
                Some("/bin/bash"),
                Some(30),
                true,
                "a same-name child with children",
            ),
            (
                40,
                Some("/bin/bash"),
                Some(40),
                true,
                "exec node replaced the shell",
            ),
            (
                50,
                Some("/bin/bash"),
                Some(50),
                false,
                "exec zsh from .bashrc, a login name",
            ),
            (
                60,
                Some("/bin/sh"),
                Some(60),
                false,
                "a bracketed name, no children",
            ),
            (70, Some("/bin/sh"), Some(70), true, "names with spaces"),
            (99, Some("/bin/sh"), Some(99), false, "an unknown process"),
        ];
        for (pid, shell, foreground, want, case) in cases {
            assert_eq!(
                table.has_running_subprocess(pid, shell, foreground),
                want,
                "{case}"
            );
        }
        assert_eq!(command_name(" [kworker/0:1] "), Some("0:1"));
        assert_eq!(command_name("-zsh"), Some("-zsh"));
        assert_eq!(command_name("  "), None);
    }
}
