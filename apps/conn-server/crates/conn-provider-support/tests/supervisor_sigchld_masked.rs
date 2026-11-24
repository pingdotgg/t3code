//! The process supervisor in a process where every thread blocks SIGCHLD, so no exit ever
//! wakes it by signal. It must still see the child's exit, report it and reap it. Its own
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
        cases::an_exit_is_reported().await;
        cases::a_killed_child_is_reaped().await;
    });
    println!("supervisor_sigchld_masked: ok");
}

#[cfg(not(unix))]
fn main() {}

#[cfg(unix)]
mod cases {
    use std::time::Duration;

    use conn_provider_support::process::{LaunchSpec, ProcEvent, Process, wait_gone};
    use tokio::sync::mpsc;

    fn sh(script: &str) -> LaunchSpec {
        LaunchSpec {
            program: "sh".into(),
            args: vec!["-c".into(), script.into()],
            ..LaunchSpec::default()
        }
    }

    async fn exit_code(events: &mut mpsc::Receiver<ProcEvent>) -> Option<Option<i32>> {
        let exited = async {
            loop {
                match events.recv().await {
                    Some(ProcEvent::Exited(info)) => return Some(info.code),
                    Some(ProcEvent::Line(_)) => {}
                    None => return None,
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(5), exited)
            .await
            .ok()
            .flatten()
    }

    /// The child exits on its own; the supervisor reports it without a SIGCHLD.
    pub(crate) async fn an_exit_is_reported() {
        let (tx, mut events) = mpsc::channel(8);
        let process = Process::spawn(&sh("exit 3"), 1024, tx).expect("spawn");
        assert_eq!(
            exit_code(&mut events).await,
            Some(Some(3)),
            "the exit went unseen"
        );
        assert!(process.has_exited(), "the supervisor did not finish");
    }

    /// The child is killed; the supervisor still reaps it and its pid is gone.
    pub(crate) async fn a_killed_child_is_reaped() {
        let (tx, mut events) = mpsc::channel(8);
        let process = Process::spawn(&sh("sleep 30"), 1024, tx).expect("spawn");
        let pid = process.pid;
        process.kill();
        assert_eq!(
            exit_code(&mut events).await,
            Some(None),
            "the kill went unseen"
        );
        assert!(
            wait_gone(pid, Duration::from_secs(5)).await,
            "{pid} not reaped"
        );
    }
}
