//! The login shell's environment, so a stdio server finds the same `npx`, `php`, or `uvx` a
//! terminal finds. Conn's desktop reads it once at launch (`DesktopShellEnvironment.ts`) and
//! installs it into its own process; a GUI app started from Finder has only launchd's PATH.

use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::sync::OnceCell;

/// The variables taken from the login shell (Conn's `LOGIN_SHELL_ENV_NAMES`).
const LOGIN_SHELL_ENV_NAMES: &[&str] = &[
    "PATH",
    "ANDROID_HOME",
    "ANDROID_SDK_ROOT",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SSH_AUTH_SOCK",
    "HOMEBREW_PREFIX",
    "HOMEBREW_CELLAR",
    "HOMEBREW_REPOSITORY",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "JAVA_HOME",
    "PNPM_HOME",
];

const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(5);
const START_MARKER: &str = "__CONN_GPUI_ENV_START__";
const END_MARKER: &str = "__CONN_GPUI_ENV_END__";

static LOGIN_SHELL_ENV: OnceCell<HashMap<String, String>> = OnceCell::const_new();

/// This process's environment with the login shell's variables on top (PATHs merged, the
/// shell's first). Read once; later calls reuse it.
pub async fn login_shell_environment() -> HashMap<String, String> {
    let shell = LOGIN_SHELL_ENV.get_or_init(read_login_shell).await;
    let mut env: HashMap<String, String> = std::env::vars().collect();
    for (name, value) in shell {
        let merged = if name == "PATH" {
            merge_paths(value, env.get("PATH").map(String::as_str))
        } else {
            value.clone()
        };
        env.insert(name.clone(), merged);
    }
    env
}

async fn read_login_shell() -> HashMap<String, String> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|shell| !shell.trim().is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_owned());
    let mut command = Command::new(&shell);
    command
        .arg("-ilc")
        .arg(capture_script())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let Ok(child) = command.spawn() else {
        return HashMap::new();
    };
    match tokio::time::timeout(LOGIN_SHELL_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => parse_capture(&String::from_utf8_lossy(&output.stdout)),
        _ => HashMap::new(),
    }
}

/// Prints `NAME=value` NUL-separated between markers, so profile output cannot confuse it.
fn capture_script() -> String {
    let mut script = format!("printf '\\n{START_MARKER}\\n';");
    for name in LOGIN_SHELL_ENV_NAMES {
        script.push_str(&format!(
            " if [ -n \"${{{name}+x}}\" ]; then printf '%s=%s\\0' '{name}' \"${name}\"; fi;"
        ));
    }
    script.push_str(&format!(" printf '\\n{END_MARKER}\\n'"));
    script
}

fn parse_capture(output: &str) -> HashMap<String, String> {
    let Some(start) = output.find(START_MARKER) else {
        return HashMap::new();
    };
    let body = &output[start + START_MARKER.len()..];
    let Some(end) = body.find(END_MARKER) else {
        return HashMap::new();
    };
    body[..end]
        .trim_start_matches('\n')
        .split('\0')
        .filter_map(|pair| pair.split_once('='))
        .filter(|(name, _)| LOGIN_SHELL_ENV_NAMES.contains(name))
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect()
}

/// The shell's PATH, then any of the process's own entries it lacks.
fn merge_paths(shell: &str, process: Option<&str>) -> String {
    let mut entries: Vec<&str> = Vec::new();
    for entry in shell.split(':').chain(process.unwrap_or("").split(':')) {
        if !entry.is_empty() && !entries.contains(&entry) {
            entries.push(entry);
        }
    }
    entries.join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_between_markers() {
        let output = format!(
            "motd PATH=/evil\n{START_MARKER}\nPATH=/a:/b\0LANG=en_US.UTF-8\0OTHER=x\0\n{END_MARKER}\n"
        );
        let env = parse_capture(&output);
        assert_eq!(env.get("PATH").map(String::as_str), Some("/a:/b"), "PATH");
        assert_eq!(
            env.get("LANG").map(String::as_str),
            Some("en_US.UTF-8"),
            "LANG"
        );
        assert!(!env.contains_key("OTHER"), "only listed names");
    }

    #[test]
    fn merges_paths_shell_first() {
        assert_eq!(
            merge_paths("/opt/homebrew/bin:/usr/bin", Some("/usr/bin:/bin")),
            "/opt/homebrew/bin:/usr/bin:/bin",
            "merged"
        );
    }

    #[tokio::test]
    async fn reads_the_login_shell() {
        let env = login_shell_environment().await;
        assert!(
            env.get("PATH").is_some_and(|path| !path.is_empty()),
            "has a PATH"
        );
    }
}
