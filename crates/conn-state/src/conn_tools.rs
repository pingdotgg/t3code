//! Friendly label and icon for Conn's own agent MCP tools.
//!
//! Providers spell a tool call many ways: `mcp__conn__conn_thread_send` (Claude),
//! `conn.conn_thread_send` or `conn:conn_thread_send` (Codex, ACP), `conn-<thread>_conn_thread_send`
//! (OpenCode) or the bare tool name. Threads recorded before PR #223 used the server `t3-code` and
//! `t3_*` tool names; those still resolve. The table mirrors `T3_MCP_TOOLS` in web's
//! `packages/shared/src/t3McpToolPresentation.ts`: the label is web's `displayName`.

use std::borrow::Cow;

/// Which icon a Conn tool row draws. Clients map these to their own assets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnToolIcon {
    /// The Conn brand mark.
    ConnMark,
    /// Preview browser and annotations.
    Browser,
    /// Simulators and emulators.
    Device,
    /// Pull requests and CI.
    PullRequest,
    /// Saved logins.
    Credential,
}

/// A recognised Conn tool call: the label to show instead of the raw tool name, and its icon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnToolPresentation {
    pub display_name: Cow<'static, str>,
    pub icon: ConnToolIcon,
}

use ConnToolIcon::{Browser, ConnMark, Credential, Device, PullRequest};

/// `(canonical tool name, icon, display name)`. Names carry the `conn_` prefix, never `t3_`.
const TOOLS: &[(&str, ConnToolIcon, &str)] = &[
    ("link_pull_request", PullRequest, "Link a pull request"),
    ("link_pull_requests", PullRequest, "Link pull requests"),
    ("unlink_pull_request", PullRequest, "Unlink a pull request"),
    (
        "unlink_pull_requests",
        PullRequest,
        "Unlink pull requests by state",
    ),
    (
        "list_thread_pull_requests",
        PullRequest,
        "Check linked pull requests",
    ),
    ("watch_pull_request", PullRequest, "Watch a pull request"),
    (
        "unwatch_pull_request",
        PullRequest,
        "Stop watching a pull request",
    ),
    (
        "write_pull_request_guides",
        PullRequest,
        "Write review guides",
    ),
    (
        "read_pull_request_guide",
        PullRequest,
        "Read a review guide",
    ),
    ("list_issues", ConnMark, "List issues"),
    ("read_issue", ConnMark, "Read an issue"),
    ("create_issue", ConnMark, "File an issue"),
    ("comment_on_issue", ConnMark, "Comment on an issue"),
    ("set_issue_state", ConnMark, "Change an issue's state"),
    ("link_issue", ConnMark, "Link an issue"),
    ("unlink_issue", ConnMark, "Unlink an issue"),
    ("list_thread_issues", ConnMark, "Check linked issues"),
    ("pull_request_read", PullRequest, "Read a pull request"),
    ("pull_request_list", PullRequest, "List pull requests"),
    ("pull_request_create", PullRequest, "Open a pull request"),
    ("pull_request_update", PullRequest, "Update a pull request"),
    (
        "pull_request_respond",
        PullRequest,
        "Respond on a pull request",
    ),
    ("pull_request_review", PullRequest, "Review a pull request"),
    ("ci_logs", PullRequest, "Read CI logs"),
    ("ci_rerun", PullRequest, "Re-run CI"),
    ("pull_request_merge", PullRequest, "Merge a pull request"),
    (
        "orchestrator_capabilities",
        ConnMark,
        "Get orchestration capabilities",
    ),
    ("delegate_task", ConnMark, "Delegate a child task"),
    ("task_status", ConnMark, "Get delegated task status"),
    ("task_cancel", ConnMark, "Cancel a delegated task"),
    ("schedule_task", ConnMark, "Schedule a task"),
    ("list_scheduled_tasks", ConnMark, "List scheduled tasks"),
    ("update_scheduled_task", ConnMark, "Update a scheduled task"),
    ("delete_scheduled_task", ConnMark, "Delete a scheduled task"),
    ("request_secret", ConnMark, "Ask for a secret"),
    ("create_threads", ConnMark, "Create Conn threads"),
    ("conn_thread_start", ConnMark, "Start a Conn thread"),
    ("conn_thread_list", ConnMark, "List Conn threads"),
    ("conn_thread_read", ConnMark, "Read a Conn thread"),
    ("conn_thread_send", ConnMark, "Send to a Conn thread"),
    ("conn_thread_wait", ConnMark, "Wait for a Conn thread"),
    ("conn_workflow_stop", ConnMark, "Stop a workflow"),
    ("conn_background_wait", ConnMark, "Update background waits"),
    ("conn_thread_interrupt", ConnMark, "Interrupt a Conn thread"),
    (
        "conn_worktree_handoff",
        ConnMark,
        "Hand off thread to a git worktree",
    ),
    (
        "conn_worktree_status",
        ConnMark,
        "Get thread worktree status",
    ),
    ("preview_status", Browser, "Get preview browser status"),
    (
        "preview_open",
        Browser,
        "Open a page in the preview browser",
    ),
    ("preview_navigate", Browser, "Navigate the preview browser"),
    (
        "preview_dialog",
        Browser,
        "Respond to a preview browser dialog",
    ),
    ("preview_snapshot", Browser, "Snapshot the preview page"),
    ("preview_act", Browser, "Use the preview browser"),
    ("preview_click", Browser, "Click in the preview browser"),
    (
        "preview_press",
        Browser,
        "Press a key in the preview browser",
    ),
    ("preview_type", Browser, "Type in the preview browser"),
    ("preview_hover", Browser, "Hover in the preview browser"),
    (
        "preview_select",
        Browser,
        "Choose an option in the preview browser",
    ),
    ("preview_drag", Browser, "Drag in the preview browser"),
    (
        "preview_upload",
        Browser,
        "Upload files to the preview browser",
    ),
    ("preview_scroll", Browser, "Scroll the preview browser"),
    ("preview_resize", Browser, "Resize the preview browser"),
    (
        "preview_evaluate",
        Browser,
        "Evaluate script in the preview browser",
    ),
    ("preview_wait_for", Browser, "Wait for the preview page"),
    (
        "preview_set_appearance",
        Browser,
        "Set preview browser appearance",
    ),
    (
        "preview_recording_start",
        Browser,
        "Start recording the preview browser",
    ),
    (
        "preview_recording_stop",
        Browser,
        "Stop recording the preview browser",
    ),
    ("device_list", Device, "List simulators and emulators"),
    ("device_open", Device, "Open a device in the Device panel"),
    (
        "device_screenshot",
        Device,
        "Take a screenshot of the device",
    ),
    ("device_close", Device, "Close a device"),
    ("request_credentials", Credential, "Find saved logins"),
    ("fill_credential", Credential, "Fill a saved login"),
    ("save_test_login", Credential, "Save a test login"),
    ("annotations_list", Browser, "List annotations"),
    ("annotations_claim", Browser, "Claim an annotation"),
    ("annotations_complete", Browser, "Complete an annotation"),
    ("annotations_release", Browser, "Release an annotation"),
    ("run_scheduled_task_now", ConnMark, "Run a scheduled task"),
    ("conn_queue", ConnMark, "Manage queued messages"),
    ("conn_pending_request", ConnMark, "Handle pending questions"),
    ("conn_queue_list", ConnMark, "List queued messages"),
    ("conn_queue_read", ConnMark, "Read a queued message"),
    ("conn_queue_edit", ConnMark, "Edit a queued message"),
    ("conn_queue_cancel", ConnMark, "Cancel a queued run"),
    ("conn_queue_reorder", ConnMark, "Reorder a queued run"),
    (
        "conn_queue_promote_to_steer",
        ConnMark,
        "Steer with a queued message",
    ),
    (
        "conn_pending_request_list",
        ConnMark,
        "List pending questions",
    ),
    (
        "conn_pending_request_read",
        ConnMark,
        "Read pending questions",
    ),
    (
        "conn_pending_request_respond",
        ConnMark,
        "Answer pending questions",
    ),
    (
        "conn_thread_configuration",
        ConnMark,
        "Read thread configuration",
    ),
    (
        "conn_thread_configure",
        ConnMark,
        "Use thread model settings",
    ),
    ("conn_thread_transfer", ConnMark, "Use thread transfers"),
    ("conn_thread_fork", ConnMark, "Fork this thread"),
    ("conn_thread_merge_back", ConnMark, "Merge thread context"),
    ("conn_thread_search", ConnMark, "Search thread content"),
    ("conn_thread_transfers", ConnMark, "Read thread transfers"),
    ("conn_thread_organize", ConnMark, "Organize a thread"),
    (
        "conn_thread_update",
        ConnMark,
        "Update Conn thread metadata",
    ),
    ("conn_worktree_list", ConnMark, "List workspace branches"),
    ("conn_preview_list", Browser, "List preview tabs"),
    ("conn_preview_close", Browser, "Close a preview tab"),
    (
        "conn_environment_read",
        ConnMark,
        "Read environment preferences",
    ),
    (
        "conn_environment_links",
        ConnMark,
        "List linked environments",
    ),
    (
        "conn_environment_link",
        ConnMark,
        "Ask to link an environment",
    ),
    (
        "conn_environment_unlink",
        ConnMark,
        "Forget a linked environment",
    ),
    (
        "conn_environment_preferences_update",
        ConnMark,
        "Update environment preferences",
    ),
    ("conn_theme_read", ConnMark, "Read themes"),
    ("conn_theme_set", ConnMark, "Set the theme"),
    ("conn_thread_launch", ConnMark, "Launch a project thread"),
    ("conn_project_list", ConnMark, "List projects"),
    ("conn_project_read", ConnMark, "Read a project"),
    ("conn_project_create", ConnMark, "Register a project"),
    ("conn_project_update", ConnMark, "Update a project"),
    ("conn_project_delete", ConnMark, "Delete a project"),
    ("conn_project_clone", ConnMark, "Clone a repository"),
    (
        "conn_attachment_prepare_upload",
        ConnMark,
        "Prepare an attachment upload",
    ),
    (
        "conn_attachment_discard",
        ConnMark,
        "Discard a pending attachment",
    ),
    ("conn_thread_send_attachments", ConnMark, "Send attachments"),
    ("html_preview", ConnMark, "Preview an HTML page"),
    ("html_render", ConnMark, "Render an HTML page"),
    ("send_to_user", ConnMark, "Send a message"),
    // Not in web's table yet; the server registers them.
    ("database_query", ConnMark, "Query a database"),
    ("mcp_call", ConnMark, "Call an MCP tool"),
    ("mcp_connect", ConnMark, "Connect an MCP server"),
    ("panel_open", ConnMark, "Open a panel"),
    (
        "preview_cdp_endpoint",
        Browser,
        "Get the preview browser debugging endpoint",
    ),
];

/// Servers Conn's agent MCP tools are registered under. `t3-code` is the name before the
/// rename (PR #223); Codex adds `-direct` for tools kept out of Code Mode.
const SERVERS: &[&str] = &[
    "conn",
    "conn-direct",
    "conn_direct",
    "t3-code",
    "t3_code",
    "t3code",
    "t3-code-direct",
    "t3_code_direct",
];

fn is_conn_server(server: &str) -> bool {
    SERVERS.iter().any(|s| s.eq_ignore_ascii_case(server))
}

/// `t3_thread_send` → `conn_thread_send`. Other names are unchanged.
fn canonical(tool: &str) -> Cow<'_, str> {
    match tool.strip_prefix("t3_") {
        Some(rest) => Cow::Owned(format!("conn_{rest}")),
        None => Cow::Borrowed(tool),
    }
}

fn lookup(tool: &str) -> Option<&'static (&'static str, ConnToolIcon, &'static str)> {
    let tool = canonical(tool);
    TOOLS.iter().find(|(name, ..)| *name == tool.as_ref())
}

fn has_prefix(tool: &str, prefix: &str) -> bool {
    tool.len() >= prefix.len()
        && tool.is_char_boundary(prefix.len())
        && tool[..prefix.len()].eq_ignore_ascii_case(prefix)
}

/// A name that looks like a Conn tool even when the table does not list it.
fn looks_like_conn_tool(tool: &str) -> bool {
    lookup(tool).is_some()
        || ["conn_", "t3_", "preview_", "annotations_", "device_"]
            .iter()
            .any(|prefix| has_prefix(tool, prefix))
}

/// Icon for a tool the table does not list, from its name.
fn fallback_icon(tool: &str) -> ConnToolIcon {
    if has_prefix(tool, "preview_")
        || has_prefix(tool, "conn_preview_")
        || has_prefix(tool, "t3_preview_")
        || has_prefix(tool, "annotations_")
    {
        Browser
    } else if has_prefix(tool, "device_") {
        Device
    } else {
        ConnMark
    }
}

/// `conn_brand_new_tool` → `Brand new tool`.
fn fallback_name(tool: &str) -> String {
    let tool = tool
        .strip_prefix("conn_")
        .or_else(|| tool.strip_prefix("t3_"))
        .unwrap_or(tool);
    let mut name = tool.replace('_', " ");
    if let Some(first) = name.get(..1) {
        let upper = first.to_ascii_uppercase();
        name.replace_range(..1, &upper);
    }
    name
}

fn presentation(tool: &str) -> ConnToolPresentation {
    match lookup(tool) {
        Some((_, icon, name)) => ConnToolPresentation {
            display_name: Cow::Borrowed(name),
            icon: *icon,
        },
        None => ConnToolPresentation {
            display_name: Cow::Owned(fallback_name(tool)),
            icon: fallback_icon(tool),
        },
    }
}

/// Resolves a tool row title to Conn's label and icon, in any spelling providers use. `None` when
/// the title is not a Conn tool, so other tools keep their own title and icon.
///
/// A tool on a Conn server that the table does not list still resolves, with a label made from its
/// name. A bare or namespaced name resolves only when it looks like a Conn tool.
#[must_use]
pub fn conn_tool_presentation(title: &str) -> Option<ConnToolPresentation> {
    let label = title.trim();
    let label = label
        .strip_suffix("completed")
        .or_else(|| label.strip_suffix("complete"))
        .filter(|rest| rest.ends_with(char::is_whitespace))
        .map_or(label, str::trim_end);

    if has_prefix(label, "mcp__") {
        let (server, tool) = label[5..].split_once("__")?;
        return (is_conn_server(server) && !tool.is_empty()).then(|| presentation(tool));
    }

    for separator in [".", ":", "/", "·"] {
        if let Some((server, tool)) = label.split_once(separator) {
            let (server, tool) = (server.trim(), tool.trim());
            if is_conn_server(server) && looks_like_conn_tool(tool) {
                return Some(presentation(tool));
            }
        }
    }

    // OpenCode prefixes the tool with its server and thread: `conn-<thread>_<tool>`.
    if has_prefix(label, "conn-") || has_prefix(label, "t3-code-") {
        return label
            .match_indices('_')
            .map(|(index, _)| &label[index + 1..])
            .find(|tool| looks_like_conn_tool(tool))
            .map(presentation);
    }

    looks_like_conn_tool(label).then(|| presentation(label))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolved(title: &str) -> (String, ConnToolIcon) {
        let found = conn_tool_presentation(title)
            .unwrap_or_else(|| panic!("{title:?} should be a Conn tool"));
        (found.display_name.into_owned(), found.icon)
    }

    #[test]
    fn table_names_are_unique_and_canonical() {
        for (index, (name, ..)) in TOOLS.iter().enumerate() {
            assert!(!name.starts_with("t3_"), "{name} must use the conn_ prefix");
            assert!(
                TOOLS[..index].iter().all(|(other, ..)| other != name),
                "{name} is listed twice"
            );
        }
    }

    #[test]
    fn every_tool_resolves_in_every_spelling() {
        for (name, icon, display) in TOOLS {
            let legacy = name.strip_prefix("conn_").map(|rest| format!("t3_{rest}"));
            let mut titles = vec![
                format!("mcp__conn__{name}"),
                format!("Mcp__conn__{name}"),
                format!("MCP__CONN__{name}"),
                format!("mcp__conn-direct__{name}"),
                format!("mcp__t3-code__{name}"),
                format!("conn.{name}"),
                format!("conn:{name}"),
                format!("conn/{name}"),
                format!("conn · {name}"),
                format!("conn-direct.{name}"),
                format!("t3-code.{name}"),
                format!("conn-my_thread_{name}"),
                format!("t3-code-abc_{name}"),
                format!("mcp__conn__{name} completed"),
                format!("mcp__conn__{name} complete"),
                (*name).to_owned(),
            ];
            if let Some(legacy) = legacy {
                titles.push(format!("mcp__t3-code__{legacy}"));
                titles.push(format!("mcp__conn__{legacy}"));
                titles.push(format!("t3-code.{legacy}"));
                titles.push(legacy);
            }
            for title in titles {
                assert_eq!(
                    resolved(&title),
                    ((*display).to_owned(), *icon),
                    "title {title:?}"
                );
            }
        }
    }

    #[test]
    fn server_registered_tools_all_have_a_listed_label() {
        // The tool names the Conn MCP server registers today.
        let names = [
            "annotations_claim",
            "annotations_complete",
            "annotations_list",
            "annotations_release",
            "ci_logs",
            "ci_rerun",
            "comment_on_issue",
            "conn_attachment_discard",
            "conn_attachment_prepare_upload",
            "conn_background_wait",
            "conn_environment_link",
            "conn_environment_links",
            "conn_environment_preferences_update",
            "conn_environment_read",
            "conn_environment_unlink",
            "conn_pending_request",
            "conn_preview_close",
            "conn_preview_list",
            "conn_project_clone",
            "conn_project_create",
            "conn_project_delete",
            "conn_project_list",
            "conn_project_read",
            "conn_project_update",
            "conn_queue",
            "conn_theme_read",
            "conn_theme_set",
            "conn_thread_configure",
            "conn_thread_interrupt",
            "conn_thread_launch",
            "conn_thread_list",
            "conn_thread_organize",
            "conn_thread_read",
            "conn_thread_search",
            "conn_thread_send",
            "conn_thread_send_attachments",
            "conn_thread_transfer",
            "conn_thread_update",
            "conn_thread_wait",
            "conn_workflow_stop",
            "conn_worktree_handoff",
            "conn_worktree_list",
            "conn_worktree_status",
            "create_issue",
            "create_threads",
            "database_query",
            "delegate_task",
            "delete_scheduled_task",
            "device_close",
            "device_list",
            "device_open",
            "device_screenshot",
            "fill_credential",
            "html_preview",
            "html_render",
            "link_issue",
            "link_pull_request",
            "link_pull_requests",
            "list_issues",
            "list_scheduled_tasks",
            "list_thread_issues",
            "list_thread_pull_requests",
            "mcp_call",
            "mcp_connect",
            "orchestrator_capabilities",
            "panel_open",
            "preview_act",
            "preview_cdp_endpoint",
            "preview_dialog",
            "preview_evaluate",
            "preview_navigate",
            "preview_open",
            "preview_recording_start",
            "preview_recording_stop",
            "preview_resize",
            "preview_set_appearance",
            "preview_snapshot",
            "preview_status",
            "preview_wait_for",
            "pull_request_create",
            "pull_request_list",
            "pull_request_merge",
            "pull_request_read",
            "pull_request_respond",
            "pull_request_review",
            "pull_request_update",
            "read_issue",
            "read_pull_request_guide",
            "request_credentials",
            "request_secret",
            "run_scheduled_task_now",
            "save_test_login",
            "schedule_task",
            "send_to_user",
            "set_issue_state",
            "task_cancel",
            "task_status",
            "unlink_issue",
            "unlink_pull_request",
            "unlink_pull_requests",
            "unwatch_pull_request",
            "watch_pull_request",
            "write_pull_request_guides",
        ];
        for name in names {
            assert!(lookup(name).is_some(), "{name} has no table entry");
        }
    }

    #[test]
    fn labels_and_icons_match_web() {
        let cases: &[(&str, &str, ConnToolIcon)] = &[
            // The screenshot: Claude's spelling, capitalised by the title formatter.
            (
                "Mcp__conn__conn_thread_send",
                "Send to a Conn thread",
                ConnMark,
            ),
            (
                "mcp__conn__conn_thread_launch",
                "Launch a project thread",
                ConnMark,
            ),
            ("mcp__conn__conn_queue", "Manage queued messages", ConnMark),
            (
                "mcp__conn__delegate_task",
                "Delegate a child task",
                ConnMark,
            ),
            ("mcp__conn__create_threads", "Create Conn threads", ConnMark),
            (
                "mcp__conn__pull_request_create",
                "Open a pull request",
                PullRequest,
            ),
            ("mcp__conn__ci_rerun", "Re-run CI", PullRequest),
            (
                "mcp__conn__preview_snapshot",
                "Snapshot the preview page",
                Browser,
            ),
            (
                "mcp__conn__annotations_claim",
                "Claim an annotation",
                Browser,
            ),
            (
                "mcp__conn__device_open",
                "Open a device in the Device panel",
                Device,
            ),
            (
                "mcp__conn__fill_credential",
                "Fill a saved login",
                Credential,
            ),
            // Before the rename.
            (
                "mcp__t3-code__t3_thread_send",
                "Send to a Conn thread",
                ConnMark,
            ),
            (
                "mcp__t3-code__t3_preview_list",
                "List preview tabs",
                Browser,
            ),
            ("t3_thread_list", "List Conn threads", ConnMark),
            // Other providers.
            ("conn.conn_thread_read", "Read a Conn thread", ConnMark),
            (
                "conn-direct.pull_request_merge",
                "Merge a pull request",
                PullRequest,
            ),
            (
                "t3-code:device_list",
                "List simulators and emulators",
                Device,
            ),
            ("t3-code · t3_thread_list", "List Conn threads", ConnMark),
            ("conn_thread_send", "Send to a Conn thread", ConnMark),
            ("pull_request_read", "Read a pull request", PullRequest),
        ];
        for (title, display, icon) in cases {
            assert_eq!(resolved(title), ((*display).to_owned(), *icon), "{title:?}");
        }
    }

    #[test]
    fn unknown_tool_on_a_conn_server_gets_a_made_up_label_and_a_guessed_icon() {
        assert_eq!(
            resolved("mcp__conn__conn_brand_new_tool"),
            ("Brand new tool".to_owned(), ConnMark)
        );
        assert_eq!(
            resolved("mcp__t3-code__t3_shiny_thing"),
            ("Shiny thing".to_owned(), ConnMark)
        );
        assert_eq!(
            resolved("mcp__conn__preview_new_thing"),
            ("Preview new thing".to_owned(), Browser)
        );
        assert_eq!(
            resolved("mcp__conn__device_new_thing"),
            ("Device new thing".to_owned(), Device)
        );
        assert_eq!(
            resolved("conn_brand_new_tool"),
            ("Brand new tool".to_owned(), ConnMark)
        );
    }

    #[test]
    fn other_tools_are_not_conn_tools() {
        for title in [
            "mcp__github__create_issue",
            "mcp__other__t3_thread_send",
            "mcp__conn__",
            "mcp__conn",
            "other.conn_thread_send",
            "conn: connecting to host",
            "conn.local",
            "Tool call",
            "Read src/main.rs",
            "ls -la",
            "link_something",
            "",
        ] {
            assert_eq!(conn_tool_presentation(title), None, "{title:?}");
        }
    }

    #[test]
    fn non_ascii_titles_do_not_panic() {
        for title in ["mcp_é_x", "é", "conn-é_x", "mcp__é__é", "日本語"] {
            let _ = conn_tool_presentation(title);
        }
    }
}
