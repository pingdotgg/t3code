//! Every thread's right panel saved to disk (`persist` of Conn's `rightPanelStore`), so tabs,
//! open state, maximize, the terminal drawer and the width come back after a restart. What
//! the panels hold is `conn_state::ThreadPanels`; this file reads and writes it, with the
//! environment id the primary server reported last.

use std::path::{Path, PathBuf};
use std::time::Duration;

use conn_state::SavedThreadPanels;
use futures::FutureExt as _;
use futures::future::Shared;
use gpui_kit::{Context, Task};

use super::ConnApp;

/// How long after the last change the panels are written (a page navigating, a seam drag).
pub(super) const THREAD_PANEL_SAVE_DELAY: Duration = Duration::from_millis(500);
/// How long a failed write waits before it is tried again.
const THREAD_PANEL_RETRY_DELAY: Duration = Duration::from_secs(5);
/// The primary's environment key before any server ever said who it is (a first launch).
const UNKNOWN_PRIMARY: &str = "unknown-primary";

/// Where the panels are saved: beside the drafts, so `CONN_GPUI_CONFIG_DIR` and tests (no
/// file at all) cover both.
pub(super) fn thread_panels_file_path() -> Option<PathBuf> {
    crate::drafts::drafts_file_path().map(|path| path.with_file_name("thread-panels.json"))
}

/// A write on the background executor and the layout it writes.
struct InFlight {
    layout: SavedThreadPanels,
    done: Shared<Task<bool>>,
}

/// The panels' saving state. One write runs at a time; what changes meanwhile follows it.
#[derive(Default)]
pub(super) struct PanelSaves {
    pub(super) path: Option<PathBuf>,
    /// The layout on disk, recorded once its write's rename succeeded.
    written: Option<SavedThreadPanels>,
    /// The pending debounced save; replacing it restarts the delay.
    scheduled: Option<Task<()>>,
    in_flight: Option<InFlight>,
    /// A change came while a write was in flight: write again when it ends.
    dirty: bool,
    /// The app is quitting: the quit hook writes the rest, nothing new starts.
    quitting: bool,
    #[cfg(test)]
    writes: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl PanelSaves {
    pub(super) fn new(path: Option<PathBuf>) -> Self {
        Self {
            path,
            ..Self::default()
        }
    }
}

impl ConnApp {
    /// Reads the saved panels, and the primary's last environment id, which keys its panels
    /// until the server confirms it. A file of another format is set aside once as `.bak`, and
    /// the panels start empty.
    pub(super) fn restore_thread_panels(&mut self, cx: &mut Context<'_, Self>) {
        let Some(path) = self.panel_saves.path.clone() else {
            return;
        };
        let Ok(json) = std::fs::read_to_string(&path) else {
            return;
        };
        let Some(saved) = SavedThreadPanels::from_json(&json) else {
            let backup = path.with_extension("json.bak");
            if !backup.exists()
                && let Err(error) = std::fs::rename(&path, &backup)
            {
                eprintln!("could not set aside the old thread panels file: {error}");
            }
            return;
        };
        self.primary_environment = saved.primary_environment.clone();
        self.panel_saves.written = Some(saved.clone());
        for (id, url) in self.thread_panels.restore(saved) {
            self.right_panel
                .update(cx, |panel, cx| panel.navigate_browser(id, url, cx));
        }
    }

    /// Writes every thread's panel a little after the last change, off the UI thread.
    pub(super) fn save_thread_panels(&mut self, cx: &mut Context<'_, Self>) {
        self.schedule_thread_panel_save(THREAD_PANEL_SAVE_DELAY, cx);
    }

    fn schedule_thread_panel_save(&mut self, delay: Duration, cx: &mut Context<'_, Self>) {
        if self.panel_saves.path.is_none() || self.panel_saves.quitting {
            return;
        }
        self.panel_saves.scheduled = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            let _ = this.update(cx, |app, cx| app.flush_thread_panels(cx));
        }));
    }

    /// The layout as it is now, as written to disk.
    fn current_thread_panels(&self, cx: &gpui_kit::App) -> SavedThreadPanels {
        let shown = self.shown_thread_panel();
        let panel = self.right_panel.read(cx);
        let mut saved = self
            .thread_panels
            .save(&shown, |id| panel.browser_address(id, cx));
        saved.primary_environment = self.primary_environment.clone();
        saved
    }

    /// Starts a background write of the current layout, unless it is on disk already or a
    /// write is running (then it follows that one).
    pub(super) fn flush_thread_panels(&mut self, cx: &mut Context<'_, Self>) {
        self.panel_saves.scheduled = None;
        let Some(path) = self.panel_saves.path.clone() else {
            return;
        };
        if self.panel_saves.quitting {
            return;
        }
        if self.panel_saves.in_flight.is_some() {
            self.panel_saves.dirty = true;
            return;
        }
        let layout = self.current_thread_panels(cx);
        if self.panel_saves.written.as_ref() == Some(&layout) {
            return;
        }
        let json = layout.to_json();
        #[cfg(test)]
        let writes = std::sync::Arc::clone(&self.panel_saves.writes);
        let done = cx
            .background_executor()
            .spawn(async move {
                let ok = write_layout(&path, &json);
                #[cfg(test)]
                writes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                ok
            })
            .shared();
        self.panel_saves.in_flight = Some(InFlight {
            layout: layout.clone(),
            done: done.clone(),
        });
        cx.spawn(async move |this, cx| {
            let ok = done.await;
            let _ = this.update(cx, |app, cx| app.finish_thread_panel_write(layout, ok, cx));
        })
        .detach();
    }

    /// A write ended. Only a write that landed counts as on disk; a failed one is tried again.
    fn finish_thread_panel_write(
        &mut self,
        layout: SavedThreadPanels,
        ok: bool,
        cx: &mut Context<'_, Self>,
    ) {
        self.panel_saves.in_flight = None;
        if ok {
            self.panel_saves.written = Some(layout);
        }
        if std::mem::take(&mut self.panel_saves.dirty) {
            self.flush_thread_panels(cx);
        } else if !ok {
            self.schedule_thread_panel_save(THREAD_PANEL_RETRY_DELAY, cx);
        }
    }

    /// The quit hook: the write in flight finishes, then the latest layout is written if it
    /// differs from what is on disk. Runs while the app is borrowed, so the returned future
    /// touches only the file.
    pub(super) fn thread_panels_on_quit(
        &mut self,
        cx: &mut Context<'_, Self>,
    ) -> impl std::future::Future<Output = ()> + use<> {
        self.panel_saves.quitting = true;
        self.panel_saves.scheduled = None;
        let path = self.panel_saves.path.clone();
        let latest = path.as_ref().map(|_| self.current_thread_panels(cx));
        let in_flight = self
            .panel_saves
            .in_flight
            .as_ref()
            .map(|write| (write.layout.clone(), write.done.clone()));
        let written = self.panel_saves.written.clone();
        async move {
            let (Some(path), Some(latest)) = (path, latest) else {
                return;
            };
            let mut on_disk = written;
            if let Some((layout, done)) = in_flight
                && done.await
            {
                on_disk = Some(layout);
            }
            if on_disk.as_ref() != Some(&latest) {
                write_layout(&path, &latest.to_json());
            }
        }
    }

    /// The shown thread's panel as `ThreadPanels` keeps it.
    pub(super) fn shown_thread_panel(&self) -> conn_state::ThreadPanel {
        conn_state::ThreadPanel {
            tabs: self.right_panel_tabs.clone(),
            open: self.layout.right_panel_open,
            maximized: self.right_panel_maximized,
            terminal_open: self.terminal_drawer_open,
            width: Some(self.layout.right_panel_width),
        }
    }

    /// The environment part of the primary's panel owners: the id it reported last (saved with
    /// the layout, so it keys the user's panels from launch).
    pub(super) fn primary_panel_environment(&self) -> String {
        self.primary_environment
            .clone()
            .unwrap_or_else(|| UNKNOWN_PRIMARY.to_owned())
    }

    /// The primary server's config snapshot named its environment id. The same id as before
    /// changes nothing. Another id is another server: its panels start fresh, and the old
    /// server's stay saved under its own id.
    pub(super) fn learn_primary_environment(&mut self, id: String, cx: &mut Context<'_, Self>) {
        self.primary_confirmed = true;
        if self.primary_environment.as_deref() == Some(id.as_str()) {
            return;
        }
        self.primary_environment = Some(id);
        // The shown thread's owner is now this environment's; its panel, if any, shows.
        self.sync_chat(cx);
        self.save_thread_panels(cx);
        cx.notify();
    }

    #[cfg(test)]
    pub(crate) fn set_thread_panels_path_for_test(
        &mut self,
        path: PathBuf,
        cx: &mut Context<'_, Self>,
    ) {
        self.panel_saves.path = Some(path);
        self.restore_thread_panels(cx);
    }

    /// Writes now instead of after the delay; `run_until_parked` finishes the write.
    #[cfg(test)]
    pub(crate) fn save_thread_panels_for_test(&mut self, cx: &mut Context<'_, Self>) {
        self.flush_thread_panels(cx);
    }

    #[cfg(test)]
    pub(crate) fn thread_panel_writes_for_test(&self) -> usize {
        self.panel_saves
            .writes
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(crate) fn thread_panel_write_in_flight_for_test(&self) -> bool {
        self.panel_saves.in_flight.is_some()
    }

    /// What the server-config snapshot does when it names the primary's environment.
    #[cfg(test)]
    pub(crate) fn learn_primary_environment_for_test(
        &mut self,
        id: &str,
        cx: &mut Context<'_, Self>,
    ) {
        self.learn_primary_environment(id.to_owned(), cx);
    }

    /// What the primary connection dropping does: its identity needs confirming again.
    #[cfg(test)]
    pub(crate) fn primary_disconnected_for_test(&mut self, cx: &mut Context<'_, Self>) {
        self.apply_event_for_test(
            conn_client::ClientEvent::Status(conn_client::ConnectionStatus::Reconnecting {
                attempt: 1,
            }),
            cx,
        );
    }
}

/// Writes `json` with an atomic rename; `true` once it landed.
fn write_layout(path: &Path, json: &str) -> bool {
    match crate::drafts::write_drafts_file(path, json) {
        Ok(()) => true,
        Err(error) => {
            eprintln!("could not save thread panels: {error}");
            false
        }
    }
}
