//! The thread sidebar's Settled shelf paging and saved state, the message search, dragging rows
//! to reorder, pin, un-pin, settle and un-settle them, and the action sweep over a run of rows
//! (`Sidebar.tsx` `useSidebarThreads`, `useOlderSettledShelf`, `useThreadSearch`,
//! `handleThreadDragEnd`, `startActionSweep`). What each rule is comes from
//! `conn_state::{settled_shelf, thread_search, sidebar_drag, order_keys}`; this file holds the
//! state and applies the rules to the app.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Duration;

use conn_state::sidebar_drag::{
    self, Collision, CollisionInput, DRAG_DISTANCE_PX, DropInput, DropPlan, DropTarget, Extent,
    ListItem, OptimisticDrop, Section, SweepAction,
};
use conn_state::thread_search::{
    SettledSearch, ShownOrder, Subject, THREAD_SEARCH_DEBOUNCE_MS, next_shown_order,
    rank_message_matches, search_query, visible_thread_search,
};
use conn_state::{
    MoreState, PageStatus, SETTLED_SHELF_ROW, SettledTail, SidebarPrefs, ThreadShell,
};
use gpui_kit::{Context, Pixels, Point, px};

use super::{ConnApp, ThreadUndoKind};
use crate::sidebar::thread_list::{Excerpt, project_in_scope, settled_shelf, sidebar_lists};

/// How long a drop is held on screen for the server's shell to show it through.
const DROP_HOLD_SECS: u64 = 10;

/// What a press on a row is waiting to become.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PressMode {
    /// A drag of the row.
    Drag,
    /// A sweep from its Settle or Un-settle button.
    Sweep(SweepAction),
}

/// A pointer press on a row that has not moved far enough to be a drag (`SidebarPointerSensor`
/// `pending`).
#[derive(Clone, Debug)]
pub(crate) struct Press {
    pub(crate) id: String,
    pub(crate) origin: Point<Pixels>,
    pub(crate) mode: PressMode,
}

/// A row held and moved over the list.
pub(crate) struct Drag {
    pub(crate) id: String,
    pub(crate) from: Section,
    /// Where the row would land now; none while it is over nothing it may drop on.
    pub(crate) target: Option<DropTarget>,
    items: Vec<ListItem>,
    extents: Vec<Extent>,
    boundary: Option<Extent>,
    shelf_top: Option<f32>,
    collision: Collision,
    /// The pointer when the drag began, and the held row's centre then.
    activation_y: f32,
    center: f32,
    held_height: f32,
    min_center: f32,
    /// The list's scroll position when the row was picked up.
    scroll_at_pickup: f32,
    viewport: Extent,
    list_left: f32,
    list_right: f32,
    occurred_at: String,
    pinned_keys: HashMap<String, Option<String>>,
    active_keys: HashMap<String, Option<String>>,
    pub(crate) pinned: Vec<String>,
    pub(crate) active: Vec<String>,
    pub(crate) settled: Vec<String>,
}

/// A run of rows swept with the Settle or Un-settle button (`SidebarActionSweep`).
pub(crate) struct Sweep {
    pub(crate) origin: String,
    pub(crate) action: SweepAction,
    pub(crate) keys: Vec<String>,
    target: Option<String>,
    order: Vec<String>,
    origin_section: Section,
}

/// A drop the server has not caught up with: the drop and the thread as the drop leaves it.
pub(crate) struct PendingDrop {
    pub(crate) drop: OptimisticDrop,
    pub(crate) thread: ThreadShell,
}

/// The message search of the sidebar box (`useThreadSearch`).
#[derive(Default)]
pub(crate) struct MessageSearch {
    generation: u64,
    task: Option<gpui_kit::Task<()>>,
    /// A word of three letters or more has been typed, so messages can be searched.
    searching: bool,
    pending: bool,
    failed: bool,
    /// The answer for the query now typed.
    ready: Option<SettledSearch>,
    /// The last answer, kept while a longer or shorter query waits for its own.
    previous: Option<SettledSearch>,
    shown: Option<ShownOrder>,
    /// The threads listed for their messages, in the order the matches were ranked.
    pub(crate) order: Vec<String>,
    pub(crate) excerpts: HashMap<String, Excerpt>,
    /// The query the hits were found for, which lags the box while a search runs.
    pub(crate) matched_query: String,
}

impl MessageSearch {
    pub(crate) fn pending(&self) -> bool {
        self.searching && self.pending
    }

    pub(crate) fn failed(&self) -> bool {
        self.searching && self.failed && !self.pending
    }
}

/// What the sidebar remembers and does besides the lists themselves.
pub(crate) struct SidebarState {
    prefs_path: Option<PathBuf>,
    pub(crate) settled_expanded: bool,
    tail: SettledTail,
    pub(crate) search: MessageSearch,
    pub(crate) press: Option<Press>,
    pub(crate) drag: Option<Drag>,
    pub(crate) sweep: Option<Sweep>,
    pub(crate) pending_drop: Option<PendingDrop>,
    /// A drag or sweep just ended, so the click that ends it opens nothing.
    pub(crate) suppress_click: bool,
    /// Rows can be held with no server (a window under test).
    #[cfg(test)]
    offline_gestures: bool,
    /// The drop and the sweep that last ended, for tests.
    #[cfg(test)]
    last_drop: Option<DropPlan>,
    #[cfg(test)]
    last_sweep: Option<Vec<String>>,
}

/// Where the sidebar's saved state is kept; none under test.
fn sidebar_prefs_path() -> Option<PathBuf> {
    if cfg!(test) {
        return None;
    }
    if let Some(dir) = std::env::var_os("CONN_GPUI_CONFIG_DIR") {
        return Some(PathBuf::from(dir).join("sidebar.json"));
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    Some(home.join("Library/Application Support/conn-gpui/sidebar.json"))
}

impl SidebarState {
    pub(crate) fn load() -> Self {
        let prefs_path = sidebar_prefs_path();
        let prefs = prefs_path
            .as_deref()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .map(|text| SidebarPrefs::from_json(&text))
            .unwrap_or_default();
        Self {
            prefs_path,
            settled_expanded: prefs.settled_expanded,
            tail: SettledTail::default(),
            search: MessageSearch::default(),
            press: None,
            drag: None,
            sweep: None,
            pending_drop: None,
            suppress_click: false,
            #[cfg(test)]
            offline_gestures: false,
            #[cfg(test)]
            last_drop: None,
            #[cfg(test)]
            last_sweep: None,
        }
    }

    fn save(&self) {
        let Some(path) = &self.prefs_path else {
            return;
        };
        let json = SidebarPrefs {
            settled_expanded: self.settled_expanded,
        }
        .to_json();
        let write = || -> std::io::Result<()> {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, json)?;
            std::fs::rename(&tmp, path)
        };
        if let Err(err) = write() {
            eprintln!("sidebar: could not save {}: {err}", path.display());
        }
    }

    /// Rows the shelf shows when open under `scope`, starting that scope when it is new.
    pub(crate) fn visible_count(&mut self, scope: &str) -> usize {
        self.tail.count_for(scope)
    }
}

fn hypot(a: Point<Pixels>, b: Point<Pixels>) -> f32 {
    f32::from(a.x - b.x).hypot(f32::from(a.y - b.y))
}

fn now_iso() -> String {
    let secs = crate::sidebar::thread_list::current_unix_secs();
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant's days-to-civil.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

// ---- The Settled shelf -------------------------------------------------------------------

impl ConnApp {
    /// The key a project scope starts the shelf's paging over for (`projectScopeKey`).
    pub(crate) fn settled_scope_key(&self) -> String {
        self.active_workspace.clone().unwrap_or_default()
    }

    /// Rows the Settled shelf shows when open, for readers that cannot start the scope.
    pub(crate) fn settled_visible_count(&self) -> usize {
        self.sidebar.tail.count_in(&self.settled_scope_key())
    }

    /// `toggleSettledShelf`: opens or closes the shelf and keeps the choice for the next launch
    /// (`SETTLED_SHELF_EXPANDED_KEY`).
    pub(crate) fn toggle_settled_shelf(&mut self, cx: &mut Context<'_, Self>) {
        self.sidebar.settled_expanded = !self.sidebar.settled_expanded;
        self.sidebar.save();
        self.drive_older_pages(cx);
        cx.notify();
    }

    /// `showMoreSettled`, and `retry` for a page that failed: one more page of rows is shown, and
    /// the older threads it needs are read.
    pub(crate) fn show_more_settled(&mut self, cx: &mut Context<'_, Self>) {
        if self.shell.older_settled().status == PageStatus::Pending {
            return;
        }
        self.shell.retry_older_page();
        let scope = self.settled_scope_key();
        self.sidebar.tail.count_for(&scope);
        self.sidebar.tail.show_more();
        self.drive_older_pages(cx);
        cx.notify();
    }

    /// The project ids the Settled shelf pages for (`olderSettledScopes`); none for every project.
    fn older_scope(&self) -> Option<Vec<String>> {
        self.active_workspace.as_ref()?;
        Some(
            self.shell
                .projects
                .iter()
                .filter(|project| {
                    project_in_scope(
                        &self.shell,
                        &self.orbit.workspaces,
                        self.active_workspace.as_deref(),
                        &project.id,
                    )
                })
                .map(|project| project.id.clone())
                .collect(),
        )
    }

    /// Reads the next page of older settled threads when the open shelf lists fewer rows than it
    /// shows (`useOlderSettledShelfGrowth`), one page at a time.
    pub(crate) fn drive_older_pages(&mut self, cx: &mut Context<'_, Self>) {
        let scope = self.older_scope();
        self.shell.set_older_scope(scope);
        if !self.sidebar.settled_expanded {
            return;
        }
        let Some(connection) = self.connection.clone() else {
            return;
        };
        let visible = self.sidebar.tail.count_in(&self.settled_scope_key());
        let listed = sidebar_lists(
            &self.shell,
            &self.orbit.workspaces,
            self.active_workspace.as_deref(),
            "",
            &[],
            None,
        )
        .listed_settled
        .len();
        let Some(request) = self.shell.next_older_page(listed, visible) else {
            return;
        };
        self.shell.older_page_started(&request);
        let payload = serde_json::json!({
            "before": {
                "settledAt": request.before.settled_at,
                "threadId": request.before.thread_id,
            },
            "projectIds": request.project_ids,
            "limit": conn_state::OLDER_SETTLED_PAGE_SIZE,
        });
        cx.spawn(async move |this, cx| {
            let result = connection
                .call::<_, conn_contract::OrchestrationV2OlderSettledThreadsPage>(
                    "orchestration.getOlderSettledThreads",
                    &payload,
                )
                .await;
            let _ = this.update(cx, |app, cx| {
                match result {
                    Ok(page) => app.shell.apply_older_page(&request, page),
                    Err(err) => {
                        eprintln!("older settled threads: {err}");
                        app.shell.older_page_failed(&request);
                    }
                }
                // A page may not fill the shelf, and the next one is read in turn.
                app.drive_older_pages(cx);
                cx.notify();
            });
        })
        .detach();
    }

    /// What the shelf's footer says while an older page is read or failed.
    pub(crate) fn older_more_state(&self) -> MoreState {
        match self.shell.older_settled().status {
            PageStatus::Pending => MoreState::Loading,
            PageStatus::Failed => MoreState::Failed,
            PageStatus::Ready => MoreState::Idle,
        }
    }

    /// The rows the shelf draws now, in order (a closed shelf keeps only the open thread).
    pub(crate) fn settled_shelf_rows(&self) -> Vec<String> {
        settled_shelf(
            &self.shell,
            &self.orbit.workspaces,
            self.active_workspace.as_deref(),
            self.sidebar
                .pending_drop
                .as_ref()
                .map(|p| (&p.drop, &p.thread)),
            self.open_row_thread(),
            self.sidebar.settled_expanded,
            self.settled_visible_count(),
        )
        .rows
    }
}

// ---- Message search ----------------------------------------------------------------------

impl ConnApp {
    /// The box's text changed: a new query is sent once it has rested `THREAD_SEARCH_DEBOUNCE_MS`
    /// (`useDebouncedValue`), and what was found for the old one stays while it runs.
    pub(crate) fn sidebar_search_changed(&mut self, cx: &mut Context<'_, Self>) {
        let query = self.sidebar_search_query(cx);
        let search = &mut self.sidebar.search;
        search.generation = search.generation.wrapping_add(1);
        search.task = None;
        search.ready = None;
        search.failed = false;
        let Some(normalized) = search_query(&query).filter(|_| self.connection.is_some()) else {
            search.searching = false;
            search.pending = false;
            search.previous = None;
            search.shown = None;
            search.order.clear();
            search.excerpts.clear();
            search.matched_query.clear();
            return;
        };
        search.searching = true;
        search.pending = true;
        let generation = search.generation;
        search.task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(THREAD_SEARCH_DEBOUNCE_MS))
                .await;
            let _ = this.update(cx, |app, cx| {
                if app.sidebar.search.generation == generation {
                    app.send_message_search(generation, normalized, cx);
                }
            });
        }));
    }

    fn send_message_search(&mut self, generation: u64, query: String, cx: &mut Context<'_, Self>) {
        let Some(connection) = self.connection.clone() else {
            return;
        };
        let payload = serde_json::json!({ "query": query });
        cx.spawn(async move |this, cx| {
            let result = connection
                .call::<_, conn_contract::OrchestrationV2SearchThreadsResult>(
                    "orchestration.searchThreads",
                    &payload,
                )
                .await;
            let _ = this.update(cx, |app, cx| {
                let search = &mut app.sidebar.search;
                if search.generation != generation {
                    return;
                }
                search.pending = false;
                match result {
                    Ok(found) => {
                        let ready = SettledSearch {
                            query,
                            matches: found.matches,
                        };
                        search.previous = Some(ready.clone());
                        search.ready = Some(ready);
                    }
                    Err(err) => {
                        eprintln!("thread search: {err}");
                        search.failed = true;
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Ranks what the server found and keeps the rows shown in place (`rankMessageMatches`,
    /// `nextShownOrder`), for the query now typed. Runs as the sidebar draws and as keys walk the
    /// results.
    pub(crate) fn refresh_message_matches(&mut self, query: &str) {
        let Some(normalized) = search_query(query) else {
            return;
        };
        let visible = visible_thread_search(
            &normalized,
            self.sidebar.search.ready.as_ref(),
            self.sidebar.search.previous.as_ref(),
        );
        let searchable: HashMap<&str, &ThreadShell> = self
            .shell
            .top_level_active_threads()
            .chain(self.shell.all_settled_threads())
            .map(|thread| (thread.id.as_str(), thread))
            .collect();
        let ranked = rank_message_matches(
            &visible.matches,
            |found| {
                searchable
                    .get(found.thread_id.as_str())
                    .map(|thread| Subject::of(thread))
            },
            now_ms(),
        );
        let mut by_thread: HashMap<String, Excerpt> = HashMap::new();
        let mut keys: Vec<String> = Vec::new();
        for found in &ranked {
            if by_thread.contains_key(&found.thread_id) {
                continue;
            }
            keys.push(found.thread_id.clone());
            by_thread.insert(
                found.thread_id.clone(),
                Excerpt {
                    source: found.source,
                    snippet: found.snippet.clone(),
                },
            );
        }
        let search = &mut self.sidebar.search;
        // No limit (`Number.POSITIVE_INFINITY`): every ranked row shows.
        let shown = next_shown_order(search.shown.as_ref(), &visible.query, &keys, usize::MAX);
        search.order = shown.keys.clone();
        search.shown = Some(shown);
        search.excerpts = by_thread;
        search.matched_query = visible.query;
    }
}

// ---- Dragging rows and sweeping runs of them --------------------------------------------

impl ConnApp {
    /// The pointer went down on a thread row (or on its Settle or Un-settle button): a move of
    /// `DRAG_DISTANCE_PX` turns the press into a drag of the row, or into a sweep. A drop still
    /// in flight, a rename and a search hold the rows still (`sortableDisabled`).
    pub(crate) fn row_pressed(
        &mut self,
        thread_id: &str,
        position: Point<Pixels>,
        mode: PressMode,
        plain: bool,
        cx: &mut Context<'_, Self>,
    ) {
        self.sidebar.suppress_click = false;
        let blocked = !plain
            || !self.gestures_allowed()
            || self.sidebar.pending_drop.is_some()
            || self.renaming_thread_id.as_deref() == Some(thread_id)
            || !self.sidebar_search_query(cx).trim().is_empty();
        if blocked {
            return;
        }
        self.sidebar.press = Some(Press {
            id: thread_id.to_owned(),
            origin: position,
            mode,
        });
        cx.notify();
    }

    /// Rows can be held and their commands sent: there is a server (or a window under test).
    fn gestures_allowed(&self) -> bool {
        #[cfg(test)]
        if self.sidebar.offline_gestures {
            return true;
        }
        self.connection.is_some()
    }

    /// The click that ended a drag or sweep opens or settles nothing.
    pub(crate) fn click_suppressed(&self) -> bool {
        self.sidebar.suppress_click
    }

    /// Whether a press, drag or sweep wants the pointer, so the window follows it.
    pub(crate) fn pointer_captured(&self) -> bool {
        self.sidebar.press.is_some()
            || self.sidebar.drag.is_some()
            || self.sidebar.sweep.is_some()
            || self.rail_gesture.state.is_active()
    }

    /// The pointer moved while a button is down.
    pub(crate) fn sidebar_pointer_moved(
        &mut self,
        position: Point<Pixels>,
        cx: &mut Context<'_, Self>,
    ) {
        // A workspace tile of the rail held (`rail_workspaces.rs`).
        if self.rail_pointer_moved(position, cx) {
            return;
        }
        if let Some(press) = self.sidebar.press.clone()
            && hypot(position, press.origin) > DRAG_DISTANCE_PX
        {
            self.sidebar.press = None;
            self.thread_hover.dismiss();
            match press.mode {
                PressMode::Drag => self.start_drag(&press, cx),
                PressMode::Sweep(action) => self.start_sweep(&press, action, cx),
            }
        }
        if self.sidebar.drag.is_some() {
            self.move_drag(position, cx);
        } else if self.sidebar.sweep.is_some() {
            self.move_sweep(position, cx);
        }
    }

    /// The pointer was let go, or the drag was cancelled (`Escape`, a lost window).
    pub(crate) fn sidebar_pointer_released(&mut self, cancel: bool, cx: &mut Context<'_, Self>) {
        if self.rail_pointer_released(cancel, cx) {
            return;
        }
        let had_press = self.sidebar.press.take().is_some();
        if let Some(drag) = self.sidebar.drag.take() {
            self.sidebar.suppress_click = true;
            if !cancel {
                self.finish_drag(drag, cx);
            }
            cx.notify();
        } else if let Some(sweep) = self.sidebar.sweep.take() {
            self.sidebar.suppress_click = true;
            if !cancel {
                self.finish_sweep(&sweep, cx);
            }
            cx.notify();
        } else if had_press {
            cx.notify();
        }
    }

    fn row_extent(&self, key: &str) -> Option<Extent> {
        let bounds = self.sidebar_tree.bounds_of(key)?;
        Some(Extent {
            top: f32::from(bounds.top()),
            bottom: f32::from(bounds.bottom()),
        })
    }

    fn start_drag(&mut self, press: &Press, cx: &mut Context<'_, Self>) {
        let lists = sidebar_lists(
            &self.shell,
            &self.orbit.workspaces,
            self.active_workspace.as_deref(),
            "",
            &[],
            None,
        );
        let pinned: Vec<String> = lists.pinned.iter().map(|t| t.id.clone()).collect();
        let active: Vec<String> = lists.active.iter().map(|t| t.id.clone()).collect();
        let settled = self.settled_shelf_rows();
        let items = sidebar_drag::list_items(&pinned, &active, &settled);
        let Some(held) = self.shell.find_thread(&press.id) else {
            return;
        };
        let from = sidebar_drag::thread_section(held);
        let rows: HashMap<String, Extent> = pinned
            .iter()
            .chain(&active)
            .chain(&settled)
            .filter_map(|id| Some((id.clone(), self.row_extent(id)?)))
            .collect();
        let Some(held_extent) = rows.get(&press.id).copied() else {
            return;
        };
        let first_top = pinned
            .first()
            .or(active.first())
            .and_then(|id| rows.get(id))
            .map_or(held_extent.top, |extent| extent.top);
        let settled_header = self.row_extent(SETTLED_SHELF_ROW);
        let extents = sidebar_drag::item_extents(&items, &rows, first_top, settled_header);
        let divider = items
            .iter()
            .position(|item| *item == ListItem::Marker(sidebar_drag::Marker::PinnedDivider))
            .map(|at| extents[at]);
        let scroll = self.sidebar_tree.scroll();
        let viewport = scroll.bounds();
        let held_height = held_extent.bottom - held_extent.top;
        let pinned_keys = self
            .shell
            .threads
            .iter()
            .map(|t| (t.id.clone(), t.pin_order_key.clone().flatten()))
            .collect();
        let active_keys = self
            .shell
            .threads
            .iter()
            .map(|t| (t.id.clone(), t.active_order_key.clone().flatten()))
            .collect();
        let activation_y = f32::from(press.origin.y);
        self.sidebar.drag = Some(Drag {
            id: press.id.clone(),
            from,
            target: None,
            boundary: divider.map(sidebar_drag::boundary_label_extent),
            shelf_top: settled_header.map(|h| h.top),
            collision: Collision::new(activation_y),
            activation_y,
            center: f32::midpoint(held_extent.top, held_extent.bottom),
            held_height,
            min_center: sidebar_drag::min_held_center(first_top, held_height),
            scroll_at_pickup: f32::from(scroll.offset().y),
            viewport: Extent {
                top: f32::from(viewport.top()),
                bottom: f32::from(viewport.bottom()),
            },
            list_left: f32::from(viewport.left()),
            list_right: f32::from(viewport.right()),
            occurred_at: now_iso(),
            pinned_keys,
            active_keys,
            pinned,
            active,
            settled,
            items,
            extents,
        });
        cx.notify();
    }

    fn move_drag(&mut self, position: Point<Pixels>, cx: &mut Context<'_, Self>) {
        // Near the top or bottom edge the list scrolls under the pointer (`autoScroll`).
        let scroll = self.sidebar_tree.scroll().clone();
        if let Some(drag) = &self.sidebar.drag {
            let y = f32::from(position.y);
            let edge = 28.0;
            let step = if y < drag.viewport.top + edge {
                8.0
            } else if y > drag.viewport.bottom - edge {
                -8.0
            } else {
                0.0
            };
            if step != 0.0 {
                let mut offset = scroll.offset();
                offset.y += px(step);
                scroll.set_offset(offset);
            }
        }
        let scrolled = f32::from(scroll.offset().y);
        let supports = self.gestures_allowed();
        let Some(drag) = &mut self.sidebar.drag else {
            return;
        };
        // The detector keeps what the pointer last did, so it is taken out while it reads `drag`.
        let mut collision = std::mem::take(&mut drag.collision);
        // Everything is held in the frame of the pickup, so a list that scrolled under the
        // pointer does not move the rows it is compared with.
        let shift = scrolled - drag.scroll_at_pickup;
        let pointer_y = f32::from(position.y) - shift;
        let max_center = drag.viewport.bottom - shift - drag.held_height / 2.0;
        let min_center = drag
            .min_center
            .max(drag.viewport.top - shift + drag.held_height / 2.0);
        let held_center = (drag.center + pointer_y - drag.activation_y)
            .clamp(min_center, max_center.max(min_center));
        let inside =
            f32::from(position.x) >= drag.list_left && f32::from(position.x) <= drag.list_right;
        let held = drag.id.clone();
        let from = drag.from;
        let is_valid = |index: usize| {
            let Some(target) = sidebar_drag::resolve_drop_target(&drag.items, &held, index) else {
                return false;
            };
            plan_for(
                &held,
                from,
                &target,
                &drag.pinned,
                &drag.active,
                &drag.pinned_keys,
                &drag.active_keys,
                supports,
            ) != DropPlan::None
        };
        let over = collision.over(&CollisionInput {
            items: &drag.items,
            active_id: &held,
            extents: &drag.extents,
            center_y: held_center,
            pointer_y,
            boundary: drag.boundary.filter(|_| inside),
            shelf_top: drag.shelf_top,
            is_valid: &is_valid,
        });
        drag.collision = collision;
        let target = sidebar_drag::resolve_drop_target(&drag.items, &held, over);
        if drag.target != target {
            drag.target = target;
            cx.notify();
        }
    }

    /// The commands a drop of `drag` needs (`handleThreadDragEnd`), sent in order, with the
    /// result held on screen until the server's shell shows it through.
    fn finish_drag(&mut self, drag: Drag, cx: &mut Context<'_, Self>) {
        let Some(target) = drag.target.clone() else {
            return;
        };
        let plan = plan_for(
            &drag.id,
            drag.from,
            &target,
            &drag.pinned,
            &drag.active,
            &drag.pinned_keys,
            &drag.active_keys,
            self.gestures_allowed(),
        );
        #[cfg(test)]
        {
            self.sidebar.last_drop = Some(plan.clone());
        }
        let Some(held) = self.shell.find_thread(&drag.id).cloned() else {
            return;
        };
        let Some(optimistic) = OptimisticDrop::new(
            &plan,
            &drag.id,
            drag.from,
            target.section,
            &drag.occurred_at,
            &drag.pinned_keys,
            &drag.active_keys,
        ) else {
            return;
        };
        let mut projected = held;
        sidebar_drag::apply_drop(
            &mut projected,
            target.section,
            &drag.occurred_at,
            optimistic.own_key(),
        );
        let (held_id, occurred_at) = (optimistic.id.clone(), optimistic.occurred_at.clone());
        self.sidebar.pending_drop = Some(PendingDrop {
            drop: optimistic,
            thread: projected,
        });
        // A drop the shell never shows through (a server that took it as nothing) is let go, so
        // the list is not held still for good.
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_secs(DROP_HOLD_SECS))
                .await;
            let _ = this.update(cx, |app, cx| {
                let stale = app.sidebar.pending_drop.as_ref().is_some_and(|pending| {
                    pending.drop.id == held_id && pending.drop.occurred_at == occurred_at
                });
                if stale {
                    app.sidebar.pending_drop = None;
                    cx.notify();
                }
            });
        })
        .detach();
        self.run_drop_plan(&drag.id, drag.from, plan, cx);
    }

    fn run_drop_plan(
        &mut self,
        id: &str,
        from: Section,
        plan: DropPlan,
        cx: &mut Context<'_, Self>,
    ) {
        use crate::commands;
        let Some(connection) = self.connection.clone() else {
            self.sidebar.pending_drop = None;
            return;
        };
        let mut steps: Vec<(
            &'static str,
            Result<conn_contract::OrchestrationV2Command, serde_json::Error>,
        )> = Vec::new();
        let mut unpin_undo = None;
        match &plan {
            DropPlan::None => {
                self.sidebar.pending_drop = None;
                return;
            }
            DropPlan::Settle => {
                // A settle keeps its undo notice and moves the open thread on.
                let id = id.to_owned();
                self.settle_thread_reporting(id, true, &HashSet::new(), cx, |app, ok, cx| {
                    if !ok {
                        app.sidebar.pending_drop = None;
                        cx.notify();
                    }
                });
                return;
            }
            DropPlan::ReorderPinned { assignments, .. } => {
                for a in assignments {
                    steps.push((
                        "reorder pinned",
                        commands::reorder_pinned_thread(&a.id, &a.order_key),
                    ));
                }
            }
            DropPlan::Pin {
                order_key, extra, ..
            } => {
                self.forget_thread_undo(id, &[ThreadUndoKind::Pin, ThreadUndoKind::Settle]);
                steps.push(("pin", commands::pin_thread_at(id, order_key.as_deref())));
                for a in extra {
                    steps.push((
                        "reorder pinned",
                        commands::reorder_pinned_thread(&a.id, &a.order_key),
                    ));
                }
            }
            DropPlan::MoveActive {
                assignments,
                unpin,
                unsettle,
                ..
            } => {
                if *unpin {
                    unpin_undo = Some(conn_state::plan_unpin_undo(
                        self.shell.find_thread(id).map(super::settle_facts),
                    ));
                    steps.push(("unpin", commands::pin_thread(id, false)));
                }
                if *unsettle {
                    self.forget_thread_undo(id, &[ThreadUndoKind::Settle]);
                    steps.push(("un-settle", commands::settle_thread(id, false)));
                }
                for a in assignments {
                    steps.push((
                        "reorder active",
                        commands::reorder_active_thread(&a.id, &a.order_key),
                    ));
                }
            }
        }
        let _ = from;
        if steps.is_empty() {
            self.sidebar.pending_drop = None;
            return;
        }
        let thread_id = id.to_owned();
        cx.spawn(async move |this, cx| {
            for (what, command) in steps {
                let outcome = match command {
                    Ok(command) => connection
                        .dispatch_command(command)
                        .await
                        .map_err(|err| err.to_string()),
                    Err(err) => Err(err.to_string()),
                };
                if let Err(err) = outcome {
                    eprintln!("sidebar drop: {what} failed: {err}");
                    let _ = this.update(cx, |app, cx| {
                        app.sidebar.pending_drop = None;
                        cx.notify();
                    });
                    return;
                }
                if what == "unpin"
                    && let Some(plan) = unpin_undo.take()
                {
                    let id = thread_id.clone();
                    let _ = this.update(cx, |app, cx| {
                        app.offer_thread_undo(id, ThreadUndoKind::Pin, plan, cx);
                    });
                }
            }
        })
        .detach();
    }

    /// Ends the held drop once the server's shell shows it through (`isOptimisticDropReleased`).
    pub(crate) fn release_settled_drop(&mut self) {
        let Some(pending) = &self.sidebar.pending_drop else {
            return;
        };
        let lists = sidebar_lists(&self.shell, &self.orbit.workspaces, None, "", &[], None);
        let ids = |threads: &[&ThreadShell]| -> Vec<String> {
            threads.iter().map(|t| t.id.clone()).collect()
        };
        let all: Vec<ThreadShell> = self
            .shell
            .threads
            .iter()
            .chain(&self.shell.archived_threads)
            .cloned()
            .collect();
        if sidebar_drag::drop_released(
            &pending.drop,
            &all,
            &ids(&lists.pinned),
            &ids(&lists.active),
        ) {
            self.sidebar.pending_drop = None;
        }
    }

    // -- The action sweep --

    fn start_sweep(&mut self, press: &Press, action: SweepAction, cx: &mut Context<'_, Self>) {
        let order = self.sidebar_row_order();
        let Some(origin) = self.shell.find_thread(&press.id) else {
            return;
        };
        let origin_section = sidebar_drag::thread_section(origin);
        let mut sweep = Sweep {
            origin: press.id.clone(),
            action,
            keys: Vec::new(),
            target: None,
            order,
            origin_section,
        };
        self.sweep_to(&mut sweep, &press.id);
        self.sidebar.sweep = Some(sweep);
        cx.notify();
    }

    /// The rows the list draws, top to bottom (`orderedThreadKeys`).
    fn sidebar_row_order(&self) -> Vec<String> {
        self.thread_traversal_ids()
    }

    fn sweep_to(&self, sweep: &mut Sweep, key: &str) {
        if sweep.target.as_deref() == Some(key) {
            return;
        }
        sweep.target = Some(key.to_owned());
        let section = sweep.origin_section;
        sweep.keys = sidebar_drag::sweep_keys(&sweep.order, &sweep.origin, key, |id| {
            self.shell
                .find_thread(id)
                .is_some_and(|t| sidebar_drag::thread_section(t) == section)
        });
    }

    fn move_sweep(&mut self, position: Point<Pixels>, cx: &mut Context<'_, Self>) {
        let Some(mut sweep) = self.sidebar.sweep.take() else {
            return;
        };
        let rows: Vec<(String, f32)> = sweep
            .order
            .iter()
            .filter_map(|id| Some((id.clone(), self.row_extent(id)?.top)))
            .collect();
        let viewport = self.sidebar_tree.scroll().bounds();
        let viewport = Extent {
            top: f32::from(viewport.top()),
            bottom: f32::from(viewport.bottom()),
        };
        if let Some(key) =
            sidebar_drag::row_at_y(&rows, f32::from(position.y), Some(viewport)).map(str::to_owned)
        {
            let before = sweep.keys.len();
            self.sweep_to(&mut sweep, &key);
            if sweep.keys.len() != before {
                cx.notify();
            }
        }
        self.sidebar.sweep = Some(sweep);
        cx.notify();
    }

    fn finish_sweep(&mut self, sweep: &Sweep, cx: &mut Context<'_, Self>) {
        #[cfg(test)]
        {
            self.sidebar.last_sweep = Some(sweep.keys.clone());
        }
        match sweep.action {
            SweepAction::Settle => {
                // `settleThreads`: the open thread moves on to one that is not settling too.
                let targets: Vec<String> = sweep
                    .keys
                    .iter()
                    .filter(|id| {
                        self.shell
                            .find_thread(id)
                            .is_some_and(|t| !conn_state::ShellState::is_settled(t))
                    })
                    .cloned()
                    .collect();
                let along: HashSet<String> = targets.iter().cloned().collect();
                for id in targets {
                    self.settle_thread_along(id, true, &along, cx);
                }
            }
            SweepAction::Unsettle => {
                for id in &sweep.keys {
                    self.settle_thread(id.clone(), false, cx);
                }
            }
        }
    }

    /// Escape or a window that lost the pointer ends a drag without dropping.
    pub(crate) fn cancel_pointer_gesture(&mut self, cx: &mut Context<'_, Self>) {
        if self.pointer_captured() {
            self.sidebar_pointer_released(true, cx);
        }
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "the plan reads the held row, both lists and both key maps"
)]
fn plan_for(
    held: &str,
    from: Section,
    target: &DropTarget,
    pinned: &[String],
    active: &[String],
    pinned_keys: &HashMap<String, Option<String>>,
    active_keys: &HashMap<String, Option<String>>,
    supports_settlement: bool,
) -> DropPlan {
    sidebar_drag::plan_thread_drop(&DropInput {
        active_id: held,
        from,
        target,
        pinned_order: pinned,
        pinned_keys,
        active_order: active,
        active_keys,
        supports_settlement,
    })
}

#[cfg(test)]
impl ConnApp {
    /// Scrolls the sidebar list the least that shows the row `key`.
    pub(crate) fn reveal_sidebar_row_for_test(&self, key: &str) {
        self.sidebar_tree.reveal_row(key);
    }

    /// Lets rows be held and swept with no server to take the commands.
    pub(crate) fn allow_gestures_offline_for_test(&mut self) {
        self.sidebar.offline_gestures = true;
    }

    /// The drop that last ended.
    pub(crate) fn last_drop_for_test(&self) -> Option<DropPlan> {
        self.sidebar.last_drop.clone()
    }

    /// The rows the last sweep covered.
    pub(crate) fn last_sweep_for_test(&self) -> Option<Vec<String>> {
        self.sidebar.last_sweep.clone()
    }

    /// Whether a row is held now, and the section it would land in.
    pub(crate) fn held_row_for_test(&self) -> Option<(String, Option<Section>)> {
        self.sidebar
            .drag
            .as_ref()
            .map(|drag| (drag.id.clone(), drag.target.as_ref().map(|t| t.section)))
    }

    /// The rows the sweep covers now.
    pub(crate) fn swept_rows_for_test(&self) -> Vec<String> {
        self.sidebar
            .sweep
            .as_ref()
            .map(|sweep| sweep.keys.clone())
            .unwrap_or_default()
    }

    /// What the server found in messages for `query`, as if it had answered.
    pub(crate) fn message_matches_for_test(
        &mut self,
        query: &str,
        matches: Vec<conn_contract::OrchestrationThreadSearchMatch>,
        cx: &mut Context<'_, Self>,
    ) {
        let found = SettledSearch {
            query: query.to_owned(),
            matches,
        };
        let search = &mut self.sidebar.search;
        search.searching = true;
        search.pending = false;
        search.previous = Some(found.clone());
        search.ready = Some(found);
        cx.notify();
    }

    /// The message shown under a search result.
    pub(crate) fn excerpt_for_test(&self, thread_id: &str) -> Option<String> {
        self.sidebar
            .search
            .excerpts
            .get(thread_id)
            .map(|excerpt| excerpt.snippet.clone())
    }
}
