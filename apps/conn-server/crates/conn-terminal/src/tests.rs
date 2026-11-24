//! Real shells on real PTYs. Each test waits for events, never for a fixed time.

use std::time::Duration;

use super::*;
use conn_contract::TerminalAttachStreamEvent as E;

const WAIT: Duration = Duration::from_secs(15);

fn config() -> TerminalConfig {
    TerminalConfig {
        shells: vec!["/bin/sh".into()],
        poll_interval: Duration::from_millis(50),
        kill_grace: Duration::from_millis(500),
        persist_delay: Duration::from_millis(10),
        ..TerminalConfig::default()
    }
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("conn-terminal-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn open_input(thread: &str, terminal: &str) -> TerminalOpenInput {
    TerminalOpenInput {
        thread_id: thread.into(),
        terminal_id: terminal.into(),
        cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        worktree_path: None,
        cols: Some(80),
        rows: Some(24),
        // No history file: an interactive /bin/sh would write ~/.bash_history in the real home.
        env: Some(Map::from([
            ("PS1".to_owned(), "$ ".to_owned()),
            ("HISTFILE".to_owned(), "/dev/null".to_owned()),
        ])),
        provider_instance_id: None,
        stop_on_settle: None,
    }
}

fn attach_input(thread: &str, terminal: &str) -> TerminalAttachInput {
    TerminalAttachInput {
        thread_id: thread.into(),
        terminal_id: terminal.into(),
        cwd: Some(std::env::temp_dir().to_string_lossy().into_owned()),
        worktree_path: None,
        cols: None,
        rows: None,
        // No history file: an interactive /bin/sh would write ~/.bash_history in the real home.
        env: Some(Map::from([
            ("PS1".to_owned(), "$ ".to_owned()),
            ("HISTFILE".to_owned(), "/dev/null".to_owned()),
        ])),
        provider_instance_id: None,
        stop_on_settle: None,
        restart_if_not_running: None,
        resume: None,
        max_history_bytes: None,
    }
}

fn session(thread: &str, terminal: &str) -> TerminalClearInput {
    TerminalClearInput {
        thread_id: thread.into(),
        terminal_id: terminal.into(),
    }
}

fn write_input(thread: &str, terminal: &str, data: &str) -> TerminalWriteInput {
    TerminalWriteInput {
        thread_id: thread.into(),
        terminal_id: terminal.into(),
        data: data.into(),
        binary: None,
        reply: None,
    }
}

async fn write(manager: &TerminalManager, thread: &str, terminal: &str, data: &str) {
    manager
        .write(write_input(thread, terminal, data), None)
        .await
        .unwrap();
}

/// A query reply (`reply: true`) as viewer `viewer` writes it.
async fn reply(manager: &TerminalManager, viewer: ViewerId, data: &str) {
    let mut input = write_input("t9", "term-1", data);
    input.reply = Some(true);
    manager.write(input, Some(viewer)).await.unwrap();
}

/// Events until `done` matches one; returns them all, the match last.
async fn until(sub: &mut Subscription, done: impl Fn(&E) -> bool) -> Vec<E> {
    let mut seen = Vec::new();
    tokio::time::timeout(WAIT, async {
        loop {
            let event = sub.next().await;
            let stop = done(&event);
            seen.push(event);
            if stop {
                return;
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out; saw {seen:#?}"));
    seen
}

/// Waits until the output seen so far contains `text`.
async fn output_contains(sub: &mut Subscription, text: &str) -> String {
    let mut all = String::new();
    tokio::time::timeout(WAIT, async {
        loop {
            match sub.next().await {
                E::Output(o) => all.push_str(&o.data),
                E::Snapshot(s) => all.push_str(&s.snapshot.history),
                _ => {}
            }
            if all.contains(text) {
                return;
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {text:?}; saw {all:?}"));
    all
}

fn alive(pid: i64) -> bool {
    let pid = rustix::process::Pid::from_raw(pid as i32).unwrap();
    rustix::process::test_kill_process(pid).is_ok()
}

async fn until_dead(pid: i64) {
    tokio::time::timeout(WAIT, async {
        while alive(pid) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        let ps = std::process::Command::new("ps")
            .args(["-o", "pid=,ppid=,pgid=,stat=,comm=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        panic!("still running: {}", String::from_utf8_lossy(&ps.stdout))
    });
}

#[tokio::test(flavor = "current_thread")]
async fn runs_a_shell_from_open_to_close() {
    let manager = TerminalManager::new(config());
    let mut metadata = manager.subscribe_metadata();
    let first = metadata.next().await;
    assert!(matches!(first, TerminalMetadataStreamEvent::Snapshot(s) if s.terminals.is_empty()));

    let snapshot = manager.open(open_input("t1", "term-1")).unwrap();
    assert_eq!(snapshot.status, TerminalSessionStatus::Running);
    assert_eq!(snapshot.label, "Terminal 1");
    assert_eq!((snapshot.cols, snapshot.rows), (Some(80), Some(24)));
    let pid = snapshot.pid.unwrap();
    assert!(
        matches!(metadata.next().await, TerminalMetadataStreamEvent::Upsert(u) if u.terminal.pid == Some(pid))
    );

    let mut sub = manager.attach(attach_input("t1", "term-1"), 1).unwrap();
    assert!(matches!(sub.next().await, E::Snapshot(s) if s.snapshot.pid == Some(pid)));
    write(&manager, "t1", "term-1", "echo hello-$((40+2))\n").await;
    output_contains(&mut sub, "hello-42").await;

    // Opening again returns the running shell.
    assert_eq!(
        manager.open(open_input("t1", "term-1")).unwrap().pid,
        Some(pid)
    );

    // The PTY really changes size.
    manager
        .resize(
            TerminalResizeInput {
                thread_id: "t1".into(),
                terminal_id: "term-1".into(),
                cols: 100,
                rows: 40,
            },
            None,
        )
        .unwrap();
    let events = until(&mut sub, |e| matches!(e, E::Activity(_))).await;
    let E::Activity(activity) = events.last().unwrap() else {
        unreachable!()
    };
    assert_eq!((activity.cols, activity.rows), (Some(100), Some(40)));
    write(&manager, "t1", "term-1", "stty size\n").await;
    output_contains(&mut sub, "40 100").await;

    // A second viewer gets the scrollback in its snapshot.
    let mut late = manager.attach(attach_input("t1", "term-1"), 2).unwrap();
    let E::Snapshot(s) = late.next().await else {
        panic!()
    };
    assert!(s.snapshot.history.contains("hello-42"));

    manager.close(TerminalCloseInput {
        thread_id: "t1".into(),
        terminal_id: Some("term-1".into()),
        delete_history: None,
    });
    until(&mut sub, |e| matches!(e, E::Closed(_))).await;
    until(&mut late, |e| matches!(e, E::Closed(_))).await;
    until_dead(pid).await;
    assert!(manager.list().is_empty());
    loop {
        if let TerminalMetadataStreamEvent::Remove(r) = metadata.next().await {
            assert_eq!(r.terminal_id, "term-1");
            break;
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn reports_exit_and_keeps_the_scrollback() {
    let manager = TerminalManager::new(config());
    let mut sub = manager.attach(attach_input("t2", "term-1"), 1).unwrap();
    assert!(matches!(sub.next().await, E::Snapshot(_)));
    write(&manager, "t2", "term-1", "echo bye; exit 3\n").await;
    let events = until(&mut sub, |e| matches!(e, E::Exited(_))).await;
    let E::Exited(exit) = events.last().unwrap() else {
        unreachable!()
    };
    assert_eq!((exit.exit_code, exit.exit_signal), (Some(3), None));

    let listed = manager.list();
    assert_eq!(listed[0].status, TerminalSessionStatus::Exited);
    // Writing to an exited shell is a no-op, as in apps/server.
    write(&manager, "t2", "term-1", "x").await;
    let read = manager.read("t2", "term-1", None).unwrap();
    assert!(read.history.contains("bye"));
    assert_eq!(read.status, TerminalSessionStatus::Exited);

    // Attach does not restart it unless asked to.
    let mut again = manager.attach(attach_input("t2", "term-1"), 1).unwrap();
    assert!(
        matches!(again.next().await, E::Snapshot(s) if s.snapshot.status == TerminalSessionStatus::Exited)
    );
    let mut restart = attach_input("t2", "term-1");
    restart.restart_if_not_running = Some(true);
    let mut restarted = manager.attach(restart, 1).unwrap();
    let E::Snapshot(s) = restarted.next().await else {
        panic!()
    };
    assert_eq!(s.snapshot.status, TerminalSessionStatus::Running);
    // A restart starts with empty scrollback.
    assert!(!s.snapshot.history.contains("bye"));
}

#[tokio::test(flavor = "current_thread")]
async fn finds_terminals_by_id_and_respects_resume() {
    let manager = TerminalManager::new(config());
    let mut unknown = attach_input("t3", "term-1");
    unknown.cwd = None;
    assert!(matches!(
        manager.attach(unknown, 1),
        Err(TerminalOpenError::TerminalSessionLookupError(_))
    ));
    assert!(matches!(
        manager.observe(session("t3", "term-1")),
        Err(TerminalOpenError::TerminalSessionLookupError(_))
    ));
    assert!(matches!(
        manager.write(write_input("t3", "term-1", "x"), None).await,
        Err(TerminalOpenError::TerminalSessionLookupError(_))
    ));
    let mut bad = open_input("t3", "term-1");
    bad.cwd = "/definitely/not/here".into();
    assert!(matches!(
        manager.open(bad),
        Err(TerminalOpenError::TerminalCwdNotFoundError(_))
    ));
    let mut file = open_input("t3", "term-1");
    file.cwd = "/bin/sh".into();
    assert!(matches!(
        manager.open(file),
        Err(TerminalOpenError::TerminalCwdNotDirectoryError(_))
    ));

    let pid = manager
        .open(open_input("t3", "term-1"))
        .unwrap()
        .pid
        .unwrap();
    manager.close(TerminalCloseInput {
        thread_id: "t3".into(),
        terminal_id: None,
        delete_history: Some(true),
    });
    until_dead(pid).await;
    // A reconnecting client resumes: the closed terminal stays closed.
    let mut resume = attach_input("t3", "term-1");
    resume.resume = Some(true);
    let mut sub = manager.attach(resume, 1).unwrap();
    assert!(matches!(sub.next().await, E::Closed(_)));
    assert!(manager.list().is_empty());
    // A first attach opens it again, and the old stream sees the new shell.
    let mut fresh = manager.attach(attach_input("t3", "term-1"), 2).unwrap();
    assert!(
        matches!(fresh.next().await, E::Snapshot(s) if s.snapshot.status == TerminalSessionStatus::Running)
    );
    assert!(matches!(sub.next().await, E::Snapshot(_)));
    // Observers see the same terminal and cannot resize it.
    let mut observer = manager.observe(session("t3", "term-1")).unwrap();
    assert!(matches!(observer.next().await, E::Snapshot(_)));
}

#[tokio::test(flavor = "current_thread")]
async fn shares_the_smallest_viewer_grid() {
    let manager = TerminalManager::new(config());
    let mut big = attach_input("t4", "term-1");
    (big.cols, big.rows) = (Some(120), Some(40));
    let mut big = manager.attach(big, 1).unwrap();
    assert!(matches!(big.next().await, E::Snapshot(s) if s.snapshot.cols == Some(120)));
    let mut small = attach_input("t4", "term-1");
    (small.cols, small.rows) = (Some(60), Some(20));
    let small = manager.attach(small, 2).unwrap();
    let events = until(&mut big, |e| matches!(e, E::Activity(_))).await;
    assert!(
        matches!(events.last(), Some(E::Activity(a)) if (a.cols, a.rows) == (Some(60), Some(20)))
    );
    // Someone who is not a viewer cannot override the viewers' grid.
    manager
        .resize(
            TerminalResizeInput {
                thread_id: "t4".into(),
                terminal_id: "term-1".into(),
                cols: 200,
                rows: 50,
            },
            Some(99),
        )
        .unwrap();
    assert_eq!(
        manager.read("t4", "term-1", Some(0)).unwrap().cols,
        Some(60)
    );
    // The small viewer leaves: the grid grows back.
    drop(small);
    let events = until(&mut big, |e| matches!(e, E::Activity(_))).await;
    assert!(
        matches!(events.last(), Some(E::Activity(a)) if (a.cols, a.rows) == (Some(120), Some(40)))
    );
}

/// T3's "keeps a viewer's resized grid when the same viewer attaches again": a client's
/// attach retry resends its first size, which a later resize replaced.
#[tokio::test(flavor = "current_thread")]
async fn keeps_a_viewers_resized_grid_when_the_same_viewer_attaches_again() {
    let manager = TerminalManager::new(config());
    let sized = |cols: i64| {
        let mut input = attach_input("t12", "term-1");
        (input.cols, input.rows) = (Some(cols), Some(15));
        input
    };
    let grid = |e: &E| match e {
        E::Activity(a) => (a.cols, a.rows),
        _ => (None, None),
    };
    let mut wide = manager.attach(sized(130), 1).unwrap();
    let E::Snapshot(first) = wide.next().await else {
        panic!()
    };
    let pid = first.snapshot.pid;
    let phone = manager.attach(sized(54), 2).unwrap();
    until(&mut wide, |e| grid(e) == (Some(54), Some(15))).await;
    let resize = TerminalResizeInput {
        thread_id: "t12".into(),
        terminal_id: "term-1".into(),
        cols: 100,
        rows: 15,
    };
    manager.resize(resize, Some(2)).unwrap();
    until(&mut wide, |e| grid(e) == (Some(100), Some(15))).await;

    let mut retry = sized(54);
    retry.resume = Some(true);
    let retry = manager.attach(retry, 2).unwrap();
    let snapshot = manager.read("t12", "term-1", Some(0)).unwrap();
    assert_eq!((snapshot.cols, snapshot.rows), (Some(100), Some(15)));
    write(&manager, "t12", "term-1", "stty size\n").await;
    output_contains(&mut wide, "15 100").await;

    // Once the phone's last stream ends, the wide viewer's grid comes back on the same shell.
    drop(retry);
    drop(phone);
    until(&mut wide, |e| grid(e) == (Some(130), Some(15))).await;
    write(&manager, "t12", "term-1", "stty size\n").await;
    output_contains(&mut wide, "15 130").await;
    assert_eq!(manager.read("t12", "term-1", Some(0)).unwrap().pid, pid);
}

/// A viewer's grid belongs to the viewer, not to the stream that first reported it (T3's
/// `retainViewer`): it stays until the viewer's last stream closes.
#[tokio::test(flavor = "current_thread")]
async fn keeps_a_viewers_grid_while_any_of_its_streams_stays_open() {
    let manager = TerminalManager::new(config());
    let sized = |cols: i64| {
        let mut input = attach_input("t15", "term-1");
        (input.cols, input.rows) = (Some(cols), Some(15));
        input
    };
    let grid = |e: &E| match e {
        E::Activity(a) => (a.cols, a.rows),
        _ => (None, None),
    };
    let mut wide = manager.attach(sized(130), 1).unwrap();
    assert!(matches!(wide.next().await, E::Snapshot(s) if s.snapshot.cols == Some(130)));
    let unsized_stream = manager.attach(attach_input("t15", "term-1"), 2).unwrap();
    let sized_stream = manager.attach(sized(54), 2).unwrap();
    until(&mut wide, |e| grid(e) == (Some(54), Some(15))).await;

    drop(sized_stream);
    let snapshot = manager.read("t15", "term-1", Some(0)).unwrap();
    assert_eq!((snapshot.cols, snapshot.rows), (Some(54), Some(15)));
    write(&manager, "t15", "term-1", "stty size\n").await;
    output_contains(&mut wide, "15 54").await;

    drop(unsized_stream);
    until(&mut wide, |e| grid(e) == (Some(130), Some(15))).await;
}

// T3 `open`: a reused terminal keeps its grid where the input omits a dimension
// (`input.cols ?? liveSession.cols`). The desktop reruns a project action this way.
#[tokio::test(flavor = "current_thread")]
async fn reopening_without_a_size_keeps_the_live_grid() {
    let manager = TerminalManager::new(config());
    let sized = |cols, rows| {
        let mut input = open_input("t12", "term-1");
        (input.cols, input.rows) = (cols, rows);
        input
    };
    let grid = |snapshot: TerminalSessionSnapshot| (snapshot.cols, snapshot.rows);
    let first = manager.open(sized(Some(125), Some(43))).unwrap();
    let pid = first.pid;
    let mut sub = manager.observe(session("t12", "term-1")).unwrap();

    let reopened = manager.open(sized(None, None)).unwrap();
    assert_eq!(reopened.pid, pid);
    assert_eq!(grid(reopened), (Some(125), Some(43)));
    write(&manager, "t12", "term-1", "stty size\n").await;
    output_contains(&mut sub, "43 125").await;

    let cols_only = manager.open(sized(Some(110), None)).unwrap();
    assert_eq!(grid(cols_only), (Some(110), Some(43)));
    let explicit = manager.open(sized(Some(118), Some(39))).unwrap();
    assert_eq!(grid(explicit), (Some(118), Some(39)));
    write(&manager, "t12", "term-1", "stty size\n").await;
    output_contains(&mut sub, "39 118").await;

    // A viewer's grid still comes first.
    let mut viewer = attach_input("t12", "term-1");
    (viewer.cols, viewer.rows) = (Some(100), Some(30));
    let _viewer = manager.attach(viewer, 1).unwrap();
    assert_eq!(
        grid(manager.open(sized(None, None)).unwrap()),
        (Some(100), Some(30))
    );
    assert_eq!(
        grid(manager.open(sized(Some(90), Some(20))).unwrap()),
        (Some(100), Some(30))
    );

    // A new terminal without a size starts at the defaults.
    let mut fresh = sized(None, None);
    fresh.terminal_id = "term-2".into();
    assert_eq!(
        grid(manager.open(fresh).unwrap()),
        (Some(i64::from(DEFAULT_COLS)), Some(i64::from(DEFAULT_ROWS)))
    );
}

#[tokio::test(flavor = "current_thread")]
async fn bounds_scrollback_and_resyncs_a_slow_viewer() {
    let manager = TerminalManager::new(TerminalConfig {
        history_bytes: 4096,
        max_queued_bytes: 16 * 1024,
        ..config()
    });
    let mut sub = manager.attach(attach_input("t5", "term-1"), 1).unwrap();
    assert!(matches!(sub.next().await, E::Snapshot(_)));
    // 200 KB of output while nobody reads: the queue overflows.
    write(&manager, "t5", "term-1", "i=0; while [ $i -lt 2000 ]; do echo line-$i-0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890; i=$((i+1)); done; echo DONE-\"\"FLOOD\n").await;
    tokio::time::timeout(WAIT, async {
        while !manager
            .read("t5", "term-1", None)
            .unwrap()
            .history
            .contains("DONE-FLOOD")
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let history = manager.read("t5", "term-1", None).unwrap().history;
    assert!(history.len() <= 4096, "{}", history.len());
    // The slow viewer gets a fresh snapshot instead of the backlog.
    let events = until(&mut sub, |e| matches!(e, E::Snapshot(_))).await;
    let E::Snapshot(s) = events.last().unwrap() else {
        unreachable!()
    };
    assert!(s.snapshot.history.len() <= 4096);
    // maxHistoryBytes trims what a snapshot carries.
    let mut bounded = attach_input("t5", "term-1");
    bounded.max_history_bytes = Some(100);
    let mut bounded = manager.attach(bounded, 2).unwrap();
    assert!(matches!(bounded.next().await, E::Snapshot(s) if s.snapshot.history.len() <= 100));
}

#[tokio::test(flavor = "current_thread")]
async fn clears_and_reports_the_foreground_command() {
    let manager = TerminalManager::new(config());
    let mut metadata = manager.subscribe_metadata();
    let mut sub = manager.attach(attach_input("t6", "term-1"), 1).unwrap();
    assert!(matches!(sub.next().await, E::Snapshot(_)));
    write(&manager, "t6", "term-1", "echo before\n").await;
    output_contains(&mut sub, "before").await;
    manager.clear(session("t6", "term-1")).unwrap();
    until(&mut sub, |e| matches!(e, E::Cleared(_))).await;
    assert!(
        !manager
            .read("t6", "term-1", None)
            .unwrap()
            .history
            .contains("before")
    );

    write(&manager, "t6", "term-1", "sleep 30\n").await;
    tokio::time::timeout(WAIT, async {
        loop {
            if let TerminalMetadataStreamEvent::Upsert(u) = metadata.next().await
                && u.terminal.has_running_subprocess
            {
                assert_eq!(u.terminal.label, "sleep");
                return;
            }
        }
    })
    .await
    .expect("no running-subprocess upsert");
    write(&manager, "t6", "term-1", "\u{3}").await;
    tokio::time::timeout(WAIT, async {
        loop {
            if let TerminalMetadataStreamEvent::Upsert(u) = metadata.next().await
                && !u.terminal.has_running_subprocess
            {
                assert_eq!(u.terminal.label, "Terminal 1");
                return;
            }
        }
    })
    .await
    .expect("no idle upsert after Ctrl-C");
}

/// The test above, in a copy of this test binary started with SIGINT ignored, as a background
/// job of a shell without job control starts it. node-pty gives the shell default signals.
#[cfg(target_os = "linux")]
#[test]
fn ctrl_c_stops_a_command_when_the_server_ignores_sigint() {
    let exe = std::env::current_exe().unwrap();
    let output = std::process::Command::new("/bin/sh")
        .args([
            "-c",
            "trap '' INT; exec \"$0\" --exact tests::clears_and_reports_the_foreground_command",
        ])
        .arg(&exe)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test(flavor = "current_thread")]
async fn relabels_a_foreground_command_that_execs_another() {
    // The job keeps its process group when `sh` execs `sleep`: only the name changes, as when
    // a poll lands between the shell's `fork` and `exec`.
    let manager = TerminalManager::new(config());
    let mut metadata = manager.subscribe_metadata();
    let mut sub = manager.attach(attach_input("t12", "term-1"), 1).unwrap();
    assert!(matches!(sub.next().await, E::Snapshot(_)));
    write(
        &manager,
        "t12",
        "term-1",
        "sh -c 'sleep 1; exec sleep 30'\n",
    )
    .await;
    let mut labels = Vec::new();
    tokio::time::timeout(WAIT, async {
        loop {
            if let TerminalMetadataStreamEvent::Upsert(u) = metadata.next().await
                && u.terminal.has_running_subprocess
            {
                labels.push(u.terminal.label.clone());
                if u.terminal.label == "sleep" {
                    return;
                }
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no upsert with the new name; labels {labels:?}"));
    assert_eq!(labels, ["sh", "sleep"]);
    manager.close(TerminalCloseInput {
        thread_id: "t12".into(),
        terminal_id: Some("term-1".into()),
        delete_history: Some(true),
    });
}

#[tokio::test(flavor = "current_thread")]
async fn keeps_scrollback_across_a_restart() {
    let dir = temp_dir("restart");
    let with_dir = || TerminalConfig {
        history_dir: Some(dir.clone()),
        ..config()
    };
    let first = TerminalManager::new(with_dir());
    let mut sub = first.attach(attach_input("t7", "term-1"), 1).unwrap();
    // The bold attribute keeps an escape in the history on any shell: dash (Ubuntu's
    // `/bin/sh`) prints none of its own, and plain history gets no reset.
    write(
        &first,
        "t7",
        "term-1",
        "printf 'kept-%s\\033[1m\\033[6n\\n' 1\n",
    )
    .await;
    output_contains(&mut sub, "kept-1").await;
    let pid = first.read("t7", "term-1", None).unwrap().pid.unwrap();
    first.shutdown().await;
    assert!(!alive(pid));
    drop(sub);
    drop(first);

    let second = TerminalManager::new(with_dir());
    let mut resume = attach_input("t7", "term-1");
    resume.resume = Some(true);
    let mut sub = second.attach(resume, 1).unwrap();
    let E::Snapshot(s) = sub.next().await else {
        panic!()
    };
    assert_eq!(s.snapshot.status, TerminalSessionStatus::Running);
    assert!(s.snapshot.history.contains("kept-1"));
    // The cursor query is not replayed; the input-mode reset follows the old scrollback.
    assert!(!s.snapshot.history.contains("\u{1b}[6n"));
    assert!(s.snapshot.history.contains(sanitize::INHERITED_INPUT_RESET));

    // deleteHistory removes it for good.
    second.close(TerminalCloseInput {
        thread_id: "t7".into(),
        terminal_id: Some("term-1".into()),
        delete_history: Some(true),
    });
    let mut again = second.attach(attach_input("t7", "term-1"), 1).unwrap();
    let E::Snapshot(s) = again.next().await else {
        panic!()
    };
    assert!(!s.snapshot.history.contains("kept-1"));
    drop(second);
    let _ = std::fs::remove_dir_all(dir);
}

/// A T3 home's scrollback (`logs/terminals/terminal_<base64url(thread)>[_<terminal>].log`)
/// shows once per terminal, each its own, and once again after a restart: it is imported, not
/// read twice. A terminal with history of its own keeps it.
#[tokio::test(flavor = "current_thread")]
async fn opens_a_t3_servers_scrollback_once() {
    let dir = temp_dir("t3-history");
    let t3 = dir.join("logs/terminals");
    std::fs::create_dir_all(&t3).unwrap();
    let b64 = |text: &str| conn_support::base64::url_encode(text.as_bytes());
    std::fs::write(
        t3.join(format!("terminal_{}.log", b64("t3-thread"))),
        "first-from-T3\nsecond-from-T3\n",
    )
    .unwrap();
    std::fs::write(
        t3.join(format!(
            "terminal_{}_{}.log",
            b64("t3-thread"),
            b64("term-2")
        )),
        "other-terminal-from-T3\n",
    )
    .unwrap();
    let with_dir = || TerminalConfig {
        history_dir: Some(dir.join("terminals")),
        t3_history_dir: Some(t3.clone()),
        ..config()
    };
    for round in 0..2 {
        let manager = TerminalManager::new(with_dir());
        for (terminal, mine, other) in [
            ("term-1", "second-from-T3", "other-terminal-from-T3"),
            ("term-2", "other-terminal-from-T3", "first-from-T3"),
        ] {
            manager.adopt_t3_history("t3-thread", terminal).await;
            let mut resume = attach_input("t3-thread", terminal);
            resume.resume = Some(true);
            let mut sub = manager.attach(resume, 1).unwrap();
            let E::Snapshot(s) = sub.next().await else {
                panic!()
            };
            let history = &s.snapshot.history;
            assert_eq!(
                history.matches(mine).count(),
                1,
                "round {round} {terminal}: {history:?}"
            );
            assert!(
                !history.contains(other),
                "round {round} {terminal}: {history:?}"
            );
            if terminal == "term-1" {
                let first = history.find("first-from-T3").unwrap();
                assert!(first < history.find("second-from-T3").unwrap());
            }
        }
        manager.shutdown().await;
    }
    // T3's files stay as they were.
    assert_eq!(std::fs::read_dir(&t3).unwrap().count(), 2);

    // Native history wins over T3's from then on.
    std::fs::write(
        t3.join(format!("terminal_{}.log", b64("t3-thread"))),
        "stale-from-T3\n",
    )
    .unwrap();
    let manager = TerminalManager::new(with_dir());
    manager.adopt_t3_history("t3-thread", "term-1").await;
    let mut resume = attach_input("t3-thread", "term-1");
    resume.resume = Some(true);
    let mut sub = manager.attach(resume, 1).unwrap();
    let E::Snapshot(s) = sub.next().await else {
        panic!()
    };
    assert!(s.snapshot.history.contains("second-from-T3"));
    assert!(!s.snapshot.history.contains("stale-from-T3"));
    manager.shutdown().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test(flavor = "current_thread")]
async fn stops_shells_and_their_jobs() {
    let manager = TerminalManager::new(config());
    let mut metadata = manager.subscribe_metadata();
    let mut sub = manager.attach(attach_input("t8", "term-1"), 1).unwrap();
    assert!(matches!(sub.next().await, E::Snapshot(_)));
    let shell = manager.read("t8", "term-1", None).unwrap().pid.unwrap();
    // A foreground command in its own process group (job control).
    write(&manager, "t8", "term-1", "sleep 300\n").await;
    tokio::time::timeout(WAIT, async {
        loop {
            if let TerminalMetadataStreamEvent::Upsert(u) = metadata.next().await
                && u.terminal.has_running_subprocess
            {
                return;
            }
        }
    })
    .await
    .unwrap();
    let job = {
        let state = manager.inner.lock();
        let session = &state.sessions[&("t8".to_owned(), "term-1".to_owned())];
        i64::from(session.job.as_ref().unwrap().0)
    };
    assert_ne!(job, shell);
    assert!(alive(job));
    // Dropping the manager (as when the server goes away) stops the shell and the command.
    drop(sub);
    drop(metadata);
    drop(manager);
    until_dead(shell).await;
    until_dead(job).await;
}

#[tokio::test(flavor = "current_thread")]
async fn closes_settled_terminals_only() {
    let manager = TerminalManager::new(config());
    let mut settle = open_input("t9", "setup-1");
    settle.stop_on_settle = Some(true);
    manager.open(settle).unwrap();
    manager.open(open_input("t9", "term-1")).unwrap();
    manager.close_on_settle("t9");
    let left: Vec<String> = manager.list().into_iter().map(|t| t.terminal_id).collect();
    assert_eq!(left, vec!["term-1".to_owned()]);
    assert_eq!(terminal_label("terminal-12"), "Terminal 12");
    assert_eq!(
        terminal_label("term-2-0123abcd-0000-1111-2222-333344445555"),
        "Terminal 2"
    );
    assert_eq!(terminal_label("setup-1"), "setup-1");
}

/// `closeIdle` (`Manager.test.ts:950`, "keeps a terminal whose shell was replaced by exec
/// open on settlement"): a shell at its prompt closes; a foreground job, a shell replaced by
/// `exec`, a shell whose background job still runs (`sleep 300 &`), another thread's terminal
/// and a terminal not named stay.
#[tokio::test(flavor = "current_thread")]
async fn close_idle_closes_only_shells_at_their_prompt() {
    let manager = TerminalManager::new(config());
    let mut streams = Vec::new();
    for (thread, terminal) in [
        ("t11", "idle"),
        ("t11", "job"),
        ("t11", "execd"),
        ("t11", "background"),
        ("t12", "idle"),
    ] {
        let mut sub = manager.attach(attach_input(thread, terminal), 1).unwrap();
        assert!(matches!(sub.next().await, E::Snapshot(_)));
        streams.push(sub);
    }
    write(&manager, "t11", "job", "sleep 300\n").await;
    write(&manager, "t11", "execd", "exec sleep 300\n").await;
    // The shell is back at its prompt while its child runs.
    write(
        &manager,
        "t11",
        "background",
        "sleep 300 & echo BG-$((40+2))\n",
    )
    .await;
    output_contains(&mut streams[3], "BG-42").await;
    // Output during the check counts as activity: the idle shells finish printing first.
    for (index, thread) in [(0, "t11"), (4, "t12")] {
        write(&manager, thread, "idle", "echo IDLE-$((40+2))\n").await;
        output_contains(&mut streams[index], "IDLE-42\r\n$ ").await;
    }
    let pid = |terminal: &str| manager.read("t11", terminal, None).unwrap().pid.unwrap();
    let (job_shell, execd, background) = (pid("job"), pid("execd"), pid("background"));
    let execd_pid = i32::try_from(execd).unwrap();
    tokio::time::timeout(WAIT, async {
        loop {
            let busy = {
                let state = manager.inner.lock();
                state.sessions[&("t11".to_owned(), "job".to_owned())]
                    .job
                    .is_some()
            };
            if busy && process_name(execd_pid).await.as_deref() == Some("sleep") {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();

    manager.close_idle("t11", None).await;
    let mut left: Vec<(String, String)> = manager
        .list()
        .into_iter()
        .map(|t| (t.thread_id, t.terminal_id))
        .collect();
    left.sort();
    assert_eq!(
        left,
        [
            ("t11", "background"),
            ("t11", "execd"),
            ("t11", "job"),
            ("t12", "idle")
        ]
        .map(|(a, b)| (a.to_owned(), b.to_owned()))
    );
    manager.close_idle("t12", Some("other")).await;
    assert_eq!(
        manager.list().len(),
        4,
        "only the named terminal is checked"
    );
    manager.close_idle("t12", Some("idle")).await;
    assert_eq!(manager.list().len(), 3);
    assert!(alive(job_shell) && alive(execd) && alive(background));

    // `terminalActivityMark`: input that arrives while the table is read keeps the terminal,
    // before it produced any output.
    let mut typed = manager.attach(attach_input("t13", "typed"), 1).unwrap();
    assert!(matches!(typed.next().await, E::Snapshot(_)));
    write(&manager, "t13", "typed", "echo READY-$((40+2))\n").await;
    output_contains(&mut typed, "READY-42\r\n$ ").await;
    let open = |manager: &TerminalManager| manager.list().iter().any(|t| t.thread_id == "t13");
    manager
        .close_idle_with("t13", None, async {
            write(&manager, "t13", "typed", "Q").await;
            Ok(processes::ProcessTable::default())
        })
        .await;
    assert!(open(&manager), "input during the check keeps the terminal");
    // A table that cannot be read keeps every terminal.
    manager
        .close_idle_with("t13", None, async {
            Err(std::io::Error::other("ps failed"))
        })
        .await;
    assert!(open(&manager), "a failed inspection keeps the terminal");
    // Once its echo is out, the shell at its prompt is idle, even when the poller clears a
    // job that ended (a settle script's) while the table is read.
    output_contains(&mut typed, "Q").await;
    let ended = (i32::MAX, "sleep".to_owned());
    manager
        .inner
        .lock()
        .sessions
        .get_mut(&("t13".to_owned(), "typed".to_owned()))
        .unwrap()
        .job = Some(ended);
    manager
        .close_idle_with("t13", None, async {
            manager.inner.poll().await;
            processes::process_table().await
        })
        .await;
    assert!(!open(&manager), "the quiet shell at its prompt closes");

    // A command in its own foreground group keeps the terminal, even when the table was read
    // before it started (between the two commands of `make test && make deploy`).
    let listed = |manager: &TerminalManager, thread: &str| {
        manager.list().iter().any(|t| t.thread_id == thread)
    };
    let mut next = manager.attach(attach_input("t14", "next"), 1).unwrap();
    assert!(matches!(next.next().await, E::Snapshot(_)));
    write(&manager, "t14", "next", "sleep 300\n").await;
    until(
        &mut next,
        |e| matches!(e, E::Activity(a) if a.has_running_subprocess),
    )
    .await;
    manager
        .close_idle_with("t14", None, async {
            Ok(processes::ProcessTable::default())
        })
        .await;
    assert!(
        listed(&manager, "t14"),
        "a foreground job keeps the terminal"
    );

    // Output the reader has not taken yet keeps the terminal, so a command's last line
    // reaches its scrollback.
    let mut late = manager.attach(attach_input("t15", "late"), 1).unwrap();
    assert!(matches!(late.next().await, E::Snapshot(_)));
    write(&manager, "t15", "late", "printf 'TTY<%s>\\n' \"$(tty)\"\n").await;
    let seen = output_contains(&mut late, ">\r\n$ ").await;
    let tty = seen
        .split("TTY<")
        .find_map(|s| s.starts_with("/dev/").then(|| s.split_once('>')).flatten())
        .map(|(path, _)| path.to_owned())
        .unwrap();
    let control = manager.inner.lock().sessions[&("t15".to_owned(), "late".to_owned())]
        .proc
        .as_ref()
        .unwrap()
        .control
        .clone();
    manager
        .close_idle_with("t15", None, async {
            // This future never yields, so the reader cannot take the bytes before the check.
            use std::io::Write as _;
            let mut tty = std::fs::OpenOptions::new().write(true).open(&tty).unwrap();
            tty.write_all(b"LATE-42\n").unwrap();
            let mut fds = [rustix::event::PollFd::new(
                &*control,
                rustix::event::PollFlags::IN,
            )];
            let guard = rustix::event::Timespec {
                tv_sec: 15,
                tv_nsec: 0,
            };
            assert_eq!(rustix::event::poll(&mut fds, Some(&guard)).unwrap(), 1);
            Ok(processes::ProcessTable::default())
        })
        .await;
    assert!(listed(&manager, "t15"), "unread output keeps the terminal");
    output_contains(&mut late, "LATE-42").await;
    manager.close_idle("t15", None).await;
    assert!(
        !listed(&manager, "t15"),
        "once read, the quiet shell closes"
    );
    drop(streams);
}

#[tokio::test(flavor = "current_thread")]
async fn a_closed_shell_ends_while_other_terminals_run() {
    // SIGHUP alone ends the shell (a long grace keeps SIGKILL out of it), with another
    // terminal running beside it.
    let manager = TerminalManager::new(TerminalConfig {
        kill_grace: Duration::from_secs(60),
        ..config()
    });
    let first = manager
        .open(open_input("t10", "term-1"))
        .unwrap()
        .pid
        .unwrap();
    let mut later = manager.attach(attach_input("t10", "term-2"), 1).unwrap();
    assert!(matches!(later.next().await, E::Snapshot(_)));
    write(&manager, "t10", "term-1", "echo pending output\n").await;
    manager.close(TerminalCloseInput {
        thread_id: "t10".into(),
        terminal_id: Some("term-1".into()),
        delete_history: None,
    });
    until_dead(first).await;
    assert_eq!(manager.list().len(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn one_viewer_answers_terminal_queries_until_it_leaves() {
    let manager = TerminalManager::new(config());
    let mut first = manager.attach(attach_input("t9", "term-1"), 1).unwrap();
    let second = manager.attach(attach_input("t9", "term-1"), 2).unwrap();
    // The second viewer answers first and keeps the queries; the first viewer's replies and a
    // reply from a connection that is no viewer are dropped. Plain input still goes through.
    reply(&manager, 2, "echo AAA").await;
    reply(&manager, 1, "BBB").await;
    reply(&manager, 99, "ZZZ").await;
    write(&manager, "t9", "term-1", "CCC\n").await;
    let seen = output_contains(&mut first, "AAACCC").await;
    assert!(!seen.contains("BBB") && !seen.contains("ZZZ"), "{seen}");
    // Once it detaches, the next viewer to answer takes over.
    drop(second);
    reply(&manager, 1, "echo DDD").await;
    write(&manager, "t9", "term-1", "\n").await;
    output_contains(&mut first, "DDD").await;
    manager.close(TerminalCloseInput {
        thread_id: "t9".into(),
        terminal_id: None,
        delete_history: Some(true),
    });
}

#[tokio::test(flavor = "current_thread")]
async fn a_failed_start_shows_its_error_to_later_attachments() {
    let manager = TerminalManager::new(TerminalConfig {
        shells: vec!["/definitely/not/a/shell".into()],
        ..config()
    });
    for viewer in [1, 2] {
        let mut sub = manager
            .attach(attach_input("t10", "term-1"), viewer)
            .unwrap();
        match sub.next().await {
            E::Snapshot(s) => {
                assert_eq!(s.snapshot.status, TerminalSessionStatus::Error);
                let message = s.snapshot.error.unwrap_or_default();
                assert!(message.contains("/definitely/not/a/shell"), "{message}");
            }
            other => panic!("{other:?}"),
        }
    }
}

#[test]
fn binary_input_is_one_byte_per_code_unit() {
    // `Buffer.from(data, "latin1")`: each UTF-16 unit's low byte; text goes as UTF-8.
    assert_eq!(pty_input("\u{1b}[M \u{e9}!", true), b"\x1b[M \xe9!");
    assert_eq!(pty_input("\u{e9}", false), "\u{e9}".as_bytes());
    assert_eq!(pty_input("\u{1e9}", true), [0xe9]);
}
