//! Probes in a process where every thread blocks SIGCHLD, so no exit ever wakes a waiter by
//! signal. A probe must still see the CLI's exit and reap it well before its timeout. Its own
//! binary (`harness = false`): the mask must be set before any thread starts.

#[cfg(unix)]
fn main() {
    use nix::sys::signal::{SigSet, Signal};
    let mut set = SigSet::empty();
    set.add(Signal::SIGCHLD);
    set.thread_block().expect("block SIGCHLD");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a runtime");
    runtime.block_on(async {
        cases::a_quick_cli_completes().await;
        cases::a_killed_cli_is_reaped().await;
    });
    println!("sigchld_masked: ok");
}

#[cfg(not(unix))]
fn main() {}

#[cfg(unix)]
mod cases {
    use std::time::{Duration, Instant};

    use conn_provider_support::probe::{CommandOutput, spawn_and_collect};

    fn path_env() -> Vec<(String, String)> {
        std::env::vars().filter(|(k, _)| k == "PATH").collect()
    }

    /// The CLI exits at once; the probe returns its output long before the 10 s timeout.
    pub(crate) async fn a_quick_cli_completes() {
        let started = Instant::now();
        let out = tokio::time::timeout(
            Duration::from_secs(20),
            spawn_and_collect(
                "sh",
                &["-c", "echo hi"],
                &path_env(),
                None,
                Duration::from_secs(10),
            ),
        )
        .await
        .expect("the probe returned")
        .expect("the probe ran");
        let elapsed = started.elapsed();
        assert_eq!(
            out,
            Some(CommandOutput {
                stdout: "hi\n".into(),
                stderr: String::new(),
                code: 0,
            }),
            "a quick CLI completes"
        );
        assert!(
            elapsed < Duration::from_secs(3),
            "the exit went unseen: {elapsed:?}"
        );
    }

    /// The CLI ignores SIGTERM, so it ends by the group SIGKILL; the probe still reaps it.
    pub(crate) async fn a_killed_cli_is_reaped() {
        let started = Instant::now();
        let out = tokio::time::timeout(
            Duration::from_secs(10),
            spawn_and_collect(
                "sh",
                &["-c", "trap '' TERM; sleep 30"],
                &path_env(),
                None,
                Duration::from_millis(200),
            ),
        )
        .await
        .expect("the probe returned")
        .expect("the probe ran");
        let elapsed = started.elapsed();
        assert_eq!(out, None, "a hung CLI times out");
        assert!(
            elapsed < Duration::from_secs(4),
            "the reap waited for a SIGCHLD: {elapsed:?}"
        );
    }
}
