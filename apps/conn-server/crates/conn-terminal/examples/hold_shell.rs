//! Opens one terminal running `sleep 1000` in the foreground, prints the shell's and the
//! command's pids, then waits to be killed. Checks that no process outlives the server.

use conn_contract::TerminalOpenInput;
use conn_terminal::{TerminalConfig, TerminalManager};

fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(async {
        let manager = TerminalManager::new(TerminalConfig::default());
        let snapshot = manager
            .open(TerminalOpenInput {
                thread_id: "example".into(),
                terminal_id: "term-1".into(),
                cwd: "/tmp".into(),
                worktree_path: None,
                cols: None,
                rows: None,
                env: None,
                provider_instance_id: None,
                stop_on_settle: None,
            })
            .expect("open a terminal");
        manager
            .write(
                conn_contract::TerminalWriteInput {
                    thread_id: "example".into(),
                    terminal_id: "term-1".into(),
                    data: "exec sleep 1000 & wait\n".into(),
                    binary: None,
                    reply: None,
                },
                None,
            )
            .await
            .expect("write");
        println!("shell {}", snapshot.pid.unwrap_or_default());
        std::future::pending::<()>().await;
    });
}
