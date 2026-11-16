//! A supervised Linux server acknowledges restart before it shuts down (`serverRestart.ts`).

use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::watch;

#[derive(Debug)]
pub struct Restart {
    available: bool,
    stopping: AtomicBool,
    stop: watch::Sender<bool>,
}

impl Default for Restart {
    fn default() -> Self {
        Self::new(false)
    }
}

impl Restart {
    fn new(available: bool) -> Self {
        Self {
            available,
            stopping: AtomicBool::new(false),
            stop: watch::channel(false).0,
        }
    }

    /// Detects only the service that owns this process, without changing systemd state.
    pub async fn detect(desktop: bool) -> Self {
        if desktop || !cfg!(target_os = "linux") {
            return Self::default();
        }
        let in_service = tokio::task::spawn_blocking(|| {
            use std::io::Read;
            let mut text = String::new();
            std::fs::File::open("/proc/self/cgroup")
                .and_then(|f| f.take(64 * 1024).read_to_string(&mut text))
                .is_ok()
                && text.lines().any(|line| line.ends_with("/t3.service"))
        })
        .await
        .unwrap_or(false);
        if !in_service {
            return Self::default();
        }
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::process::Command::new("systemctl")
                .args([
                    "show",
                    "t3.service",
                    "--property=MainPID,Restart",
                    "--no-pager",
                ])
                .env_clear()
                .env(
                    "PATH",
                    std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into()),
                )
                .kill_on_drop(true)
                .output(),
        )
        .await;
        let available = match result {
            Ok(Ok(output)) if output.status.success() => {
                supervised(&String::from_utf8_lossy(&output.stdout), std::process::id())
            }
            _ => false,
        };
        Self::new(available)
    }

    pub fn available(&self) -> bool {
        self.available
    }

    pub fn requested(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    pub(crate) fn request(self: &Arc<Self>) -> Result<Value, Value> {
        let error = |reason| json!({"_tag":"ServerRestartError","reason":reason});
        if !self.available {
            return Err(error(
                "This server has no supervisor that would start it again.",
            ));
        }
        if self.stopping.swap(true, Ordering::SeqCst) {
            return Err(error("The server is already restarting."));
        }
        let this = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(250)).await;
            this.stop.send_replace(true);
        });
        Ok(json!({"accepted":true}))
    }

    pub(crate) async fn wait(&self) {
        let mut stop = self.stop.subscribe();
        let _ = stop.wait_for(|stop| *stop).await;
    }
}

fn supervised(properties: &str, pid: u32) -> bool {
    let fields: Vec<_> = properties
        .lines()
        .filter_map(|l| l.split_once('='))
        .collect();
    fields
        .iter()
        .any(|(k, v)| *k == "MainPID" && v.parse::<u32>().ok() == Some(pid))
        && fields
            .iter()
            .any(|(k, v)| *k == "Restart" && matches!(*v, "always" | "on-failure"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_own_supervised_process_can_restart() {
        assert!(supervised("MainPID=42\nRestart=always\n", 42));
        assert!(supervised("Restart=on-failure\nMainPID=42\n", 42));
        for properties in [
            "MainPID=43\nRestart=always",
            "MainPID=42\nRestart=no",
            "MainPID=42\nRestart=on-abnormal",
            "Restart=always",
        ] {
            assert!(!supervised(properties, 42), "{properties}");
        }
    }
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn acknowledges_before_stopping_and_refuses_a_second_restart() {
        let service = Arc::new(Restart::new(true));
        assert_eq!(
            conn_contract::to_json(&crate::environment::capabilities(service.available()))["serverRestart"],
            true
        );
        assert_eq!(service.request().unwrap(), json!({"accepted":true}));
        assert!(!*service.stop.borrow());
        assert_eq!(
            service.request().unwrap_err()["reason"],
            "The server is already restarting."
        );
        service.wait().await;
        assert!(*service.stop.borrow());
        let unavailable = Arc::new(Restart::default());
        assert_eq!(
            unavailable.request().unwrap_err()["reason"],
            "This server has no supervisor that would start it again."
        );
        assert!(!unavailable.requested());
    }
}
