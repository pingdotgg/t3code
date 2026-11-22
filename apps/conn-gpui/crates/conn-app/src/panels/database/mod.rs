//! The Database surface (Conn `apps/web/src/database/DatabasePanel.tsx`): the project's
//! database from `.env` and saved manual connections, their tables, a table's columns, and
//! read-only SQL executed natively via [`conn_desktop::database::DatabaseRunner`].

mod form;
mod store;
mod views;

use conn_desktop::database::api::{
    CallOptions, ConnectionSource, DatabaseQueryResult, PanelConnection, browse_table_sql,
    connection_key, connection_target, describe_database_table, list_database_tables,
    new_connection, panel_connection_from_vault, run_read_only_query,
};
use conn_desktop::database::{DatabaseColumn, DatabaseRunner};
use conn_desktop::vault::VaultErrorKind;
use conn_theme::Tokens;
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, Context, Entity, FontWeight, IntoElement, KeyDownEvent, MouseButton, ParentElement,
    Render, SharedString, Styled, Subscription, Window, div, px, relative,
};

use self::form::{ConnectionFormState, outline_sm_button};
use self::store::{
    DatabaseStore, active_connection, filter_tables, finalize_draft, format_result_summary,
    load_env_connection, load_store, project_connections, save_store,
};
use self::views::{
    render_connection_alert, render_connection_menu, render_rows_grid, render_structure_list,
};
use super::chrome::{
    self, ConnTooltipExt as _, ICON_BUTTON_GLYPH_PX, ROW_PAD_START_PX, SectionTab,
    UI_LINE_HEIGHT_PX, UI_TEXT_PX, XS_LINE_HEIGHT_PX, XS_TEXT_PX,
};
use super::color::to_hsla;
use super::header::{CONTROL_RADIUS_PX, superhero_icon};
use crate::a11y::ConnA11yExt as _;
use crate::theme::MONO_FONT;

/// Left table-list column width (`w-52` = 208px).
const TABLE_LIST_WIDTH_PX: f32 = 208.0;
/// Result tabs bar height (`ApiTabs className="h-11"` = 44px) so the Run toolbar group fits.
const RESULT_TABS_HEIGHT_PX: f32 = 44.0;
/// Minimum height of the SQL editor (`min-h-24` = 96px).
const SQL_EDITOR_MIN_HEIGHT_PX: f32 = 96.0;
/// Placeholder shown in the SQL editor (`DatabasePanel.tsx`).
const SQL_PLACEHOLDER: &str = "select * from users limit 100";
const PILL_RADIUS_PX: f32 = 9999.0;

#[derive(Debug, Clone)]
struct KeyedLoad<T> {
    key: String,
    loading: bool,
    data: Option<T>,
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct QueryState {
    key: String,
    running: bool,
    result: Option<DatabaseQueryResult>,
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct PickedTable {
    key: String,
    table: String,
}

/// The Database panel entity.
pub(crate) struct DatabasePanel {
    tokens: Tokens,
    project_key: Option<String>,
    workspace_root: Option<String>,
    store: DatabaseStore,
    runner: DatabaseRunner,
    env_connection: Option<PanelConnection>,
    vault_connections: Vec<PanelConnection>,
    vault_status: Option<VaultErrorKind>,
    vault_error: Option<String>,
    allow_unlock_next: bool,
    pub(super) editing: Option<ConnectionFormState>,
    menu_open: bool,
    filter: String,
    clear_filter_pending: bool,
    filter_input: Entity<InputState>,
    sql_input: Entity<TextareaState>,
    /// `(project_key, connection_id)` currently loaded into `sql_input`.
    synced_sql: Option<(String, String)>,
    tab: &'static str,
    refresh_nonce: u64,
    reconnect_next: bool,
    tables_load: Option<KeyedLoad<Vec<String>>>,
    columns_load: Option<KeyedLoad<Vec<DatabaseColumn>>>,
    picked: Option<PickedTable>,
    query: Option<QueryState>,
    run_id: u64,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for DatabasePanel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DatabasePanel")
            .field("project_key", &self.project_key)
            .field("workspace_root", &self.workspace_root)
            .field("tab", &self.tab)
            .field("editing", &self.editing.is_some())
            .finish_non_exhaustive()
    }
}

impl DatabasePanel {
    pub(crate) fn new(tokens: Tokens, window: &mut Window, cx: &mut Context<'_, Self>) -> Self {
        let filter_input = cx.new(|cx| InputState::new(window, cx).placeholder("Tables"));
        let sql_input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(SQL_PLACEHOLDER)
                .auto_grow(5, 12)
        });

        let filter_sub = cx.subscribe(&filter_input, |this, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.filter = input.read(cx).value().to_string();
                cx.notify();
            }
        });
        let sql_sub = cx.subscribe(&sql_input, |this, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                let next_sql = input.read(cx).value().to_string();
                let Some(project_key) = this.project_key.clone() else {
                    return;
                };
                let Some(connection_id) = this.selected_connection().map(|c| c.id) else {
                    return;
                };
                if this.store.sql(&project_key, &connection_id) == next_sql {
                    return;
                }
                this.store.set_sql(&project_key, &connection_id, next_sql);
                save_store(&this.store);
                cx.notify();
            }
        });

        Self {
            tokens,
            project_key: None,
            workspace_root: None,
            store: load_store(),
            runner: DatabaseRunner::new(),
            env_connection: None,
            vault_connections: Vec::new(),
            vault_status: None,
            vault_error: None,
            allow_unlock_next: false,
            editing: None,
            menu_open: false,
            filter: String::new(),
            clear_filter_pending: false,
            filter_input,
            sql_input,
            synced_sql: None,
            tab: "rows",
            refresh_nonce: 0,
            reconnect_next: false,
            tables_load: None,
            columns_load: None,
            picked: None,
            query: None,
            run_id: 0,
            _subscriptions: vec![filter_sub, sql_sub],
        }
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    /// The selected thread's project (Conn keys panel state by project) and its folder.
    pub(crate) fn set_project(
        &mut self,
        project_key: Option<String>,
        workspace_root: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.project_key == project_key && self.workspace_root == workspace_root {
            return;
        }
        self.project_key = project_key;
        self.workspace_root = workspace_root;
        self.env_connection = load_env_connection(self.workspace_root.as_deref());
        self.editing = None;
        self.menu_open = false;
        self.filter.clear();
        self.clear_filter_pending = true;
        self.synced_sql = None;
        self.picked = None;
        self.query = None;
        self.tables_load = None;
        self.columns_load = None;
        self.load_vault_databases(false, cx);
        self.ensure_tables_loaded(cx);
        cx.notify();
    }

    pub(super) fn load_vault_databases(&mut self, allow_unlock: bool, cx: &mut Context<'_, Self>) {
        if cfg!(test) {
            return;
        }
        let vault = self.runner.vault().clone();
        if !vault.is_installed() {
            self.vault_connections.clear();
            self.vault_status = Some(VaultErrorKind::Unavailable);
            self.vault_error = None;
            return;
        }
        let task = crate::live::RT.spawn(async move { vault.list_databases(allow_unlock).await });
        cx.spawn(async move |this, cx| {
            let outcome = task.await;
            let _ = this.update(cx, |panel, cx| {
                match outcome {
                    Ok(Ok(dbs)) => {
                        panel.vault_connections =
                            dbs.iter().map(panel_connection_from_vault).collect();
                        panel.vault_status = None;
                        panel.vault_error = None;
                    }
                    Ok(Err(err)) => {
                        panel.vault_connections.clear();
                        panel.vault_status = Some(err.kind);
                        panel.vault_error = Some(err.message);
                    }
                    Err(join_err) => {
                        panel.vault_connections.clear();
                        panel.vault_status = Some(VaultErrorKind::Error);
                        panel.vault_error = Some(join_err.to_string());
                    }
                }
                panel.ensure_tables_loaded(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn connections(&self) -> Vec<PanelConnection> {
        let saved = self
            .project_key
            .as_deref()
            .map_or(&[][..], |key| self.store.saved_connections(key));
        let mut all = project_connections(self.env_connection.as_ref(), saved);
        all.extend(self.vault_connections.iter().cloned());
        all
    }

    fn selected_connection(&self) -> Option<PanelConnection> {
        let connections = self.connections();
        let remembered = self
            .project_key
            .as_deref()
            .and_then(|key| self.store.remembered_connection(key));
        active_connection(&connections, remembered)
    }

    fn current_sql(&self, connection_id: &str) -> String {
        self.project_key.as_deref().map_or_else(String::new, |key| {
            self.store.sql(key, connection_id).to_owned()
        })
    }

    fn take_call_options(&mut self) -> CallOptions {
        let reconnect = self.reconnect_next;
        let allow_unlock = self.allow_unlock_next;
        self.reconnect_next = false;
        self.allow_unlock_next = false;
        CallOptions {
            reconnect,
            allow_unlock,
        }
    }

    fn sync_inputs(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.clear_filter_pending {
            self.clear_filter_pending = false;
            self.filter_input
                .update(cx, |state, cx| state.set_value(String::new(), window, cx));
        }
        let (Some(project_key), Some(connection)) =
            (self.project_key.clone(), self.selected_connection())
        else {
            return;
        };
        let target = (project_key.clone(), connection.id.clone());
        if self.synced_sql.as_ref() == Some(&target) {
            return;
        }
        self.synced_sql = Some(target);
        let sql = self.store.sql(&project_key, &connection.id).to_owned();
        self.sql_input
            .update(cx, |state, cx| state.set_value(sql, window, cx));
    }

    fn ensure_tables_loaded(&mut self, cx: &mut Context<'_, Self>) {
        let Some(connection) = self.selected_connection() else {
            self.tables_load = None;
            return;
        };
        let key = format!("{}:{}", connection_key(&connection), self.refresh_nonce);
        if self
            .tables_load
            .as_ref()
            .is_some_and(|state| state.key == key)
        {
            return;
        }
        let options = self.take_call_options();
        self.tables_load = Some(KeyedLoad {
            key: key.clone(),
            loading: true,
            data: None,
            error: None,
        });
        let runner = self.runner.clone();
        let db_conn = connection.connection;
        let task = crate::live::RT
            .spawn(async move { list_database_tables(&runner, &db_conn, options).await });
        cx.spawn(async move |this, cx| {
            let outcome = task.await;
            let _ = this.update(cx, |panel, cx| {
                if panel
                    .tables_load
                    .as_ref()
                    .is_none_or(|state| state.key != key)
                {
                    return;
                }
                match outcome {
                    Ok(Ok(tables)) => {
                        panel.tables_load = Some(KeyedLoad {
                            key,
                            loading: false,
                            data: Some(tables),
                            error: None,
                        });
                    }
                    Ok(Err(error)) => {
                        panel.tables_load = Some(KeyedLoad {
                            key,
                            loading: false,
                            data: None,
                            error: Some(error.to_string()),
                        });
                    }
                    Err(join_error) => {
                        panel.tables_load = Some(KeyedLoad {
                            key,
                            loading: false,
                            data: None,
                            error: Some(join_error.to_string()),
                        });
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn ensure_columns_loaded(
        &mut self,
        connection: &PanelConnection,
        table: &str,
        cx: &mut Context<'_, Self>,
    ) {
        let conn_key = connection_key(connection);
        let key = format!("{conn_key}:{table}:{}", self.refresh_nonce);
        if self
            .columns_load
            .as_ref()
            .is_some_and(|state| state.key == key)
        {
            return;
        }
        let options = self.take_call_options();
        self.columns_load = Some(KeyedLoad {
            key: key.clone(),
            loading: true,
            data: None,
            error: None,
        });
        let runner = self.runner.clone();
        let db_conn = connection.connection.clone();
        let table_name = table.to_owned();
        let task = crate::live::RT.spawn(async move {
            describe_database_table(&runner, &db_conn, &table_name, options).await
        });
        cx.spawn(async move |this, cx| {
            let outcome = task.await;
            let _ = this.update(cx, |panel, cx| {
                if panel
                    .columns_load
                    .as_ref()
                    .is_none_or(|state| state.key != key)
                {
                    return;
                }
                match outcome {
                    Ok(Ok(columns)) => {
                        panel.columns_load = Some(KeyedLoad {
                            key,
                            loading: false,
                            data: Some(columns),
                            error: None,
                        });
                    }
                    Ok(Err(error)) => {
                        panel.columns_load = Some(KeyedLoad {
                            key,
                            loading: false,
                            data: None,
                            error: Some(error.to_string()),
                        });
                    }
                    Err(join_error) => {
                        panel.columns_load = Some(KeyedLoad {
                            key,
                            loading: false,
                            data: None,
                            error: Some(join_error.to_string()),
                        });
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Places an agent-provided SQL query in the editor without running it.
    pub(crate) fn set_agent_sql(&mut self, sql: String, cx: &mut Context<'_, Self>) {
        if let (Some(project_key), Some(connection)) =
            (self.project_key.clone(), self.selected_connection())
        {
            self.store.set_sql(&project_key, &connection.id, sql);
            save_store(&self.store);
            self.synced_sql = None;
            self.tab = "rows";
            cx.notify();
        }
    }

    /// Executes an agent's read-only SQL query in the Database panel so the user sees the live
    /// rows, and returns the truncated [`conn_contract::AgentPanelDatabaseResult`].
    pub(crate) fn run_agent_query(
        &mut self,
        sql: String,
        connection_name: Option<String>,
        cx: &mut Context<'_, Self>,
    ) -> tokio::sync::oneshot::Receiver<Result<conn_contract::AgentPanelDatabaseResult, String>>
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if sql.trim().is_empty() {
            let _ = tx.send(Err("SQL query is empty.".to_owned()));
            return rx;
        }
        let connections = self.connections();
        let wanted = connection_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty());
        let picked = match wanted {
            Some(name) => connections
                .iter()
                .find(|c| c.name.trim().eq_ignore_ascii_case(name))
                .cloned(),
            None => self.selected_connection(),
        };
        let Some(connection) = picked else {
            let names = if connections.is_empty() {
                "none".to_owned()
            } else {
                connections
                    .iter()
                    .map(|c| c.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            let msg = match wanted {
                Some(name) => {
                    format!("No database connection named \"{name}\". Connections: {names}.")
                }
                None => format!(
                    "No database connection configured for this project. Connections: {names}."
                ),
            };
            let _ = tx.send(Err(msg));
            return rx;
        };

        if let Some(project_key) = self.project_key.clone() {
            self.store.set_connection(&project_key, &connection.id);
            self.store
                .set_sql(&project_key, &connection.id, sql.clone());
            save_store(&self.store);
        }
        self.synced_sql = None;
        self.tab = "rows";

        let key = connection_key(&connection);
        self.run_id = self.run_id.wrapping_add(1);
        let run_id = self.run_id;
        let previous_result = self
            .query
            .as_ref()
            .filter(|q| q.key == key)
            .and_then(|q| q.result.clone());
        self.query = Some(QueryState {
            key: key.clone(),
            running: true,
            result: previous_result,
            error: None,
        });
        cx.notify();

        let options = self.take_call_options();
        let runner = self.runner.clone();
        let db_conn = connection.connection.clone();
        let task = crate::live::RT
            .spawn(async move { run_read_only_query(&runner, &db_conn, &sql, options).await });
        cx.spawn(async move |this, cx| {
            let outcome = task.await;
            let reply = match &outcome {
                Ok(Ok(result)) => {
                    let agent_res =
                        conn_desktop::database::api::agent_query_result(&connection, result);
                    Ok(conn_contract::AgentPanelDatabaseResult {
                        connection: agent_res.connection,
                        columns: agent_res.columns,
                        row_count: conn_contract::support::JsNumber(agent_res.row_count as f64),
                        rows: agent_res
                            .rows
                            .into_iter()
                            .map(|row| row.into_iter().collect())
                            .collect(),
                        truncated: agent_res.truncated,
                    })
                }
                Ok(Err(error)) => Err(error.to_string()),
                Err(join_error) => Err(join_error.to_string()),
            };
            let _ = this.update(cx, |panel, cx| {
                if panel.run_id == run_id {
                    panel.query = Some(match outcome {
                        Ok(Ok(result)) => QueryState {
                            key,
                            running: false,
                            result: Some(result),
                            error: None,
                        },
                        Ok(Err(error)) => QueryState {
                            key,
                            running: false,
                            result: None,
                            error: Some(error.to_string()),
                        },
                        Err(join_error) => QueryState {
                            key,
                            running: false,
                            result: None,
                            error: Some(join_error.to_string()),
                        },
                    });
                    cx.notify();
                }
            });
            let _ = tx.send(reply);
        })
        .detach();
        rx
    }

    fn run_sql(&mut self, statement: String, cx: &mut Context<'_, Self>) {
        if statement.trim().is_empty() {
            return;
        }
        let Some(connection) = self.selected_connection() else {
            return;
        };
        let key = connection_key(&connection);
        self.run_id = self.run_id.wrapping_add(1);
        let run_id = self.run_id;
        self.tab = "rows";
        let previous_result = self
            .query
            .as_ref()
            .filter(|q| q.key == key)
            .and_then(|q| q.result.clone());
        self.query = Some(QueryState {
            key: key.clone(),
            running: true,
            result: previous_result,
            error: None,
        });
        cx.notify();

        let options = self.take_call_options();
        let runner = self.runner.clone();
        let db_conn = connection.connection;
        let task = crate::live::RT.spawn(async move {
            run_read_only_query(&runner, &db_conn, &statement, options).await
        });
        cx.spawn(async move |this, cx| {
            let outcome = task.await;
            let _ = this.update(cx, |panel, cx| {
                if panel.run_id != run_id {
                    return;
                }
                match outcome {
                    Ok(Ok(result)) => {
                        panel.query = Some(QueryState {
                            key,
                            running: false,
                            result: Some(result),
                            error: None,
                        });
                    }
                    Ok(Err(error)) => {
                        panel.query = Some(QueryState {
                            key,
                            running: false,
                            result: None,
                            error: Some(error.to_string()),
                        });
                    }
                    Err(join_error) => {
                        panel.query = Some(QueryState {
                            key,
                            running: false,
                            result: None,
                            error: Some(join_error.to_string()),
                        });
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn run_current_sql(&mut self, cx: &mut Context<'_, Self>) {
        let Some(connection) = self.selected_connection() else {
            return;
        };
        let sql = self.current_sql(&connection.id);
        self.run_sql(sql, cx);
    }

    fn open_table(&mut self, name: String, window: &mut Window, cx: &mut Context<'_, Self>) {
        let Some(connection) = self.selected_connection() else {
            return;
        };
        let key = connection_key(&connection);
        let statement = browse_table_sql(connection.connection.driver, &name);
        self.picked = Some(PickedTable {
            key,
            table: name.clone(),
        });
        if let Some(project_key) = self.project_key.clone() {
            self.store
                .set_sql(&project_key, &connection.id, statement.clone());
            save_store(&self.store);
            self.synced_sql = Some((project_key, connection.id.clone()));
        }
        self.sql_input.update(cx, |state, cx| {
            state.set_value(statement.clone(), window, cx)
        });
        self.ensure_columns_loaded(&connection, &name, cx);
        self.run_sql(statement, cx);
    }

    pub(super) fn select_connection(&mut self, id: &str, cx: &mut Context<'_, Self>) {
        if let Some(project_key) = self.project_key.clone() {
            self.store.set_connection(&project_key, id);
            save_store(&self.store);
        }
        self.menu_open = false;
        self.allow_unlock_next = id.starts_with("vault:");
        self.synced_sql = None;
        self.ensure_tables_loaded(cx);
        cx.notify();
    }

    pub(super) fn begin_add_connection(
        &mut self,
        seed_from_env: bool,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let seed = if seed_from_env {
            self.env_connection.as_ref()
        } else {
            None
        };
        let draft = new_connection(seed);
        self.menu_open = false;
        self.editing = Some(ConnectionFormState::new(draft, window, cx));
        cx.notify();
    }

    pub(super) fn begin_edit_selected(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let Some(selected) = self.selected_connection() else {
            return;
        };
        let draft = if selected.source == ConnectionSource::Env {
            new_connection(Some(&selected))
        } else {
            selected
        };
        self.menu_open = false;
        self.editing = Some(ConnectionFormState::new(draft, window, cx));
        cx.notify();
    }

    pub(super) fn delete_selected_connection(&mut self, cx: &mut Context<'_, Self>) {
        let (Some(project_key), Some(selected)) =
            (self.project_key.clone(), self.selected_connection())
        else {
            return;
        };
        if selected.source != ConnectionSource::Manual {
            return;
        }
        self.store.remove_connection(&project_key, &selected.id);
        save_store(&self.store);
        self.menu_open = false;
        self.synced_sql = None;
        self.ensure_tables_loaded(cx);
        cx.notify();
    }

    pub(super) fn cancel_editing(&mut self, cx: &mut Context<'_, Self>) {
        self.editing = None;
        cx.notify();
    }

    pub(super) fn save_editing(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let Some(form) = self.editing.take() else {
            return;
        };
        if !form.can_save() {
            self.editing = Some(form);
            return;
        }
        let saved = finalize_draft(form.draft);
        if let Some(project_key) = self.project_key.clone() {
            self.store.save_connection(&project_key, saved);
            save_store(&self.store);
        }
        self.synced_sql = None;
        self.sync_inputs(window, cx);
        self.ensure_tables_loaded(cx);
        cx.notify();
    }

    fn refresh(&mut self, cx: &mut Context<'_, Self>) {
        self.reconnect_next = true;
        self.env_connection = load_env_connection(self.workspace_root.as_deref());
        self.load_vault_databases(false, cx);
        self.refresh_nonce = self.refresh_nonce.wrapping_add(1);
        self.tables_load = None;
        self.columns_load = None;
        self.ensure_tables_loaded(cx);
        if let Some(connection) = self.selected_connection() {
            let conn_key = connection_key(&connection);
            if let Some(table) = self
                .picked
                .as_ref()
                .filter(|p| p.key == conn_key)
                .map(|p| p.table.clone())
            {
                self.ensure_columns_loaded(&connection, &table, cx);
            }
        }
        cx.notify();
    }

    fn render_toolbar(
        &self,
        connections: &[PanelConnection],
        selected: Option<&PanelConnection>,
        tables_loading: bool,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = &self.tokens;
        let entity = cx.entity();
        let fg = to_hsla(tokens.foreground);
        let muted = to_hsla(tokens.muted_foreground);
        let hover = to_hsla(tokens.shell_highlight);

        let mut trigger = h_flex()
            .id("db-connection-trigger")
            .a11y_button(
                "database.connection.trigger",
                selected.map_or_else(
                    || "Choose a connection".to_owned(),
                    |conn| format!("Database connection: {}", conn.name),
                ),
            )
            .min_w_0()
            .max_w_full()
            .h(px(24.0))
            .px(px(7.0))
            .gap(px(4.0))
            .items_center()
            .rounded(px(PILL_RADIUS_PX))
            .cursor_pointer()
            .text_size(px(XS_TEXT_PX))
            .line_height(px(XS_LINE_HEIGHT_PX))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .hover(move |s| s.bg(hover))
            .on_click({
                let entity = entity.clone();
                move |_, _, cx| {
                    entity.update(cx, |panel, cx| {
                        panel.menu_open = !panel.menu_open;
                        if panel.menu_open
                            && (panel.vault_connections.is_empty() || panel.vault_status.is_some())
                        {
                            panel.load_vault_databases(false, cx);
                        }
                        cx.notify();
                    });
                }
            })
            .child(superhero_icon(
                "superhero/database.svg",
                ICON_BUTTON_GLYPH_PX,
                muted,
            ))
            .child(div().min_w_0().truncate().child(selected.map_or_else(
                || "Choose a connection".to_owned(),
                |conn| conn.name.clone(),
            )));

        if let Some(conn) = selected
            && conn.source != ConnectionSource::Vault
        {
            trigger = trigger.child(div().min_w_0().truncate().text_color(muted).child(
                connection_target(&conn.connection, conn.ssh_host.as_deref()),
            ));
        }

        trigger = trigger.child(superhero_icon(
            "superhero/chevron-down.svg",
            ICON_BUTTON_GLYPH_PX,
            muted,
        ));

        let mut connection_anchor = div().relative().min_w_0().flex_shrink(1.0).child(
            chrome::toolbar_group(tokens)
                .flex_shrink(1.0)
                .min_w_0()
                .max_w_full()
                .child(trigger),
        );
        if self.menu_open {
            connection_anchor = connection_anchor.child(render_connection_menu(
                tokens,
                connections,
                selected,
                self.vault_status,
                self.vault_error.as_deref(),
                cx,
            ));
        }

        let refresh_icon = if tables_loading {
            "superhero/spinner.svg"
        } else {
            "superhero/refresh.svg"
        };
        let refresh_group = chrome::toolbar_group(tokens).child(
            chrome::icon_button(
                "db-refresh-btn",
                refresh_icon,
                tokens,
                false,
                move |_, _, cx| entity.update(cx, |panel, cx| panel.refresh(cx)),
            )
            .conn_tooltip("Reload .env and tables", tokens),
        );

        chrome::toolbar_row(tokens)
            .child(connection_anchor)
            .child(
                div()
                    .ml_auto()
                    .flex_shrink_0()
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child("Read-only"),
            )
            .child(refresh_group)
            .into_any_element()
    }

    fn render_empty_no_connection(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let tokens = &self.tokens;
        let entity = cx.entity();
        v_flex()
            .flex_1()
            .min_h_0()
            .w_full()
            .items_start()
            .gap(px(12.0))
            .px(px(ROW_PAD_START_PX))
            .py(px(12.0))
            .child(
                div()
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(to_hsla(tokens.muted_foreground))
                    .child("No database in the project's .env (DB_CONNECTION). Add a connection to browse one."),
            )
            .child(outline_sm_button(
                "db-empty-add",
                Some("superhero/add.svg"),
                "Add connection",
                tokens,
                false,
                move |_, window, cx| {
                    entity.update(cx, |panel, cx| panel.begin_add_connection(false, window, cx));
                },
            ))
            .into_any_element()
    }

    fn render_workspace(
        &self,
        connection: &PanelConnection,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = &self.tokens;
        let entity = cx.entity();
        let conn_key = connection_key(connection);
        let expected_tables_key = format!("{conn_key}:{}", self.refresh_nonce);
        let tables_load = self
            .tables_load
            .as_ref()
            .filter(|load| load.key == expected_tables_key);
        let tables_loading = tables_load.is_some_and(|load| load.loading);
        let tables_error = tables_load.and_then(|load| load.error.as_deref());
        let tables = tables_load.and_then(|load| load.data.as_deref());

        let selected_table = self
            .picked
            .as_ref()
            .filter(|p| p.key == conn_key)
            .map(|p| p.table.as_str());

        let expected_columns_key =
            selected_table.map(|table| format!("{conn_key}:{table}:{}", self.refresh_nonce));
        let columns_load = expected_columns_key.as_deref().and_then(|expected| {
            self.columns_load
                .as_ref()
                .filter(|load| load.key == expected)
        });
        let columns = columns_load.and_then(|load| load.data.as_deref());
        let columns_error = columns_load.and_then(|load| load.error.as_deref());

        let current_query = self.query.as_ref().filter(|q| q.key == conn_key);
        let result = current_query.and_then(|q| q.result.as_ref());
        let running = current_query.is_some_and(|q| q.running);
        let query_error = current_query.and_then(|q| q.error.as_deref());
        let sql = self.current_sql(&connection.id);

        let fg = to_hsla(tokens.foreground);
        let muted = to_hsla(tokens.muted_foreground);
        let divider = to_hsla(tokens.shell_divider);
        let highlight = to_hsla(tokens.shell_highlight);
        let row_hover = chrome::alpha(tokens.foreground, 0.04);

        // ── Left column: Table list (`w-52`) ─────────────────────────────────
        let filter_field = chrome::soft_input_group(tokens)
            .pl(px(9.0))
            .pr(px(12.0))
            .gap(px(6.0))
            .child(superhero_icon("superhero/search.svg", 14.0, muted))
            .child(
                div().flex_1().min_w_0().child(
                    Input::new(&self.filter_input)
                        .appearance(false)
                        .text_size(px(UI_TEXT_PX)),
                ),
            );

        let mut table_rows = v_flex()
            .id("db-tables-scroll")
            .flex_1()
            .min_h_0()
            .w_full()
            .overflow_y_scroll()
            .px(px(6.0))
            .pb(px(8.0));

        if tables_loading {
            table_rows = table_rows.child(
                h_flex()
                    .w_full()
                    .justify_center()
                    .py(px(12.0))
                    .child(superhero_icon("superhero/spinner.svg", 16.0, muted)),
            );
        }
        if let Some(tables) = tables {
            let visible = filter_tables(tables, &self.filter);
            if visible.is_empty() {
                table_rows = table_rows.child(
                    div()
                        .px(px(10.0))
                        .py(px(8.0))
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child("No tables"),
                );
            } else {
                for name in visible {
                    let is_selected = selected_table == Some(name.as_str());
                    let click_name = name.clone();
                    let entity = entity.clone();
                    table_rows = table_rows.child(
                        h_flex()
                            .id(SharedString::from(format!("db-table-{name}")))
                            .h(px(28.0))
                            .w_full()
                            .items_center()
                            .rounded(px(CONTROL_RADIUS_PX))
                            .px(px(10.0))
                            .cursor_pointer()
                            .text_size(px(UI_TEXT_PX))
                            .line_height(px(UI_LINE_HEIGHT_PX))
                            .text_color(if is_selected { fg } else { muted })
                            .when(is_selected, |el| el.bg(highlight))
                            .when(!is_selected, |el| {
                                el.hover(move |s| s.bg(row_hover).text_color(fg))
                            })
                            .on_click(move |_, window, cx| {
                                let table = click_name.clone();
                                entity.update(cx, |panel, cx| panel.open_table(table, window, cx));
                            })
                            .child(div().min_w_0().flex_1().truncate().child(name)),
                    );
                }
            }
        }

        let left_column = v_flex()
            .w(px(TABLE_LIST_WIDTH_PX))
            .flex_shrink_0()
            .min_h_0()
            .border_r_1()
            .border_color(divider)
            .child(div().flex_shrink_0().p(px(8.0)).child(filter_field))
            .child(table_rows);

        // ── Right column: SQL editor + Result tabs + Results ─────────────────
        let sql_editor = v_flex()
            .w_full()
            .flex_shrink_0()
            .min_h(px(SQL_EDITOR_MIN_HEIGHT_PX))
            .max_h(relative(0.4))
            .border_b_1()
            .border_color(divider)
            .child(
                div()
                    .id("db-sql-scroll")
                    .min_h_0()
                    .w_full()
                    .overflow_y_scroll()
                    .px(px(ROW_PAD_START_PX))
                    .py(px(12.0))
                    .font_family(SharedString::from(MONO_FONT))
                    .child(
                        Textarea::new(&self.sql_input)
                            .appearance(false)
                            .text_size(px(XS_TEXT_PX)),
                    ),
            );

        let run_disabled = running || sql.trim().is_empty();
        let run_icon = if running {
            "superhero/spinner.svg"
        } else {
            "superhero/play.svg"
        };
        let run_button = {
            let entity = entity.clone();
            let base = h_flex()
                .id("db-run-btn")
                .flex_shrink_0()
                .h(px(24.0))
                .px(px(7.0))
                .gap(px(4.0))
                .items_center()
                .rounded(px(PILL_RADIUS_PX))
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .font_weight(FontWeight::MEDIUM)
                .text_color(fg)
                .child(superhero_icon(run_icon, ICON_BUTTON_GLYPH_PX, muted))
                .child("Run");
            if run_disabled {
                base.opacity(0.64)
            } else {
                base.cursor_pointer()
                    .hover(move |s| s.bg(highlight))
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |panel, cx| panel.run_current_sql(cx));
                    })
            }
        };

        let mut trailing = h_flex().items_center().gap(px(8.0));
        if let Some(res) = result {
            trailing = trailing.child(
                div()
                    .flex_shrink_0()
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(format_result_summary(res)),
            );
        }
        trailing = trailing.child(chrome::toolbar_group(tokens).child(run_button));

        let tabs = [
            SectionTab {
                id: "rows",
                label: "Rows",
                count: result.map(|res| res.row_count),
            },
            SectionTab {
                id: "structure",
                label: "Structure",
                count: columns.map(<[DatabaseColumn]>::len),
            },
        ];
        let tabs_bar = chrome::section_tabs(
            "db-result-tabs",
            tokens,
            &tabs,
            self.tab,
            Some(trailing.into_any_element()),
            move |next_tab, _, cx| {
                entity.update(cx, |panel, cx| {
                    panel.tab = next_tab;
                    cx.notify();
                });
            },
        )
        .h(px(RESULT_TABS_HEIGHT_PX));

        let result_body: AnyElement = if self.tab == "rows" {
            if let Some(err) = query_error {
                chrome::warning_notice(tokens, err.to_owned()).into_any_element()
            } else if let Some(res) = result {
                render_rows_grid(tokens, res)
            } else {
                div()
                    .px(px(ROW_PAD_START_PX))
                    .py(px(12.0))
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(if running {
                        "Running…"
                    } else {
                        "Pick a table, or write a query and press ⌘↵."
                    })
                    .into_any_element()
            }
        } else if selected_table.is_none() {
            div()
                .px(px(ROW_PAD_START_PX))
                .py(px(12.0))
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted)
                .child("Pick a table to see its columns.")
                .into_any_element()
        } else if let Some(err) = columns_error {
            chrome::warning_notice(tokens, err.to_owned()).into_any_element()
        } else if let Some(cols) = columns {
            render_structure_list(tokens, cols)
        } else {
            h_flex()
                .w_full()
                .justify_center()
                .py(px(12.0))
                .child(superhero_icon("superhero/spinner.svg", 16.0, muted))
                .into_any_element()
        };

        let right_column = v_flex()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .child(sql_editor)
            .child(tabs_bar)
            .child(
                div()
                    .id("db-result-scroll")
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .overflow_scroll()
                    .child(result_body),
            );

        let mut container = v_flex().flex_1().min_h_0().w_full();
        if let Some(err) = tables_error {
            container = container.child(render_connection_alert(tokens, err));
        }
        container
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .child(left_column)
                    .child(right_column),
            )
            .into_any_element()
    }
}

impl Render for DatabasePanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        self.sync_inputs(window, cx);
        if self.project_key.is_none() {
            return chrome::empty_state(
                &self.tokens,
                "Database connections are only available from a project thread.",
            )
            .into_any_element();
        }

        let connections = self.connections();
        let selected = self.selected_connection();
        let tables_loading = selected.as_ref().is_some_and(|conn| {
            let expected = format!("{}:{}", connection_key(conn), self.refresh_nonce);
            self.tables_load
                .as_ref()
                .is_some_and(|load| load.key == expected && load.loading)
        });

        let toolbar = self.render_toolbar(&connections, selected.as_ref(), tables_loading, cx);
        let body: AnyElement = if let Some(form) = &self.editing {
            form.render(&self.tokens, cx)
        } else if let Some(connection) = &selected {
            self.render_workspace(connection, cx)
        } else {
            self.render_empty_no_connection(cx)
        };

        v_flex()
            .id("database-panel")
            .size_full()
            // Capture phase intercepts Cmd+Enter / Ctrl+Enter before TextareaState inserts a newline.
            .capture_key_down(cx.listener(|panel, event: &KeyDownEvent, _, cx| {
                let k = &event.keystroke;
                if panel.menu_open && k.key == "escape" {
                    panel.menu_open = false;
                    cx.notify();
                    cx.stop_propagation();
                    return;
                }
                if panel.editing.is_none()
                    && k.key == "enter"
                    && (k.modifiers.platform || k.modifiers.control)
                {
                    panel.run_current_sql(cx);
                    cx.stop_propagation();
                }
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|panel, _, _, cx| {
                    if panel.menu_open {
                        panel.menu_open = false;
                        cx.notify();
                    }
                }),
            )
            .child(toolbar)
            .child(body)
            .into_any_element()
    }
}
