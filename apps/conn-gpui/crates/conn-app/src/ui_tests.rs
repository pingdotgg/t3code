//! Headless GPUI render and pointer/keyboard interaction tests (`#[gpui_kit::test]`).
//!
//! Runs inside `scripts/check.sh` (`cargo test --workspace`) with debug assertions on and zero
//! window-focus stealing, catching duplicate `.hover()` styles, duplicate AccessKit node IDs,
//! broken submenu hover paths, overlay/focus regressions, and GPUI-executor Tokio panics before
//! anything reaches live testing.

use std::time::Duration;

use conn_client::{ClientEvent, Connection, ConnectionStatus, Credential, ServerConfig};
use conn_contract::from_json;
use conn_state::{
    ItemStatus, ProjectShell, SecretRequestStatus, ShellState, ThreadShell, ThreadState,
    TimelineEntry, TurnCheckpointFile, TurnCheckpointSummary, TurnItemStatus, UserInputOption,
    UserInputQuestion,
};
use conn_theme::Tokens;
use futures::{SinkExt as _, StreamExt as _};
use gpui_kit::test::{TestEventExt as _, TestQueryExt as _, TestWindowExt as _};
use gpui_kit::{
    AnyWindowHandle, AppContext as _, Bounds, Entity, MouseButton, Pixels, Point, TestAppContext,
    Window, WindowBounds, WindowOptions, px, size,
};
use serde_json::json;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use crate::app::{ConnApp, register_keybindings};
use crate::live::RT;
use crate::theme::apply_kit_theme;

const TEST_WINDOW_WIDTH: f32 = 1440.0;
const TEST_WINDOW_HEIGHT: f32 = 900.0;

/// Mounts a full `ConnApp` window in `TestAppContext` (`1440×900`, Dark Ocean) with keybindings,
/// theme tokens, and assets initialized.
fn mount_app(cx: &mut TestAppContext) -> (AnyWindowHandle, Entity<ConnApp>) {
    mount_app_with_server(cx, None)
}

/// [`mount_app`] that connects at launch to `server`, as the live app does to a saved server.
fn mount_app_with_server(
    cx: &mut TestAppContext,
    server: Option<crate::live::StartupServer>,
) -> (AnyWindowHandle, Entity<ConnApp>) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        let Some(theme) = conn_theme::theme_by_id("dark-ocean") else {
            panic!("dark-ocean must be a built-in theme");
        };
        let tokens = Tokens::derive(&theme);
        apply_kit_theme(&tokens, cx);
        register_keybindings(cx);

        let bounds = Bounds::new(
            Point::default(),
            size(px(TEST_WINDOW_WIDTH), px(TEST_WINDOW_HEIGHT)),
        );
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            ..Default::default()
        };
        let Ok(opened) = gpui_kit::open_window(options, cx, move |window, cx| {
            window.activate_window();
            cx.new(|cx| ConnApp::new(theme.id, tokens, server, window, cx))
        }) else {
            panic!("failed to open headless test window");
        };
        opened
    })
}

fn center_by_label(window: &mut Window, cx: &mut gpui_kit::App, label: &str) -> Point<Pixels> {
    window.render_frame(cx);
    let snap = window.find_by_label(label);
    snap.bounds().center()
}

fn center_by_label_contains(
    window: &mut Window,
    cx: &mut gpui_kit::App,
    needle: &str,
) -> Point<Pixels> {
    window.render_frame(cx);
    let elements = window.elements();
    let lower = needle.to_ascii_lowercase();
    if let Some(el) = elements.iter().find(|e| {
        e.label()
            .is_some_and(|l| l.to_ascii_lowercase().contains(&lower))
    }) {
        return el.bounds().center();
    }
    let labels: Vec<&str> = elements.iter().filter_map(|e| e.label()).collect();
    panic!("no observed element containing `{needle}` (observed labels: {labels:?})");
}

fn has_label(window: &mut Window, cx: &mut gpui_kit::App, label: &str) -> bool {
    window.render_frame(cx);
    window.try_find_by_label(label).is_some()
}

struct ThreadSeedSpec<'a> {
    id: &'a str,
    project_id: &'a str,
    title: &'a str,
    status: &'a str,
    activity_run_status: Option<&'a str>,
    pinned_at: Option<&'a str>,
    settled_at: Option<&'a str>,
    pending_kind: Option<&'a str>,
}

fn make_thread_shell(spec: ThreadSeedSpec<'_>) -> ThreadShell {
    let pending = spec.pending_kind.map(|kind| {
        json!({
            "id": format!("req-{}", spec.id),
            "kind": kind,
            "createdAt": "2026-11-22T15:00:00.000Z",
            "blocking": true,
        })
    });
    let val = json!({
        "createdBy": "user",
        "creationSource": "web",
        "id": spec.id,
        "projectId": spec.project_id,
        "title": spec.title,
        "providerInstanceId": "claude-default",
        "modelSelection": {
            "provider": "claude",
            "model": "claude-sonnet-4-6"
        },
        "runtimeMode": "auto-accept-edits",
        "interactionMode": "default",
        "branch": "feat/parity-check",
        "worktreePath": null,
        "lineage": {
            "parentThreadId": null,
            "relationshipToParent": null,
            "rootThreadId": spec.id
        },
        "forkedFrom": null,
        "activeProviderThreadId": null,
        "latestRunId": "run-1",
        "activeRunId": spec.activity_run_status.map(|_| "run-1"),
        "activityRunStatus": spec.activity_run_status,
        "status": spec.status,
        "pendingRuntimeRequest": pending,
        "latestVisibleMessage": null,
        "latestUserMessageAt": "2026-11-22T15:00:00.000Z",
        "hasActionableProposedPlan": false,
        "itemCount": 6,
        "visibleItemCount": 4,
        "pinnedAt": spec.pinned_at,
        "pinOrderKey": spec.pinned_at.map(|_| "a0"),
        "settledOverride": null,
        "settledAt": spec.settled_at,
        "archivedAt": null,
        "lastVisitedAt": "2026-11-22T14:00:00.000Z",
        "createdAt": "2026-11-22T12:00:00.000Z",
        "updatedAt": "2026-11-22T15:10:00.000Z",
        "latestRun": {
            "id": "run-1",
            "status": spec.status,
            "startedAt": "2026-11-22T15:00:00.000Z",
            "completedAt": if spec.activity_run_status.is_none() { Some("2026-11-22T15:05:00.000Z") } else { None },
            "error": if spec.status == "failed" { Some("Simulated failure") } else { None },
            "mode": "default"
        }
    });
    match from_json::<ThreadShell>(val) {
        Ok(thread) => thread,
        Err(err) => panic!("kitchen-sink ThreadShell JSON failed to decode: {err}"),
    }
}

fn kitchen_sink_shell() -> ShellState {
    let project_val = json!({
        "id": "proj-parity",
        "title": "conn-gpui",
        "workspaceRoot": "/tmp/conn-gpui-parity",
        "defaultModelSelection": null,
        "scripts": [],
        "createdAt": "2026-11-20T09:00:00.000Z",
        "updatedAt": "2026-11-22T15:00:00.000Z",
    });
    let project: ProjectShell = match from_json(project_val) {
        Ok(project) => project,
        Err(err) => panic!("kitchen-sink ProjectShell failed: {err}"),
    };

    let threads = vec![
        make_thread_shell(ThreadSeedSpec {
            id: "thread-pinned",
            project_id: "proj-parity",
            title: "Pinned active thread",
            status: "completed",
            activity_run_status: None,
            pinned_at: Some("2026-11-22T12:00:00.000Z"),
            settled_at: None,
            pending_kind: None,
        }),
        make_thread_shell(ThreadSeedSpec {
            id: "thread-selected",
            project_id: "proj-parity",
            title: "Selected kitchen-sink thread",
            status: "completed",
            activity_run_status: None,
            pinned_at: None,
            settled_at: None,
            pending_kind: None,
        }),
        // Unselected Working thread — previously panicked with debug_assert!("hover style already set")!
        make_thread_shell(ThreadSeedSpec {
            id: "thread-working-bg",
            project_id: "proj-parity",
            title: "Unselected background working thread",
            status: "running",
            activity_run_status: Some("running"),
            pinned_at: None,
            settled_at: None,
            pending_kind: None,
        }),
        make_thread_shell(ThreadSeedSpec {
            id: "thread-waiting",
            project_id: "proj-parity",
            title: "Thread awaiting approval",
            status: "waiting",
            activity_run_status: Some("waiting"),
            pinned_at: None,
            settled_at: None,
            pending_kind: Some("permission"),
        }),
        make_thread_shell(ThreadSeedSpec {
            id: "thread-failed",
            project_id: "proj-parity",
            title: "Failed thread card",
            status: "failed",
            activity_run_status: None,
            pinned_at: None,
            settled_at: None,
            pending_kind: None,
        }),
        make_thread_shell(ThreadSeedSpec {
            id: "thread-settled-1",
            project_id: "proj-parity",
            title: "Settled thread row",
            status: "completed",
            activity_run_status: None,
            pinned_at: None,
            settled_at: Some("2026-11-22T11:00:00.000Z"),
            pending_kind: None,
        }),
    ];

    ShellState::from_parts(vec![project], threads, Vec::new(), Some(100))
}

fn kitchen_sink_thread() -> ThreadState {
    let mut thread = ThreadState::new("thread-selected");
    thread.synchronized = true;
    thread.entries = vec![
        TimelineEntry::User {
            id: "u-1".to_owned(),
            text: "Build a kitchen-sink parity view.".to_owned(),
            created_by_agent: false,
            created_at: Some("2026-11-22T15:00:00.000Z".to_owned()),
            attachments: Vec::new(),
            is_steer: false,
            run_id: Some("run-1".to_owned()),
        },
        TimelineEntry::User {
            id: "u-2".to_owned(),
            text: "Also verify consecutive user bubble grouping and steer markers.".to_owned(),
            created_by_agent: false,
            created_at: Some("2026-11-22T15:00:10.000Z".to_owned()),
            attachments: Vec::new(),
            is_steer: true,
            run_id: Some("run-1".to_owned()),
        },
        TimelineEntry::Thinking {
            id: "think-1".to_owned(),
            text: "Inspecting the sidebar and timeline layout before editing.".to_owned(),
            streaming: false,
        },
        TimelineEntry::Tool {
            id: "tool-1".to_owned(),
            kind: "command".to_owned(),
            title: "cargo test --workspace".to_owned(),
            detail: Some("test result: ok. 42 passed".to_owned()),
            status: ItemStatus::Completed,
            output_omitted: false,
        },
        // Intentional duplicate underlying entry ID to verify virtual row ID scoping never
        // collides in AccessKit's `A11yNodeBuilder::push`.
        TimelineEntry::Assistant {
            id: "dup-id".to_owned(),
            markdown: "## Summary\n\nHere is `inline code`, **bold**, and a code block:\n\n```rust\nfn main() { println!(\"ok\"); }\n```\n\n| Col A | Col B |\n| --- | --- |\n| 1 | 2 |\n".to_owned(),
            streaming: false,
            created_at: Some("2026-11-22T15:01:00.000Z".to_owned()),
            run_id: Some("run-1".to_owned()),
            status: ItemStatus::Completed,
        },
        TimelineEntry::Notice {
            id: "dup-id".to_owned(),
            text: "Secondary notice reusing an ID".to_owned(),
            is_error: false,
        },
        TimelineEntry::ProposedPlan {
            id: "plan-1".to_owned(),
            run_id: Some("run-1".to_owned()),
            title: "Parity verification plan".to_owned(),
            markdown: "# Parity verification plan\n\n- Layer 1 headless GPUI tests\n- Layer 2 E2E\n- Layer 3 VMPal side-by-side\n".to_owned(),
            streaming: false,
            status: ItemStatus::Completed,
            created_at: Some("2026-11-22T15:02:00.000Z".to_owned()),
        },
        TimelineEntry::UserInputRequest {
            id: "input-1".to_owned(),
            request_id: "req-input-1".to_owned(),
            title: Some("Choose verification mode".to_owned()),
            questions: vec![UserInputQuestion {
                id: "q1".to_owned(),
                header: "Mode".to_owned(),
                question: "Which verification target?".to_owned(),
                options: vec![
                    UserInputOption {
                        value: Some("vmpal".to_owned()),
                        label: "VMPal".to_owned(),
                        description: "Run inside nick-vm".to_owned(),
                        preview: Some("Slow, but the pixels are real.".to_owned()),
                    },
                    UserInputOption {
                        value: Some("headless".to_owned()),
                        label: "Headless".to_owned(),
                        description: "Fast local GPUI test".to_owned(),
                        preview: None,
                    },
                ],
                multi_select: false,
                allow_custom_answer: true,
                initial_answer: None,
            }],
            status: TurnItemStatus::Pending,
            pending: true,
            answers: Vec::new(),
            dismissible: true,
            created_at: Some("2026-11-22T15:03:00.000Z".to_owned()),
        },
        TimelineEntry::SecretRequest {
            id: "secret-1".to_owned(),
            label: "API Token".to_owned(),
            reason: "Needed for staging verification".to_owned(),
            url: None,
            placeholder: Some("sk-...".to_owned()),
            file_delivery: false,
            status: SecretRequestStatus::Pending,
            pending: true,
            created_at: Some("2026-11-22T15:03:30.000Z".to_owned()),
        },
        TimelineEntry::Subagent {
            id: "sub-1".to_owned(),
            child_thread_id: Some("thread-working-bg".to_owned()),
            title: "Inspect sidebar card hover styles".to_owned(),
            role: "claudeAgent".to_owned(),
            status: TurnItemStatus::Completed,
            summary: Some("Verified receded card hover branch".to_owned()),
            remote_child: None,
            created_at: Some("2026-11-22T15:04:00.000Z".to_owned()),
            started_at: Some("2026-11-22T15:04:00.000Z".to_owned()),
            completed_at: Some("2026-11-22T15:04:20.000Z".to_owned()),
        },
        TimelineEntry::QueuedUser {
            id: "q-1".to_owned(),
            run_id: "run-q-1".to_owned(),
            message_id: "msg-q-1".to_owned(),
            text: "Queued follow-up message".to_owned(),
            attachments: Vec::new(),
            created_at: "2026-11-22T15:05:00.000Z".to_owned(),
            created_by_agent: false,
        },
    ];
    thread.turn_checkpoints.insert(
        "run-1".to_owned(),
        TurnCheckpointSummary {
            run_id: "run-1".to_owned(),
            app_run_ordinal: Some(1),
            file_count: 2,
            additions: 14,
            deletions: 3,
            files: vec![
                TurnCheckpointFile {
                    path: "crates/conn-app/src/sidebar/thread_list.rs".to_owned(),
                    kind: "modified".to_owned(),
                    additions: 10,
                    deletions: 2,
                },
                TurnCheckpointFile {
                    path: "crates/conn-app/src/chat/mod.rs".to_owned(),
                    kind: "modified".to_owned(),
                    additions: 4,
                    deletions: 1,
                },
            ],
        },
    );
    thread
}

#[gpui_kit::test]
fn kitchen_sink_shell_renders_all_sidebar_and_timeline_states_without_panic(
    cx: &mut TestAppContext,
) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
        });
    });

    // Render in Dark Ocean and verify observed elements across sidebar, header, and composer.
    let dark_ok = match cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        let labels: Vec<String> = window
            .elements()
            .into_iter()
            .filter_map(|e| e.label().map(str::to_owned))
            .collect();
        assert!(
            labels.iter().any(|l| l == "Selected kitchen-sink thread"),
            "expected selected thread card in observed elements; got {labels:?}"
        );
        assert!(
            labels
                .iter()
                .any(|l| l == "Unselected background working thread"),
            "expected unselected background working thread card in observed elements"
        );
        assert!(
            labels.iter().any(|l| l == "Toggle thread details panel"),
            "expected header thread details toggle in observed elements"
        );
        labels.len()
    }) {
        Ok(count) => count,
        Err(err) => panic!("failed to render dark-ocean frame: {err}"),
    };
    assert!(dark_ok > 0, "expected observed elements in dark-ocean");

    // Switch to T3 Code Light and re-render the full kitchen-sink shell.
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            let ok = app.set_theme("t3-code-light", cx);
            assert!(ok, "t3-code-light must be a built-in theme");
        });
    });
    let light_count = match cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.elements().len()
    }) {
        Ok(count) => count,
        Err(err) => panic!("failed to render t3-code-light frame: {err}"),
    };
    assert!(
        light_count > 0,
        "expected observed elements after light theme switch"
    );
}

#[gpui_kit::test]
fn thread_context_menu_copy_submenu_stays_open_on_hover_and_copies_path(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
        });
    });

    // 1. Right-click a sidebar thread card to open the Thread Actions context menu.
    let row_pt = match cx.update_window(window, |_, window, cx| {
        center_by_label(window, cx, "Selected kitchen-sink thread")
    }) {
        Ok(pt) => pt,
        Err(err) => panic!("failed to locate sidebar thread row: {err}"),
    };
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_move(row_pt, None, cx);
        window.pointer_down(row_pt, MouseButton::Right, cx);
        window.pointer_up(row_pt, MouseButton::Right, cx);
        window.render_frame(cx);
    });
    assert!(
        cx.read(|cx| app.read(cx).thread_menu_open_for_test()),
        "right-clicking a sidebar thread row must open the Thread Actions menu"
    );

    // 2. Hover the `Copy` row to open the submenu.
    let copy_pt =
        match cx.update_window(window, |_, window, cx| center_by_label(window, cx, "Copy")) {
            Ok(pt) => pt,
            Err(err) => panic!("failed to locate Copy menu row: {err}"),
        };
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_move(copy_pt, None, cx);
        window.render_frame(cx);
    });
    assert!(
        cx.read(|cx| app.read(cx).thread_menu_copy_open_for_test()),
        "hovering Copy must open the Copy submenu"
    );

    // 3. Move pointer onto `Path` inside the submenu — submenu MUST stay open!
    let path_pt =
        match cx.update_window(window, |_, window, cx| center_by_label(window, cx, "Path")) {
            Ok(pt) => pt,
            Err(err) => panic!("failed to locate Copy -> Path submenu row: {err}"),
        };
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_move(path_pt, None, cx);
        window.render_frame(cx);
    });
    assert!(
        cx.read(|cx| app.read(cx).thread_menu_copy_open_for_test()),
        "hovering Path inside Copy submenu must keep the submenu open"
    );

    // 4. Click `Path` and assert the menu closes and copies the workspace path.
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_down(path_pt, MouseButton::Left, cx);
        window.pointer_up(path_pt, MouseButton::Left, cx);
        window.render_frame(cx);
    });
    assert!(
        !cx.read(|cx| app.read(cx).thread_menu_open_for_test()),
        "clicking Copy -> Path must dismiss the thread context menu"
    );
    let copied = cx.read(|cx| cx.read_from_clipboard().and_then(|item| item.text()));
    assert_eq!(
        copied.as_deref(),
        Some("/tmp/conn-gpui-parity"),
        "Copy -> Path must copy the project workspace root to the clipboard"
    );
}

#[gpui_kit::test]
fn header_details_card_and_overlays_open_render_and_dismiss(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
        });
    });

    // 1. Open and dismiss the Thread Details popover from the 44px header button.
    let details_btn = match cx.update_window(window, |_, window, cx| {
        center_by_label(window, cx, "Toggle thread details panel")
    }) {
        Ok(pt) => pt,
        Err(err) => panic!("failed to locate header.thread-details: {err}"),
    };
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_move(details_btn, None, cx);
        window.pointer_down(details_btn, MouseButton::Left, cx);
        window.pointer_up(details_btn, MouseButton::Left, cx);
        window.render_frame(cx);
        assert!(
            has_label(window, cx, "Thread details"),
            "clicking header.thread-details must render Thread details card"
        );
        window.press("escape", cx);
        window.render_frame(cx);
        assert!(
            !has_label(window, cx, "Thread details"),
            "Escape must dismiss Thread details card"
        );
    });

    // 2. Open Cmd+K Command Palette, switch theme by typing + Enter, and verify dismissal.
    let _ = cx.update_window(window, |_, window, cx| {
        window.press("cmd-k", cx);
        window.render_frame(cx);
        assert!(
            has_label(window, cx, "Command palette"),
            "Cmd+K must open Command palette"
        );
    });
    cx.run_until_parked();
    let _ = cx.update_window(window, |_, window, cx| {
        window.input("T3 Code Light", cx);
        window.render_frame(cx);
    });
    cx.run_until_parked();
    let _ = cx.update_window(window, |_, window, cx| {
        window.press("enter", cx);
    });
    cx.run_until_parked();
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        assert!(
            !has_label(window, cx, "Command palette"),
            "Enter must execute palette action and dismiss Command palette"
        );
    });
    assert_eq!(
        cx.read(|cx| app.read(cx).theme_id_for_test().to_owned()),
        "t3-code-light",
        "Cmd+K theme selection must switch active theme to t3-code-light"
    );

    // 3. Open Cmd+, Settings modal, render, and dismiss with Escape.
    let _ = cx.update_window(window, |_, window, cx| {
        window.press("cmd-,", cx);
        window.render_frame(cx);
        assert!(
            has_label(window, cx, "Settings"),
            "Cmd+, must open Settings modal"
        );
    });
    cx.run_until_parked();
    let _ = cx.update_window(window, |_, window, cx| {
        window.press("escape", cx);
    });
    cx.run_until_parked();
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        assert!(
            !has_label(window, cx, "Settings"),
            "Escape must dismiss Settings modal"
        );
    });
}

#[gpui_kit::test]
fn composer_popups_model_picker_and_plan_mode_render_cleanly(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
        });
    });

    let _ = cx.update_window(window, |_, window, cx| {
        let picker_pt = center_by_label_contains(window, cx, "claude-sonnet-4-6");
        window.pointer_move(picker_pt, None, cx);
        window.pointer_down(picker_pt, MouseButton::Left, cx);
        window.pointer_up(picker_pt, MouseButton::Left, cx);
        window.render_frame(cx);
    });
    cx.run_until_parked();
    let _ = cx.update_window(window, |_, window, cx| {
        window.press("escape", cx);
        window.render_frame(cx);
    });
    cx.run_until_parked();
    let _ = cx.update_window(window, |_, window, cx| {
        // Default mode hides the Build/Plan chip in the footer (Conn `ComposerControlsBar`);
        // entering Plan mode surfaces the active Plan badge, and clicking it exits back to default.
        let chat = app.read(cx).chat_for_test();
        let composer = chat.read(cx).composer_for_test();
        composer.update(cx, |c, cx| c.toggle_interaction_mode(cx));
        window.render_frame(cx);
        let plan_pt = center_by_label_contains(window, cx, "plan mode");
        window.pointer_move(plan_pt, None, cx);
        window.pointer_down(plan_pt, MouseButton::Left, cx);
        window.pointer_up(plan_pt, MouseButton::Left, cx);
        window.render_frame(cx);
        assert!(
            !has_label(
                window,
                cx,
                "Plan mode. Click to return to normal build mode"
            ),
            "clicking active Plan badge must return to default mode and hide the chip"
        );
    });
}

/// The launch connection asks for the provider catalog, or the composer's picker stays empty
/// until the user switches servers.
#[gpui_kit::test]
fn launch_connection_subscribes_to_server_config(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (tags_tx, tags_rx) = std::sync::mpsc::channel::<String>();
    let addr = RT.block_on(async {
        let listener = match TcpListener::bind("127.0.0.1:0").await {
            Ok(l) => l,
            Err(err) => panic!("failed to bind loopback listener: {err}"),
        };
        let addr = match listener.local_addr() {
            Ok(a) => a,
            Err(err) => panic!("failed to read listener addr: {err}"),
        };
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let tags_tx = tags_tx.clone();
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
                        return;
                    };
                    while let Some(Ok(Message::Text(text))) = ws.next().await {
                        for frame in conn_wire::decode_client_message(&text).unwrap_or_default() {
                            if let conn_wire::FromClient::Request(req) = frame {
                                let _ = tags_tx.send(req.tag);
                            }
                        }
                    }
                });
            }
        });
        addr
    });
    let http_base_url = match url::Url::parse(&format!("http://{addr}")) {
        Ok(url) => url,
        Err(err) => panic!("invalid loopback URL: {err}"),
    };
    let (_window, _app) = mount_app_with_server(
        cx,
        Some(crate::live::StartupServer {
            config: ServerConfig {
                http_base_url,
                credential: Credential::Bearer("test-token".to_owned()),
            },
            label: None,
            orbit_server_id: None,
        }),
    );

    let mut tags = Vec::new();
    while let Ok(tag) = tags_rx.recv_timeout(Duration::from_secs(5)) {
        if tag == "subscribeServerConfig" {
            return;
        }
        tags.push(tag);
    }
    panic!("launch connection never sent subscribeServerConfig; it sent {tags:?}");
}

#[gpui_kit::test]
fn composer_attach_file_uploads_via_background_tokio_runtime(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (window, app) = mount_app(cx);

    // Start a loopback mock WS + HTTP attachment server on `live::RT`.
    let addr = RT.block_on(async {
        let listener = match TcpListener::bind("127.0.0.1:0").await {
            Ok(l) => l,
            Err(err) => panic!("failed to bind loopback listener: {err}"),
        };
        let addr = match listener.local_addr() {
            Ok(a) => a,
            Err(err) => panic!("failed to read listener addr: {err}"),
        };
        tokio::spawn(async move {
            while let Ok((mut tcp, _)) = listener.accept().await {
                let mut peek = [0u8; 4096];
                let Ok(n) = tcp.peek(&mut peek).await else {
                    continue;
                };
                let head = String::from_utf8_lossy(&peek[..n]);
                if head.starts_with("POST /api/attachments/upload/") {
                    tokio::spawn(async move {
                        let mut raw = Vec::new();
                        let mut buf = [0u8; 4096];
                        let header_end = loop {
                            let Ok(read) = tcp.read(&mut buf).await else {
                                return;
                            };
                            if read == 0 {
                                return;
                            }
                            raw.extend_from_slice(&buf[..read]);
                            if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                                break pos + 4;
                            }
                        };
                        let headers = String::from_utf8_lossy(&raw[..header_end]).into_owned();
                        let content_len = headers
                            .lines()
                            .find_map(|line| {
                                let (k, v) = line.split_once(':')?;
                                k.eq_ignore_ascii_case("content-length")
                                    .then(|| v.trim().parse::<usize>().ok())
                                    .flatten()
                            })
                            .unwrap_or(0);
                        while raw.len() < header_end + content_len {
                            let Ok(read) = tcp.read(&mut buf).await else {
                                break;
                            };
                            if read == 0 {
                                break;
                            }
                            raw.extend_from_slice(&buf[..read]);
                        }
                        let _ = tcp
                            .write_all(
                                b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
                            )
                            .await;
                    });
                    continue;
                }
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
                        return;
                    };
                    while let Some(Ok(Message::Text(text))) = ws.next().await {
                        let Ok(frames) = conn_wire::decode_client_message(&text) else {
                            continue;
                        };
                        for frame in frames {
                            if let conn_wire::FromClient::Request(req) = frame
                                && req.tag == "attachments.createUploadUrl"
                            {
                                let reply = conn_wire::FromServer::Exit {
                                    request_id: req.id,
                                    exit: conn_wire::Exit::success(json!({
                                        "attachmentId": "att-gpui-test-1",
                                        "relativeUrl": "/api/attachments/upload/tok-gpui",
                                        "expiresAt": 1_900_000_000_000_i64
                                    })),
                                };
                                let _ = ws
                                    .send(Message::Text(
                                        conn_wire::encode_server_frame(&reply).into(),
                                    ))
                                    .await;
                            }
                        }
                    }
                });
            }
        });
        addr
    });

    let base_url = match url::Url::parse(&format!("http://{addr}")) {
        Ok(url) => url,
        Err(err) => panic!("invalid loopback URL: {err}"),
    };
    let (conn, mut events) = Connection::start(
        ServerConfig {
            http_base_url: base_url,
            credential: Credential::Bearer("test-token".to_owned()),
        },
        RT.handle(),
    );

    // Wait for the WebSocket client to reach Connected status.
    RT.block_on(async {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            if let Ok(Some(ClientEvent::Status(ConnectionStatus::Connected))) =
                tokio::time::timeout(Duration::from_secs(1), events.recv()).await
            {
                return;
            }
        }
        panic!("mock connection did not reach Connected status");
    });

    let chat = cx.read(|cx| app.read(cx).chat_for_test());
    let composer = cx.read(|cx| chat.read(cx).composer_for_test());
    cx.update(|cx| {
        chat.update(cx, |chat, cx| chat.set_connection(Some(conn), cx));
    });

    // Write a tiny PNG temp file and attach it from GPUI's main executor (no Tokio runtime entered).
    assert!(
        tokio::runtime::Handle::try_current().is_err(),
        "GPUI test thread must not have an entered Tokio runtime"
    );
    let tmp_png =
        std::env::temp_dir().join(format!("conn-gpui-test-attach-{}.png", std::process::id()));
    let png_bytes = [0x89_u8, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if let Err(err) = std::fs::write(&tmp_png, png_bytes) {
        panic!("failed to write temp PNG: {err}");
    }

    let _ = cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| {
            app.attach_paths_to_composer(vec![tmp_png.clone()], window, cx);
        });
        window.render_frame(cx);
    });

    // Pump GPUI's async task queue until the background Tokio HTTP upload resolves back to Ready.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut ready = false;
    while std::time::Instant::now() < deadline {
        cx.run_until_parked();
        let states = cx.read(|cx| composer.read(cx).attachment_states_for_test());
        if states.iter().any(|(_, st)| st == "ready:att-gpui-test-1") {
            ready = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = std::fs::remove_file(&tmp_png);

    let final_states = cx.read(|cx| composer.read(cx).attachment_states_for_test());
    assert!(
        ready,
        "expected attached PNG to reach ready:att-gpui-test-1 on GPUI executor, got {final_states:?}"
    );
}

#[gpui_kit::test]
fn composer_keeps_bottom_breathing_room_and_context_strip_layout(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
        });
    });

    // 1. Active thread with default `persistComposerContextStrip = false`: the composer card must
    // sit above the 16px bottom spacer (the sidebar's last line bottom) + ~4.5px shell
    // inset/border (never slammed flush against the bottom of the window).
    const SHELL_BOTTOM_CHROME_PX: f32 = 4.5;
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        let card = window.find_by_label("Message input card");
        let bottom_gap = TEST_WINDOW_HEIGHT - f32::from(card.bounds().bottom());
        assert!(
            (19.5..=22.0).contains(&bottom_gap),
            "composer card must keep 16px bottom breathing room + ~4.5px shell inset (got {bottom_gap:.1}px)"
        );
        assert!(
            window.try_find_by_label("Thread context").is_none(),
            "context strip stays hidden on active threads while persist_composer_context_strip is false"
        );
    });

    // 2. Enabling `persist_composer_context_strip` renders the branch/worktree row below the
    // composer card with symmetric 9px margins above and below (not stacked on top of the 20px
    // no-strip spacer).
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_persist_composer_context_strip(true, cx);
        });
    });
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        let card = window.find_by_label("Message input card");
        let strip = window.find_by_label("Thread context");
        let top_gap = f32::from(strip.bounds().top()) - f32::from(card.bounds().bottom());
        let bottom_gap =
            (TEST_WINDOW_HEIGHT - SHELL_BOTTOM_CHROME_PX) - f32::from(strip.bounds().bottom());
        assert!(
            (8.0..=10.5).contains(&top_gap),
            "context strip top margin should be ~9px (got {top_gap:.1}px)"
        );
        assert!(
            (8.0..=10.5).contains(&bottom_gap),
            "context strip bottom margin should be ~9px without excessive padding (got {bottom_gap:.1}px)"
        );
        assert!(
            (top_gap - bottom_gap).abs() <= 1.5,
            "context strip vertical margins must be symmetric (top {top_gap:.1}px vs bottom {bottom_gap:.1}px)"
        );
    });

    // 3. A new-thread draft always renders the context strip with the same 9px top margin, and the
    // composer sits vertically centered in the chat card (`isDraftHeroState`).
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_persist_composer_context_strip(false, cx);
            app.start_new_thread(None, None, cx);
        });
    });
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        let hero = window.find_by_label("New thread");
        let card = window.find_by_label("Message input card");
        let strip = window.find_by_label("Thread context");
        let top_gap = f32::from(strip.bounds().top()) - f32::from(card.bounds().bottom());
        assert!(
            (8.0..=10.5).contains(&top_gap),
            "draft context strip top margin should be ~9px (got {top_gap:.1}px)"
        );
        let above = f32::from(card.bounds().top()) - f32::from(hero.bounds().top());
        let below = f32::from(hero.bounds().bottom()) - (f32::from(strip.bounds().bottom()) + 9.0);
        assert!(
            (above - below).abs() <= 2.0,
            "draft composer must be vertically centered (above {above:.1}px vs below {below:.1}px)"
        );
    });
}

#[gpui_kit::test]
fn sidebar_status_dot_renders_10px_cutout_around_6px_dot(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            // Select a working thread so we assert both selected and unselected rows with dots.
            app.set_thread_for_test("thread-working-bg".to_owned(), kitchen_sink_thread(), cx);
        });
    });

    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        for thread_id in ["thread-working-bg", "thread-waiting", "thread-failed"] {
            let favicon = window
                .find_by_label(&format!("Thread favicon: {thread_id}"))
                .bounds();
            let cutout = window
                .find_by_label(&format!("Status cutout: {thread_id}"))
                .bounds();
            let width = f32::from(cutout.size.width);
            let height = f32::from(cutout.size.height);
            assert!(
                (width - 10.0).abs() <= 0.5 && (height - 10.0).abs() <= 0.5,
                "{thread_id} status cutout must be 10x10 (6px dot + 2px ring on each side), got {width:.1}x{height:.1}"
            );
            let center_x = f32::from(cutout.center().x);
            let center_y = f32::from(cutout.center().y);
            let expected_x = f32::from(favicon.right());
            let expected_y = f32::from(favicon.top());
            assert!(
                (center_x - expected_x).abs() <= 0.75 && (center_y - expected_y).abs() <= 0.75,
                "{thread_id} cutout center must sit on the icon corner (half-width/half-height) = ({expected_x:.1}, {expected_y:.1}), got ({center_x:.1}, {center_y:.1})"
            );
        }
    });
}

#[gpui_kit::test]
fn thread_hover_card_opens_for_the_hovered_row_and_closes_for_menus(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
        });
    });
    let card = "Thread preview: Pinned active thread";
    assert!(
        !cx.update_window(window, |_, w, cx| has_label(w, cx, card))
            .unwrap_or(true)
    );

    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.open_thread_hover_for_test("thread-pinned", cx)
        });
    });
    assert_eq!(
        cx.read(|cx| app.read(cx).thread_hover.open_for().map(str::to_owned)),
        Some("thread-pinned".to_owned())
    );
    // The first frame measures the row; the card shows once that frame has re-rendered.
    for _ in 0..3 {
        let _ = cx.update_window(window, |_, w, cx| w.render_frame(cx));
        cx.run_until_parked();
    }
    assert!(
        cx.update_window(window, |_, w, cx| has_label(w, cx, card))
            .unwrap_or(false),
        "an open hover state must render the flyout inside the hovered row: {:?}",
        cx.update_window(window, |_, w, cx| {
            w.render_frame(cx);
            w.elements()
                .iter()
                .filter_map(|e| e.label().map(str::to_owned))
                .collect::<Vec<_>>()
        })
    );

    // A right-click opens the Thread Actions menu and must take the flyout down.
    let row_pt = match cx.update_window(window, |_, window, cx| {
        center_by_label(window, cx, "Selected kitchen-sink thread")
    }) {
        Ok(pt) => pt,
        Err(err) => panic!("failed to locate sidebar thread row: {err}"),
    };
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_down(row_pt, MouseButton::Right, cx);
        window.pointer_up(row_pt, MouseButton::Right, cx);
        window.render_frame(cx);
    });
    assert!(
        !cx.update_window(window, |_, w, cx| has_label(w, cx, card))
            .unwrap_or(true),
        "opening the thread menu must close the hover flyout"
    );
}

#[test]
fn hover_card_model_lists_only_the_fields_the_thread_has() {
    use conn_contract::OrchestrationV2ProviderFailureClass as FailureClass;

    use crate::sidebar::hover_card_state::{HoverError, hover_card_model};

    let shell = kitchen_sink_shell();
    let mut thread = shell
        .threads
        .iter()
        .find(|t| t.id == "thread-selected")
        .cloned()
        .expect("kitchen-sink thread");
    let project = shell.project("proj-parity");

    let plain = hover_card_model(&thread, project, None);
    assert_eq!(plain.project.as_deref(), Some("conn-gpui"));
    assert_eq!(plain.branch.as_deref(), Some("feat/parity-check"));
    assert_eq!(plain.model, "claude-sonnet-4-6");
    assert_eq!(plain.environment, None);
    assert_eq!(plain.subagents, None);
    assert_eq!(plain.handed_off_from, None);
    assert_eq!(plain.error, None);
    assert!(plain.pull_requests.is_empty());

    thread.subagent_count = Some(2);
    thread.provider_instance_history = Some(Some(vec![
        "codex".to_owned(),
        thread.provider_instance_id.clone(),
    ]));
    thread.last_error = Some(Some("boom".to_owned()));
    thread.last_error_class = Some(Some(FailureClass::UsageLimit));
    let rich = hover_card_model(&thread, project, Some("Mac mini"));
    assert_eq!(rich.environment.as_deref(), Some("Mac mini"));
    assert_eq!(rich.subagents, Some(2));
    assert_eq!(rich.handed_off_from.as_deref(), Some("Codex"));
    assert_eq!(rich.error, Some(HoverError::UsageLimit));

    thread.last_error_class = Some(Some(FailureClass::ProviderError));
    assert_eq!(
        hover_card_model(&thread, project, None).error,
        Some(HoverError::Failed)
    );
    thread.last_error = Some(Some("  ".to_owned()));
    assert_eq!(hover_card_model(&thread, project, None).error, None);
}

#[gpui_kit::test]
fn thread_hover_card_top_is_level_with_the_hovered_row(cx: &mut TestAppContext) {
    use crate::sidebar::hover_card_state::{card_height, hover_card_model};

    let (window, app) = mount_app(cx);
    let mut shell = kitchen_sink_shell();
    let prs: Vec<conn_contract::ThreadPullRequestLink> = (0..40)
        .map(|n| {
            from_json(json!({
                "host": "github.com", "repository": "a/b", "number": n,
                "url": "https://example.test/pr", "source": "manual",
                "linkedAt": "2026-11-22T15:00:00.000Z", "snapshot": null, "stack": null
            }))
            .expect("pull request link")
        })
        .collect();
    for thread in shell.threads.iter_mut().filter(|t| t.id == "thread-failed") {
        thread.pull_requests = Some(prs.clone());
    }
    let thread = shell
        .threads
        .iter()
        .find(|t| t.id == "thread-failed")
        .cloned()
        .expect("thread");
    let model = hover_card_model(&thread, shell.project("proj-parity"), None);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(shell, cx);
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
            app.open_thread_hover_for_test("thread-failed", cx);
        });
    });
    let (row, card) = cx
        .update_window(window, |_, w, cx| {
            for _ in 0..3 {
                w.render_frame(cx);
            }
            (
                w.find_by_label("Failed thread card").bounds(),
                w.find_by_label("Thread preview: Failed thread card")
                    .bounds(),
            )
        })
        .expect("window");
    assert!(
        (f32::from(card.top()) - f32::from(row.top())).abs() <= 1.0,
        "card top {:?} must sit level with the row top {:?}, not slide up the window",
        card.top(),
        row.top()
    );
    assert!(
        f32::from(card.left()) >= f32::from(row.right()),
        "card must open to the right of the row"
    );
    assert!(
        f32::from(card.bottom()) <= TEST_WINDOW_HEIGHT - 4.0,
        "card must stay inside the window"
    );
    // The pure height estimate that trims the list matches the laid-out card.
    let lines =
        ((f32::from(card.size.height) - card_height(&model, 0) - 17.0) / 26.0).round() as usize;
    let estimated = card_height(&model, lines);
    assert!(
        (estimated - f32::from(card.size.height)).abs() <= 1.0,
        "estimated {estimated} vs laid-out {:?} with {lines} lines",
        card.size.height
    );
}

#[gpui_kit::test]
fn pending_question_banner_sits_on_the_composer_and_digits_pick_its_options(
    cx: &mut TestAppContext,
) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
        });
    });
    let chat = cx.read(|cx| app.read(cx).chat_for_test());
    let selected = |window: &mut Window, cx: &mut gpui_kit::App, label: &str| {
        window.render_frame(cx);
        window.find_by_label(label).selected()
    };
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        // The banner is a drawer over the composer card: inset, and tucked under its top edge.
        let banner = window.find_by_label("Mode").bounds();
        let card = window.find_by_label("Message input card").bounds();
        assert!(
            banner.top() < card.top() && banner.bottom() > card.top(),
            "banner {banner:?} must tuck under the composer card {card:?}"
        );
        assert!(
            banner.left() > card.left() && banner.right() < card.right(),
            "banner {banner:?} must sit inside the card's width {card:?}"
        );
        assert_eq!(selected(window, cx, "VMPal"), Some(false));
        assert_eq!(selected(window, cx, "Headless"), Some(false));

        // With the keyboard in the composer's editor, digits are text, not shortcuts.
        chat.update(cx, |chat, cx| chat.focus_composer(window, cx));
        window.render_frame(cx);
        window.press("2", cx);
        assert_eq!(
            selected(window, cx, "Headless"),
            Some(false),
            "a digit typed in the editor must not pick an option"
        );
        // The typed digit is the answer now, so no option shows as picked until it is removed.
        window.press("backspace", cx);

        // With it on the panel, they pick: the number is the option, and a modified digit,
        // a number past the last option and a shifted digit do nothing.
        let vmpal = window.find_by_label("VMPal").bounds().center();
        window.pointer_move(vmpal, None, cx);
        window.pointer_down(vmpal, MouseButton::Left, cx);
        window.pointer_up(vmpal, MouseButton::Left, cx);
        assert_eq!(selected(window, cx, "VMPal"), Some(true));
        // `⌘3` is the open thread's own jump (the third row), so it opens nothing else.
        window.press("cmd-3", cx);
        window.press("3", cx);
        window.press("shift-2", cx);
        assert_eq!(selected(window, cx, "VMPal"), Some(true));
        assert_eq!(selected(window, cx, "Headless"), Some(false));
        window.press("2", cx);
        assert_eq!(selected(window, cx, "Headless"), Some(true));
        assert_eq!(selected(window, cx, "VMPal"), Some(false));
        window.press("1", cx);
        assert_eq!(selected(window, cx, "VMPal"), Some(true));
        assert_eq!(selected(window, cx, "Headless"), Some(false));
    });
}

fn two_project_shell() -> ShellState {
    let mut shell = kitchen_sink_shell();
    let other: ProjectShell = match from_json(json!({
        "id": "proj-other",
        "title": "orbit",
        "workspaceRoot": "/tmp/orbit-parity",
        "defaultModelSelection": null,
        "scripts": [],
        "createdAt": "2026-11-20T09:00:00.000Z",
        "updatedAt": "2026-11-22T15:00:00.000Z",
    })) {
        Ok(project) => project,
        Err(err) => panic!("second ProjectShell failed: {err}"),
    };
    shell.projects.push(other);
    shell
}

/// Types `text` into the composer and renders, so the draft shows and parks like a user's.
fn type_into_composer(
    cx: &mut TestAppContext,
    window: AnyWindowHandle,
    app: &Entity<ConnApp>,
    text: &str,
) {
    let chat = cx.read(|cx| app.read(cx).chat_for_test());
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        chat.update(cx, |chat, cx| {
            chat.set_draft_text(text.to_owned(), window, cx)
        });
        window.render_frame(cx);
    });
}

#[gpui_kit::test]
fn a_draft_moved_onto_a_project_with_a_draft_leaves_that_draft_in_the_sidebar(
    cx: &mut TestAppContext,
) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(two_project_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
        });
    });

    // orbit gets a draft with text; conn-gpui gets another.
    let _ = cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| {
            app.start_new_thread(Some("proj-other".to_owned()), Some(window), cx);
        });
    });
    type_into_composer(cx, window, &app, "orbit idea");
    let _ = cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| {
            app.start_new_thread(Some("proj-parity".to_owned()), Some(window), cx);
        });
    });
    type_into_composer(cx, window, &app, "conn idea");
    let (moved_id, _) = cx
        .read(|cx| app.read(cx).open_draft_for_test())
        .expect("a draft is open");

    // The hero's picker moves the open draft onto orbit, which already has one.
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_draft_project("proj-other".to_owned(), cx)
        });
    });
    assert_eq!(
        cx.read(|cx| app.read(cx).open_draft_for_test()),
        Some((moved_id.clone(), "proj-other".to_owned())),
        "the draft with content moves to the picked project"
    );
    let _ = cx.update_window(window, |_, window, cx| window.render_frame(cx));

    // Orbit's own draft stays: an unmapped row, with its text and project.
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        assert!(
            window
                .try_find_by_label("orbit idea, Unsent draft, orbit")
                .is_some(),
            "the displaced draft keeps a sidebar row"
        );
    });

    // Leaving the moved draft lists it too, newest first.
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_thread("thread-selected".to_owned(), cx)
        });
    });
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.render_frame(cx);
        assert!(
            window
                .try_find_by_label("conn idea, Unsent draft, orbit")
                .is_some()
        );
        assert!(
            window
                .try_find_by_label("orbit idea, Unsent draft, orbit")
                .is_some()
        );
    });

    // `New thread` in orbit opens the draft the project points at: the moved one.
    let _ = cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| {
            app.start_new_thread(Some("proj-other".to_owned()), Some(window), cx);
        });
    });
    assert_eq!(
        cx.read(|cx| app.read(cx).open_draft_for_test())
            .map(|d| d.0),
        Some(moved_id.clone()),
    );

    // The unmapped draft reopens from its row, with its text back in the composer.
    let row = match cx.update_window(window, |_, window, cx| {
        center_by_label(window, cx, "orbit idea, Unsent draft, orbit")
    }) {
        Ok(pt) => pt,
        Err(err) => panic!("failed to locate the draft row: {err}"),
    };
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_move(row, None, cx);
        window.pointer_down(row, MouseButton::Left, cx);
        window.pointer_up(row, MouseButton::Left, cx);
        window.render_frame(cx);
        window.render_frame(cx);
    });
    let reopened = cx.read(|cx| app.read(cx).open_draft_for_test());
    assert!(
        reopened.is_some_and(|(id, project)| id != moved_id && project == "proj-other"),
        "the unmapped draft is the one open now"
    );
    let chat = cx.read(|cx| app.read(cx).chat_for_test());
    let _ = cx.update_window(window, |_, _, cx| {
        assert!(
            chat.read(cx).draft_has_content(cx),
            "the reopened draft shows its text"
        );
    });
}

#[gpui_kit::test]
fn discarding_a_draft_row_removes_it_and_undo_brings_it_back(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(two_project_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
        });
    });
    let _ = cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| {
            app.start_new_thread(Some("proj-other".to_owned()), Some(window), cx);
        });
    });
    type_into_composer(cx, window, &app, "half a thought");
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_thread("thread-selected".to_owned(), cx)
        });
    });
    let row_label = "half a thought, Unsent draft, orbit";
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.render_frame(cx);
        assert!(window.try_find_by_label(row_label).is_some());
        assert!(window.try_find_by_label("Discard draft").is_some());
    });

    // The row's `x` discards the draft and offers `Undo`.
    let discard = match cx.update_window(window, |_, window, cx| {
        center_by_label(window, cx, "Discard draft")
    }) {
        Ok(pt) => pt,
        Err(err) => panic!("failed to locate the discard button: {err}"),
    };
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_move(discard, None, cx);
        window.pointer_down(discard, MouseButton::Left, cx);
        window.pointer_up(discard, MouseButton::Left, cx);
        window.render_frame(cx);
        window.render_frame(cx);
        assert!(
            window.try_find_by_label(row_label).is_none(),
            "the row is gone"
        );
        assert!(window.try_find_by_label("Undo discard").is_some());
    });

    let undo = match cx.update_window(window, |_, window, cx| {
        center_by_label(window, cx, "Undo discard")
    }) {
        Ok(pt) => pt,
        Err(err) => panic!("failed to locate Undo: {err}"),
    };
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_move(undo, None, cx);
        window.pointer_down(undo, MouseButton::Left, cx);
        window.pointer_up(undo, MouseButton::Left, cx);
        window.render_frame(cx);
        window.render_frame(cx);
        assert!(
            window.try_find_by_label(row_label).is_some(),
            "undo brings the draft row back with its text"
        );
        assert!(window.try_find_by_label("Undo discard").is_none());
    });
}

#[gpui_kit::test]
fn draft_row_menu_offers_copy_project_settings_and_discard(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(two_project_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
        });
    });
    let _ = cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| {
            app.start_new_thread(Some("proj-other".to_owned()), Some(window), cx);
        });
    });
    type_into_composer(cx, window, &app, "menu draft");
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_thread("thread-selected".to_owned(), cx)
        });
    });
    let row = match cx.update_window(window, |_, window, cx| {
        center_by_label(window, cx, "menu draft, Unsent draft, orbit")
    }) {
        Ok(pt) => pt,
        Err(err) => panic!("failed to locate the draft row: {err}"),
    };
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_move(row, None, cx);
        window.pointer_down(row, MouseButton::Right, cx);
        window.pointer_up(row, MouseButton::Right, cx);
        window.render_frame(cx);
        for label in ["Copy", "Project settings"] {
            assert!(
                window.try_find_by_label(label).is_some(),
                "{label} is listed"
            );
        }
        // The row's own `x` and the menu's destructive item.
        assert_eq!(window.find_all_by_label("Discard draft").len(), 2);
    });
    let copy = match cx.update_window(window, |_, window, cx| center_by_label(window, cx, "Copy")) {
        Ok(pt) => pt,
        Err(err) => panic!("failed to locate Copy: {err}"),
    };
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_move(copy, None, cx);
        window.render_frame(cx);
    });
    let path = match cx.update_window(window, |_, window, cx| center_by_label(window, cx, "Path")) {
        Ok(pt) => pt,
        Err(err) => panic!("failed to locate Path: {err}"),
    };
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_move(path, None, cx);
        window.pointer_down(path, MouseButton::Left, cx);
        window.pointer_up(path, MouseButton::Left, cx);
        window.render_frame(cx);
    });
    assert_eq!(
        cx.read(|cx| cx.read_from_clipboard().and_then(|item| item.text()))
            .as_deref(),
        Some("/tmp/orbit-parity"),
        "Copy > Path gives the draft's project folder"
    );
}

#[gpui_kit::test]
fn drafts_are_saved_to_disk_and_come_back_on_the_next_start(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    let dir =
        std::env::temp_dir().join(format!("conn-drafts-ui-{}", crate::drafts::new_draft_id()));
    let path = dir.join("drafts.json");
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_drafts_path_for_test(path.clone());
            app.set_shell(two_project_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
        });
    });
    let _ = cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| {
            app.start_new_thread(Some("proj-other".to_owned()), Some(window), cx);
        });
    });
    type_into_composer(cx, window, &app, "survives a restart");
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_thread("thread-selected".to_owned(), cx);
        });
    });
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.render_frame(cx);
    });
    cx.update(|cx| app.update(cx, |app, cx| app.settle_drafts_for_test(cx)));
    let saved = std::fs::read_to_string(&path).expect("the drafts file is written");
    assert!(saved.contains("survives a restart"));

    // Discarding wipes the draft and its file entry; the saved copy is what a restart reads.
    let _ = cx.update_window(window, |_, window, cx| {
        let discard = center_by_label(window, cx, "Discard draft");
        window.pointer_move(discard, None, cx);
        window.pointer_down(discard, MouseButton::Left, cx);
        window.pointer_up(discard, MouseButton::Left, cx);
        window.render_frame(cx);
        window.render_frame(cx);
        assert!(
            window
                .try_find_by_label("survives a restart, Unsent draft, orbit")
                .is_none()
        );
    });
    std::fs::write(&path, saved).expect("puts the saved file back");
    cx.update(|cx| app.update(cx, |app, cx| app.restore_saved_drafts_for_test(cx)));
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.render_frame(cx);
        assert!(
            window
                .try_find_by_label("survives a restart, Unsent draft, orbit")
                .is_some(),
            "the saved draft is listed again, with its text"
        );
    });
    let _ = std::fs::remove_dir_all(dir);
}

#[gpui_kit::test]
fn picking_an_option_sets_the_typed_answer_aside_in_the_thread_draft(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
        });
    });
    let chat = cx.read(|cx| app.read(cx).chat_for_test());
    let composer = cx.read(|cx| chat.read(cx).composer_for_test());
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        // Picking an option with nothing typed sets nothing aside.
        let vmpal = window.find_by_label("VMPal").bounds().center();
        window.pointer_move(vmpal, None, cx);
        window.pointer_down(vmpal, MouseButton::Left, cx);
        window.pointer_up(vmpal, MouseButton::Left, cx);
        window.render_frame(cx);
        assert_eq!(chat.read(cx).error_for_test(), None);

        chat.update(cx, |chat, cx| chat.focus_composer(window, cx));
        window.render_frame(cx);
        window.input("first try", cx);
        window.render_frame(cx);
        assert_eq!(composer.read(cx).draft_text_for_test(cx), "first try");
        let headless = window.find_by_label("Headless").bounds().center();
        window.pointer_move(headless, None, cx);
        window.pointer_down(headless, MouseButton::Left, cx);
        window.pointer_up(headless, MouseButton::Left, cx);
        window.render_frame(cx);

        let thread_draft = "thread:thread-selected";
        assert_eq!(composer.read(cx).draft_text_for_test(cx), "");
        assert_eq!(
            composer.read(cx).parked_text_for_test(thread_draft).as_deref(),
            Some("first try")
        );
        assert_eq!(
            chat.read(cx).error_for_test().as_deref(),
            Some(
                "Your typed text was set aside. It will be back in the composer once the question is answered."
            )
        );
        assert_eq!(window.find_by_label("Headless").selected(), Some(true));

        // A second answer goes after the first, with a blank line between.
        chat.update(cx, |chat, cx| chat.focus_composer(window, cx));
        window.render_frame(cx);
        window.input("second", cx);
        window.render_frame(cx);
        let vmpal = window.find_by_label("VMPal").bounds().center();
        window.pointer_move(vmpal, None, cx);
        window.pointer_down(vmpal, MouseButton::Left, cx);
        window.pointer_up(vmpal, MouseButton::Left, cx);
        window.render_frame(cx);
        assert_eq!(
            composer.read(cx).parked_text_for_test(thread_draft).as_deref(),
            Some("first try\n\nsecond")
        );
    });
}

#[gpui_kit::test]
fn draft_rows_open_and_menu_from_the_keyboard(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(two_project_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
        });
    });
    let _ = cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| {
            app.start_new_thread(Some("proj-other".to_owned()), Some(window), cx);
        });
    });
    type_into_composer(cx, window, &app, "keyboard draft");
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_thread("thread-selected".to_owned(), cx);
        });
    });
    let label = "keyboard draft, Unsent draft, orbit";
    let row = match cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        center_by_label(window, cx, label)
    }) {
        Ok(pt) => pt,
        Err(err) => panic!("failed to locate the draft row: {err}"),
    };

    // A pressed row has the focus; the menu key opens its menu below the row.
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_move(row, None, cx);
        window.pointer_down(row, MouseButton::Left, cx);
        window.key_down("shift-f10", false, cx);
        window.render_frame(cx);
    });
    assert!(
        cx.read(|cx| app.read(cx).thread_menu_open_for_test()),
        "Shift+F10 opens the focused draft row's menu"
    );
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.dismiss_shell_popovers_for_test(cx);
        });
    });

    // `Enter` reopens the draft.
    assert!(cx.read(|cx| app.read(cx).open_draft_for_test()).is_none());
    let _ = cx.update_window(window, |_, window, cx| {
        window.key_down("enter", false, cx);
        window.render_frame(cx);
    });
    assert_eq!(
        cx.read(|cx| app.read(cx).open_draft_for_test())
            .map(|d| d.1),
        Some("proj-other".to_owned()),
        "Enter on the focused draft row opens the draft"
    );
}

#[gpui_kit::test]
fn a_thread_with_unsent_input_shows_the_pen_and_discards_with_undo(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test(
                "thread-pinned".to_owned(),
                ThreadState::new("thread-pinned"),
                cx,
            );
        });
    });
    let pinned_mark = "Unsent draft";
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        assert!(
            window.try_find_by_label(pinned_mark).is_none(),
            "no thread has unsent input yet"
        );
    });
    type_into_composer(cx, window, &app, "reply I have not sent");
    // The open thread's composer is on screen, so its row carries no mark.
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        assert!(window.try_find_by_label(pinned_mark).is_none());
    });
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_thread_for_test(
                "thread-selected".to_owned(),
                ThreadState::new("thread-selected"),
                cx,
            );
        });
    });
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.render_frame(cx);
        assert!(
            window.try_find_by_label(pinned_mark).is_some(),
            "the thread left with unsent input gets the pen mark"
        );
    });

    // The row's `x` clears the input and offers `Undo`.
    let discard = match cx.update_window(window, |_, window, cx| {
        center_by_label(window, cx, "Discard draft")
    }) {
        Ok(pt) => pt,
        Err(err) => panic!("failed to locate the discard button: {err}"),
    };
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_move(discard, None, cx);
        window.pointer_down(discard, MouseButton::Left, cx);
        window.pointer_up(discard, MouseButton::Left, cx);
        window.render_frame(cx);
        window.render_frame(cx);
        assert!(window.try_find_by_label(pinned_mark).is_none());
        assert!(window.try_find_by_label("Undo discard").is_some());
    });
    let undo = match cx.update_window(window, |_, window, cx| {
        center_by_label(window, cx, "Undo discard")
    }) {
        Ok(pt) => pt,
        Err(err) => panic!("failed to locate Undo: {err}"),
    };
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_move(undo, None, cx);
        window.pointer_down(undo, MouseButton::Left, cx);
        window.pointer_up(undo, MouseButton::Left, cx);
        window.render_frame(cx);
        window.render_frame(cx);
        assert!(
            window.try_find_by_label(pinned_mark).is_some(),
            "undo brings the unsent input back"
        );
    });
}

#[gpui_kit::test]
fn a_threads_unsent_input_is_saved_and_comes_back_on_the_next_start(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    let dir =
        std::env::temp_dir().join(format!("conn-threads-ui-{}", crate::drafts::new_draft_id()));
    let path = dir.join("drafts.json");
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_drafts_path_for_test(path.clone());
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test(
                "thread-pinned".to_owned(),
                ThreadState::new("thread-pinned"),
                cx,
            );
        });
    });
    type_into_composer(cx, window, &app, "unsent across a restart");
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_thread_for_test(
                "thread-selected".to_owned(),
                ThreadState::new("thread-selected"),
                cx,
            );
        });
    });
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.render_frame(cx);
    });
    cx.update(|cx| app.update(cx, |app, cx| app.settle_drafts_for_test(cx)));
    let saved = std::fs::read_to_string(&path).expect("the drafts file is written");
    assert!(saved.contains("unsent across a restart"));

    let _ = cx.update_window(window, |_, window, cx| {
        let discard = center_by_label(window, cx, "Discard draft");
        window.pointer_move(discard, None, cx);
        window.pointer_down(discard, MouseButton::Left, cx);
        window.pointer_up(discard, MouseButton::Left, cx);
        window.render_frame(cx);
        window.render_frame(cx);
        assert!(window.try_find_by_label("Unsent draft").is_none());
    });
    std::fs::write(&path, saved).expect("puts the saved file back");
    cx.update(|cx| app.update(cx, |app, cx| app.restore_saved_drafts_for_test(cx)));
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.render_frame(cx);
        assert!(
            window.try_find_by_label("Unsent draft").is_some(),
            "the thread's unsent input is back"
        );
    });
    let _ = std::fs::remove_dir_all(dir);
}

/// Presses `keys` (`"down"`, `"shift-f10"`) on the window and renders.
fn press(cx: &mut TestAppContext, window: AnyWindowHandle, keys: &str) {
    let _ = cx.update_window(window, |_, window, cx| {
        window.key_down(keys, false, cx);
        window.render_frame(cx);
        window.render_frame(cx);
    });
}

fn sidebar_rows(cx: &mut TestAppContext, app: &Entity<ConnApp>) -> Vec<String> {
    cx.read(|cx| app.read(cx).sidebar_row_keys_for_test())
}

fn focused_sidebar_row(
    cx: &mut TestAppContext,
    window: AnyWindowHandle,
    app: &Entity<ConnApp>,
) -> Option<String> {
    cx.update_window(window, |_, window, cx| {
        app.read(cx).sidebar_focused_row_for_test(window)
    })
    .ok()
    .flatten()
}

fn focus_sidebar_row(
    cx: &mut TestAppContext,
    window: AnyWindowHandle,
    app: &Entity<ConnApp>,
    key: &str,
) {
    let _ = cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| {
            app.focus_sidebar_row_for_test(key, window, cx)
        });
        window.render_frame(cx);
        window.render_frame(cx);
    });
}

fn mount_kitchen_sink(cx: &mut TestAppContext) -> (AnyWindowHandle, Entity<ConnApp>) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
        });
    });
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.render_frame(cx);
    });
    (window, app)
}

#[gpui_kit::test]
fn arrow_keys_walk_the_sidebar_rows_without_opening_them(cx: &mut TestAppContext) {
    let (window, app) = mount_kitchen_sink(cx);
    let rows = sidebar_rows(cx, &app);
    assert!(
        rows.len() >= 5 && rows.first().map(String::as_str) == Some("thread-pinned"),
        "the pinned thread leads the rows, then the active ones (rows: {rows:?})"
    );
    assert_eq!(
        rows.last().map(String::as_str),
        Some("shelf:settled"),
        "the settled shelf's header closes a collapsed list"
    );
    let selected = cx.read(|cx| app.read(cx).selected_thread_for_test().map(str::to_owned));

    focus_sidebar_row(cx, window, &app, &rows[0]);
    assert_eq!(
        focused_sidebar_row(cx, window, &app).as_deref(),
        Some(rows[0].as_str())
    );
    press(cx, window, "down");
    assert_eq!(
        focused_sidebar_row(cx, window, &app).as_deref(),
        Some(rows[1].as_str()),
        "ArrowDown moves to the next row"
    );
    press(cx, window, "up");
    press(cx, window, "up");
    assert_eq!(
        focused_sidebar_row(cx, window, &app).as_deref(),
        Some(rows[0].as_str()),
        "ArrowUp stops at the first row"
    );
    press(cx, window, "end");
    assert_eq!(
        focused_sidebar_row(cx, window, &app).as_deref(),
        rows.last().map(String::as_str),
        "End goes to the last row"
    );
    press(cx, window, "down");
    assert_eq!(
        focused_sidebar_row(cx, window, &app).as_deref(),
        rows.last().map(String::as_str),
        "ArrowDown stops at the last row"
    );
    press(cx, window, "home");
    assert_eq!(
        focused_sidebar_row(cx, window, &app).as_deref(),
        Some(rows[0].as_str()),
        "Home goes to the first row"
    );
    assert_eq!(
        cx.read(|cx| app.read(cx).selected_thread_for_test().map(str::to_owned)),
        selected,
        "moving the keyboard opens nothing"
    );
}

#[gpui_kit::test]
fn the_settled_shelf_expands_before_its_rows_take_the_keyboard(cx: &mut TestAppContext) {
    let (window, app) = mount_kitchen_sink(cx);
    focus_sidebar_row(cx, window, &app, "shelf:settled");
    assert!(!cx.read(|cx| app.read(cx).settled_shelf_open_for_test()));
    assert!(!sidebar_rows(cx, &app).contains(&"thread-settled-1".to_owned()));

    press(cx, window, "left");
    assert!(
        !cx.read(|cx| app.read(cx).settled_shelf_open_for_test()),
        "ArrowLeft on a collapsed shelf has nowhere to go"
    );
    press(cx, window, "right");
    assert!(
        cx.read(|cx| app.read(cx).settled_shelf_open_for_test()),
        "ArrowRight expands a collapsed shelf"
    );
    assert_eq!(
        focused_sidebar_row(cx, window, &app).as_deref(),
        Some("shelf:settled")
    );
    press(cx, window, "right");
    assert_eq!(
        focused_sidebar_row(cx, window, &app).as_deref(),
        Some("thread-settled-1"),
        "ArrowRight on an expanded shelf enters its first row"
    );
    press(cx, window, "left");
    assert_eq!(
        focused_sidebar_row(cx, window, &app).as_deref(),
        Some("shelf:settled"),
        "ArrowLeft goes back to the shelf"
    );
    press(cx, window, "left");
    assert!(
        !cx.read(|cx| app.read(cx).settled_shelf_open_for_test()),
        "ArrowLeft collapses an expanded shelf"
    );
    press(cx, window, "enter");
    assert!(
        cx.read(|cx| app.read(cx).settled_shelf_open_for_test()),
        "Enter toggles the shelf"
    );

    // The row that has the keyboard hides with the shelf; the shelf takes the keyboard.
    focus_sidebar_row(cx, window, &app, "thread-settled-1");
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.toggle_settled_shelf(cx);
        });
    });
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.render_frame(cx);
        window.render_frame(cx);
    });
    assert_eq!(
        focused_sidebar_row(cx, window, &app).as_deref(),
        Some("shelf:settled"),
        "a row that went away hands the keyboard to its parent"
    );
}

#[gpui_kit::test]
fn enter_opens_the_focused_thread_and_f2_renames_it(cx: &mut TestAppContext) {
    let (window, app) = mount_kitchen_sink(cx);
    focus_sidebar_row(cx, window, &app, "thread-waiting");
    press(cx, window, "f2");
    assert_eq!(
        cx.read(|cx| app.read(cx).renaming_thread_for_test().map(str::to_owned))
            .as_deref(),
        Some("thread-waiting"),
        "F2 renames the focused thread"
    );
    cx.update(|cx| app.update(cx, |app, cx| app.cancel_thread_rename(cx)));

    focus_sidebar_row(cx, window, &app, "thread-failed");
    press(cx, window, "enter");
    assert_eq!(
        cx.read(|cx| app.read(cx).selected_thread_for_test().map(str::to_owned))
            .as_deref(),
        Some("thread-failed"),
        "Enter opens the focused thread"
    );
}

#[gpui_kit::test]
fn the_thread_menu_takes_the_arrow_keys(cx: &mut TestAppContext) {
    let (window, app) = mount_kitchen_sink(cx);
    let highlight =
        |cx: &mut TestAppContext| cx.read(|cx| app.read(cx).thread_menu_highlight_for_test());
    focus_sidebar_row(cx, window, &app, "thread-selected");
    press(cx, window, "shift-f10");
    assert!(
        cx.read(|cx| app.read(cx).thread_menu_open_for_test()),
        "Shift+F10 opens the menu below the row"
    );
    assert_eq!(
        highlight(cx).as_deref(),
        Some("Pin thread"),
        "a menu opened from the keyboard starts on its first action"
    );

    press(cx, window, "down");
    assert_eq!(highlight(cx).as_deref(), Some("Settle thread"));
    press(cx, window, "up");
    press(cx, window, "up");
    assert_eq!(
        highlight(cx).as_deref(),
        Some("Delete"),
        "ArrowUp wraps from the first action to the last"
    );
    press(cx, window, "home");
    assert_eq!(highlight(cx).as_deref(), Some("Pin thread"));

    // Down to `Copy`, then into its submenu and back out.
    for _ in 0..12 {
        if highlight(cx).as_deref() == Some("Copy") {
            break;
        }
        press(cx, window, "down");
    }
    assert_eq!(highlight(cx).as_deref(), Some("Copy"));
    press(cx, window, "right");
    assert!(
        cx.read(|cx| app.read(cx).thread_menu_copy_open_for_test()),
        "ArrowRight opens the submenu"
    );
    assert_eq!(highlight(cx).as_deref(), Some("Path"));
    press(cx, window, "down");
    assert_eq!(highlight(cx).as_deref(), Some("Branch"));
    press(cx, window, "left");
    assert!(!cx.read(|cx| app.read(cx).thread_menu_copy_open_for_test()));
    assert_eq!(
        highlight(cx).as_deref(),
        Some("Copy"),
        "ArrowLeft closes the submenu and goes back to its row"
    );
    press(cx, window, "right");
    press(cx, window, "escape");
    assert!(
        cx.read(|cx| app.read(cx).thread_menu_open_for_test()),
        "Escape closes the submenu first"
    );
    assert!(!cx.read(|cx| app.read(cx).thread_menu_copy_open_for_test()));

    // `Enter` on the submenu's `Path` copies it and closes the menu.
    press(cx, window, "right");
    press(cx, window, "enter");
    assert!(
        !cx.read(|cx| app.read(cx).thread_menu_open_for_test()),
        "Enter runs the highlighted action and closes the menu"
    );
    assert_eq!(
        cx.read(|cx| cx.read_from_clipboard().and_then(|item| item.text()))
            .as_deref(),
        Some("/tmp/conn-gpui-parity")
    );
    assert_eq!(
        focused_sidebar_row(cx, window, &app).as_deref(),
        Some("thread-selected"),
        "the keyboard goes back to the row that opened the menu"
    );

    press(cx, window, "shift-f10");
    press(cx, window, "escape");
    assert!(
        !cx.read(|cx| app.read(cx).thread_menu_open_for_test()),
        "Escape closes the menu"
    );
    assert_eq!(
        focused_sidebar_row(cx, window, &app).as_deref(),
        Some("thread-selected")
    );
}

#[gpui_kit::test]
fn the_draft_menu_takes_the_arrow_keys(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(two_project_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
        });
    });
    let _ = cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| {
            app.start_new_thread(Some("proj-other".to_owned()), Some(window), cx);
        });
    });
    type_into_composer(cx, window, &app, "menu draft");
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_thread("thread-selected".to_owned(), cx);
        });
    });
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.render_frame(cx);
    });
    let draft = sidebar_rows(cx, &app)
        .into_iter()
        .find(|key| key.starts_with("draft:"))
        .expect("the typed draft has a row");
    focus_sidebar_row(cx, window, &app, &draft);
    press(cx, window, "shift-f10");
    let highlight = cx.read(|cx| app.read(cx).thread_menu_highlight_for_test());
    assert_eq!(highlight.as_deref(), Some("Copy"));
    press(cx, window, "down");
    press(cx, window, "down");
    assert_eq!(
        cx.read(|cx| app.read(cx).thread_menu_highlight_for_test())
            .as_deref(),
        Some("Discard draft")
    );
    press(cx, window, "enter");
    assert!(
        !cx.read(|cx| app.read(cx).thread_menu_open_for_test()),
        "Enter on Discard draft closes the menu"
    );
    let _ = cx.update_window(window, |_, window, cx| {
        assert!(
            !has_label(window, cx, "menu draft, Unsent draft, orbit"),
            "the draft is discarded"
        );
        assert!(has_label(window, cx, "Undo discard"), "and can be undone");
    });
    assert!(
        focused_sidebar_row(cx, window, &app).is_none()
            || sidebar_rows(cx, &app)
                .contains(&focused_sidebar_row(cx, window, &app).unwrap_or_default()),
        "the keyboard is on a row that is still there"
    );
}

#[gpui_kit::test]
fn command_z_undoes_a_discard_until_another_key_is_pressed(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test(
                "thread-pinned".to_owned(),
                ThreadState::new("thread-pinned"),
                cx,
            );
        });
    });
    type_into_composer(cx, window, &app, "reply I have not sent");
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_thread_for_test(
                "thread-selected".to_owned(),
                ThreadState::new("thread-selected"),
                cx,
            );
        });
    });
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.render_frame(cx);
    });
    let discard = |cx: &mut TestAppContext| {
        let at = match cx.update_window(window, |_, window, cx| {
            center_by_label(window, cx, "Discard draft")
        }) {
            Ok(pt) => pt,
            Err(err) => panic!("failed to locate the discard button: {err}"),
        };
        let _ = cx.update_window(window, |_, window, cx| {
            window.pointer_move(at, None, cx);
            window.pointer_down(at, MouseButton::Left, cx);
            window.pointer_up(at, MouseButton::Left, cx);
            window.render_frame(cx);
            window.render_frame(cx);
        });
    };
    let pen = |cx: &mut TestAppContext| {
        cx.update_window(window, |_, window, cx| {
            has_label(window, cx, "Unsent draft")
        })
        .unwrap_or(false)
    };
    let notice = |cx: &mut TestAppContext| {
        cx.update_window(window, |_, window, cx| {
            has_label(window, cx, "Undo discard")
        })
        .unwrap_or(false)
    };

    // The keyboard is on the page body: `⌘Z` undoes the discard.
    assert!(pen(cx));
    discard(cx);
    assert!(!pen(cx) && notice(cx), "the discard shows its notice");
    press(cx, window, "cmd-z");
    assert!(pen(cx), "⌘Z brings the input back");
    assert!(!notice(cx), "and the notice goes");

    // Inside the composer a new notice owns `⌘Z` ...
    let chat = cx.read(|cx| app.read(cx).chat_for_test());
    let focus_composer = |cx: &mut TestAppContext| {
        let _ = cx.update_window(window, |_, window, cx| {
            chat.update(cx, |chat, cx| chat.focus_composer(window, cx));
            window.render_frame(cx);
        });
    };
    discard(cx);
    focus_composer(cx);
    press(cx, window, "cmd-z");
    assert!(pen(cx), "a new notice owns ⌘Z even in the composer");

    // ... until another key is pressed; then the composer keeps its own undo.
    discard(cx);
    focus_composer(cx);
    press(cx, window, "a");
    press(cx, window, "cmd-z");
    assert!(
        !pen(cx) && notice(cx),
        "after another key ⌘Z belongs to the text field"
    );
}

#[gpui_kit::test]
fn a_deleted_threads_unsent_input_is_forgotten(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    let dir =
        std::env::temp_dir().join(format!("conn-forget-ui-{}", crate::drafts::new_draft_id()));
    let path = dir.join("drafts.json");
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_drafts_path_for_test(path.clone());
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test(
                "thread-pinned".to_owned(),
                ThreadState::new("thread-pinned"),
                cx,
            );
        });
    });
    type_into_composer(cx, window, &app, "typed in a thread that is deleted");
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_thread_for_test(
                "thread-selected".to_owned(),
                ThreadState::new("thread-selected"),
                cx,
            );
            app.settle_drafts_for_test(cx);
        });
    });
    let saved = std::fs::read_to_string(&path).expect("the drafts file is written");
    assert!(saved.contains("typed in a thread that is deleted"));

    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.forget_thread_draft_for_test("thread-pinned", cx);
        });
    });
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.render_frame(cx);
        assert!(
            !has_label(window, cx, "Unsent draft"),
            "the deleted thread's pen mark is gone"
        );
    });
    let saved = std::fs::read_to_string(&path).expect("the drafts file is rewritten");
    assert!(
        !saved.contains("typed in a thread that is deleted"),
        "the deleted thread's input leaves drafts.json"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[gpui_kit::test]
fn tab_closes_the_thread_menu_and_goes_on_from_its_row(cx: &mut TestAppContext) {
    let (window, app) = mount_kitchen_sink(cx);
    let rows = sidebar_rows(cx, &app);
    focus_sidebar_row(cx, window, &app, &rows[0]);
    press(cx, window, "shift-f10");
    assert!(cx.read(|cx| app.read(cx).thread_menu_open_for_test()));
    press(cx, window, "tab");
    assert!(
        !cx.read(|cx| app.read(cx).thread_menu_open_for_test()),
        "Tab closes the menu"
    );
    assert_eq!(
        focused_sidebar_row(cx, window, &app).as_deref(),
        Some(rows[1].as_str()),
        "and moves on to the row after the one that opened it"
    );
}

fn render_twice(cx: &mut TestAppContext, window: AnyWindowHandle) {
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.render_frame(cx);
    });
}

fn search_for(
    cx: &mut TestAppContext,
    window: AnyWindowHandle,
    app: &Entity<ConnApp>,
    query: &str,
) {
    let _ = cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| app.search_for_test(query, window, cx));
    });
    render_twice(cx, window);
}

fn search_highlight(cx: &mut TestAppContext, app: &Entity<ConnApp>) -> Option<String> {
    cx.read(|cx| app.read(cx).search_highlight_for_test(cx))
}

#[gpui_kit::test]
fn the_search_box_works_its_results_with_the_arrow_keys(cx: &mut TestAppContext) {
    let (window, app) = mount_kitchen_sink(cx);
    search_for(cx, window, &app, "thread");
    let results = cx.read(|cx| app.read(cx).search_results_for_test(cx));
    assert_eq!(
        results.first().map(String::as_str),
        Some("thread-pinned"),
        "pinned results lead (results: {results:?})"
    );
    assert_eq!(
        results.last().map(String::as_str),
        Some("thread-settled-1"),
        "settled threads are results too, with the shelf collapsed (results: {results:?})"
    );
    assert_eq!(
        search_highlight(cx, &app).as_deref(),
        Some("thread-pinned"),
        "the first result starts highlighted"
    );

    press(cx, window, "down");
    assert_eq!(
        search_highlight(cx, &app).as_deref(),
        Some(results[1].as_str()),
        "ArrowDown highlights the next result"
    );
    press(cx, window, "up");
    press(cx, window, "up");
    assert_eq!(
        search_highlight(cx, &app).as_deref(),
        results.last().map(String::as_str),
        "ArrowUp wraps from the first result to the last"
    );
    press(cx, window, "down");
    assert_eq!(
        search_highlight(cx, &app).as_deref(),
        Some("thread-pinned"),
        "ArrowDown wraps from the last result to the first"
    );
    assert!(
        cx.update_window(window, |_, window, cx| {
            has_label(window, cx, "Thread search results")
        })
        .unwrap_or(false),
        "the results are a listbox for VoiceOver"
    );

    // `Enter` opens the highlighted result and ends the search.
    press(cx, window, "down");
    let highlighted = search_highlight(cx, &app);
    press(cx, window, "enter");
    assert_eq!(
        cx.read(|cx| app.read(cx).selected_thread_for_test().map(str::to_owned)),
        highlighted,
        "Enter opens the highlighted result"
    );
    assert_eq!(
        cx.read(|cx| app.read(cx).search_text_for_test(cx)),
        "",
        "and the search ends"
    );
}

#[gpui_kit::test]
fn escape_clears_the_search_and_a_search_with_no_results_has_nothing_to_walk(
    cx: &mut TestAppContext,
) {
    let (window, app) = mount_kitchen_sink(cx);
    search_for(cx, window, &app, "no thread has this");
    assert_eq!(search_highlight(cx, &app), None);
    let selected = cx.read(|cx| app.read(cx).selected_thread_for_test().map(str::to_owned));
    press(cx, window, "down");
    press(cx, window, "enter");
    assert_eq!(
        cx.read(|cx| app.read(cx).selected_thread_for_test().map(str::to_owned)),
        selected,
        "Enter opens nothing without results"
    );
    assert!(
        cx.update_window(window, |_, window, cx| {
            has_label(window, cx, "Clear thread search")
        })
        .unwrap_or(false),
        "the clear button has a name"
    );
    press(cx, window, "escape");
    assert_eq!(
        cx.read(|cx| app.read(cx).search_text_for_test(cx)),
        "",
        "Escape clears a search that has no results"
    );
}

#[gpui_kit::test]
fn command_shift_brackets_open_the_thread_above_or_below_and_stop_at_the_ends(
    cx: &mut TestAppContext,
) {
    let (window, app) = mount_kitchen_sink(cx);
    let order = cx.read(|cx| app.read(cx).traversal_ids_for_test());
    assert_eq!(
        order.first().map(String::as_str),
        Some("thread-pinned"),
        "pinned first (order: {order:?})"
    );
    assert!(
        !order.iter().any(|id| id == "thread-settled-1"),
        "a collapsed shelf is not walked (order: {order:?})"
    );
    let open = |cx: &mut TestAppContext| {
        cx.read(|cx| app.read(cx).selected_thread_for_test().map(str::to_owned))
    };
    assert_eq!(open(cx).as_deref(), Some("thread-selected"));
    let at = order
        .iter()
        .position(|id| id == "thread-selected")
        .unwrap_or(0);

    // Nothing has the keyboard yet.
    press(cx, window, "cmd-shift-]");
    assert_eq!(
        open(cx).as_deref(),
        order.get(at + 1).map(String::as_str),
        "⌘⇧] opens the next thread"
    );
    // Then the root has it, as it does once a click or a closed menu hands it back.
    let _ = cx.update_window(window, |_, window, cx| {
        let root = app.read(cx).root_focus_for_test();
        window.focus(&root, cx);
    });
    press(cx, window, "cmd-shift-[");
    assert_eq!(
        open(cx).as_deref(),
        Some("thread-selected"),
        "⌘⇧[ goes back"
    );

    for _ in 0..order.len() {
        press(cx, window, "cmd-shift-[");
    }
    assert_eq!(
        open(cx).as_deref(),
        Some("thread-pinned"),
        "⌘⇧[ stops at the first thread, with no wrap"
    );
    for _ in 0..=order.len() {
        press(cx, window, "cmd-shift-]");
    }
    assert_eq!(
        open(cx).as_deref(),
        order.last().map(String::as_str),
        "⌘⇧] stops at the last thread, with no wrap"
    );
}

#[gpui_kit::test]
fn a_settled_thread_shows_its_notice_and_command_z_takes_it_back_until_something_else_changes_it(
    cx: &mut TestAppContext,
) {
    let (window, app) = mount_kitchen_sink(cx);
    let notice = |cx: &mut TestAppContext, label: &str| {
        cx.update_window(window, |_, window, cx| has_label(window, cx, label))
            .unwrap_or(false)
    };
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.offer_settle_undo_for_test("thread-failed", cx);
            app.offer_settle_undo_for_test("thread-waiting", cx);
        });
    });
    render_twice(cx, window);
    assert!(
        notice(cx, "Settled 2 threads, ⌘Z to undo"),
        "settles stack in one notice"
    );
    assert!(notice(cx, "Undo settle"), "its button names what it undoes");

    // Pinning a thread ends the claim on its settle (`sendPin`).
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.pin_thread("thread-waiting".to_owned(), true, cx)
        });
    });
    render_twice(cx, window);
    assert!(
        notice(cx, "Settled 1 thread, ⌘Z to undo"),
        "the pinned thread left the notice"
    );

    // With no server to take the commands, the undo says so.
    press(cx, window, "cmd-z");
    assert!(
        notice(cx, "Failed to undo settle."),
        "⌘Z undoes the settle, and a refused one says why"
    );
    assert!(!notice(cx, "Undo settle"), "the notice is gone");
}

fn open_thread(cx: &mut TestAppContext, app: &Entity<ConnApp>) -> Option<String> {
    cx.read(|cx| app.read(cx).selected_thread_for_test().map(str::to_owned))
}

fn labelled(cx: &mut TestAppContext, window: AnyWindowHandle, label: &str) -> bool {
    cx.update_window(window, |_, window, cx| has_label(window, cx, label))
        .unwrap_or(false)
}

fn click_row(cx: &mut TestAppContext, window: AnyWindowHandle, title: &str, button: MouseButton) {
    let at = match cx.update_window(window, |_, window, cx| center_by_label(window, cx, title)) {
        Ok(at) => at,
        Err(err) => panic!("failed to locate the row `{title}`: {err}"),
    };
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_move(at, None, cx);
        window.pointer_down(at, button, cx);
        window.pointer_up(at, button, cx);
        window.render_frame(cx);
        window.render_frame(cx);
    });
}

fn hold(cx: &mut TestAppContext, window: AnyWindowHandle, modifiers: gpui_kit::Modifiers) {
    let _ = cx.update_window(window, |_, window, cx| {
        window.change_modifiers(modifiers, cx);
    });
}

fn command() -> gpui_kit::Modifiers {
    gpui_kit::Modifiers {
        platform: true,
        ..gpui_kit::Modifiers::default()
    }
}

#[gpui_kit::test]
fn command_digits_open_the_thread_at_that_place_of_the_walk(cx: &mut TestAppContext) {
    let (window, app) = mount_kitchen_sink(cx);
    let order = cx.read(|cx| app.read(cx).traversal_ids_for_test());
    assert!(
        order.len() >= 5,
        "five threads to jump to (order: {order:?})"
    );

    press(cx, window, "cmd-1");
    assert_eq!(open_thread(cx, &app).as_deref(), Some(order[0].as_str()));
    press(cx, window, "cmd-3");
    assert_eq!(open_thread(cx, &app).as_deref(), Some(order[2].as_str()));
    press(cx, window, "cmd-9");
    assert_eq!(
        open_thread(cx, &app).as_deref(),
        Some(order[2].as_str()),
        "a place with no thread does nothing"
    );
    press(cx, window, "cmd-shift-1");
    press(cx, window, "1");
    assert_eq!(
        open_thread(cx, &app).as_deref(),
        Some(order[2].as_str()),
        "only ⌘ and a digit jump"
    );

    // The keys work from the search box too, and jump in the order the walk has, not the
    // order of the results.
    search_for(cx, window, &app, "thread");
    press(cx, window, "cmd-2");
    assert_eq!(open_thread(cx, &app).as_deref(), Some(order[1].as_str()));
}

#[gpui_kit::test]
fn holding_command_numbers_the_rows_after_a_beat(cx: &mut TestAppContext) {
    let (window, app) = mount_kitchen_sink(cx);
    let order = cx.read(|cx| app.read(cx).traversal_ids_for_test());
    // GPUI sends a modifier change to the focused element's handlers, so something has the
    // keyboard, as it does after any click. The window has to be active too: activating one
    // resets the modifiers it knows.
    let _ = cx.update_window(window, |_, window, cx| {
        let root = app.read(cx).root_focus_for_test();
        window.focus(&root, cx);
    });
    cx.run_until_parked();
    render_twice(cx, window);
    assert!(!labelled(cx, window, "⌘1"), "no numbers before ⌘ is held");

    hold(cx, window, command());
    cx.executor().advance_clock(Duration::from_millis(150));
    cx.run_until_parked();
    render_twice(cx, window);
    assert!(
        !labelled(cx, window, "⌘1"),
        "a quick ⌘ shortcut never flashes the numbers"
    );

    cx.executor().advance_clock(Duration::from_millis(100));
    cx.run_until_parked();
    render_twice(cx, window);
    for number in 1..=order.len().min(5) {
        assert!(
            labelled(cx, window, &format!("⌘{number}")),
            "row {number} wears its number once ⌘ has been held 200ms"
        );
    }
    assert!(!labelled(cx, window, "⌘6"), "only rows that exist have one");

    // Another modifier is another shortcut, and releasing hides the numbers at once.
    hold(
        cx,
        window,
        gpui_kit::Modifiers {
            shift: true,
            ..command()
        },
    );
    render_twice(cx, window);
    assert!(!labelled(cx, window, "⌘1"), "⌘⇧ is not the jump shortcut");
    hold(cx, window, command());
    cx.executor().advance_clock(Duration::from_millis(250));
    cx.run_until_parked();
    render_twice(cx, window);
    assert!(labelled(cx, window, "⌘1"));
    hold(cx, window, gpui_kit::Modifiers::default());
    render_twice(cx, window);
    assert!(!labelled(cx, window, "⌘1"), "released");
}

#[gpui_kit::test]
fn the_unpin_and_settle_notices_stack_by_kind_and_undo_names_what_failed(cx: &mut TestAppContext) {
    let (window, app) = mount_kitchen_sink(cx);
    for thread in ["thread-failed", "thread-waiting"] {
        cx.update(|cx| {
            app.update(cx, |app, cx| app.offer_unpin_undo_for_test(thread, cx));
        });
        render_twice(cx, window);
    }
    assert!(
        labelled(cx, window, "Unpinned 2 threads, ⌘Z to undo"),
        "unpins stack in one notice"
    );
    assert!(labelled(cx, window, "Undo unpin"));

    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.offer_settle_undo_for_test("thread-waiting", cx)
        });
    });
    render_twice(cx, window);
    assert!(
        labelled(cx, window, "Settled 1 thread, ⌘Z to undo"),
        "a different kind starts its own notice"
    );

    // With no server to take the commands, each undo says what failed.
    press(cx, window, "cmd-z");
    assert!(labelled(cx, window, "Failed to undo settle."));
    for _ in 0..4 {
        cx.executor().advance_clock(Duration::from_secs(6));
        cx.run_until_parked();
    }
    render_twice(cx, window);
    assert!(!labelled(cx, window, "Failed to undo settle."));
}

#[gpui_kit::test]
fn command_click_picks_threads_and_the_menu_acts_on_all_of_them(cx: &mut TestAppContext) {
    let (window, app) = mount_kitchen_sink(cx);
    let picked = |cx: &mut TestAppContext| cx.read(|cx| app.read(cx).thread_selection_for_test());

    hold(cx, window, command());
    click_row(cx, window, "Failed thread card", MouseButton::Left);
    click_row(cx, window, "Thread awaiting approval", MouseButton::Left);
    hold(cx, window, gpui_kit::Modifiers::default());
    assert_eq!(
        picked(cx),
        ["thread-failed", "thread-waiting"],
        "⌘-click picks, in the order picked"
    );
    assert_eq!(
        open_thread(cx, &app).as_deref(),
        Some("thread-selected"),
        "and opens nothing"
    );

    // A right-click on a picked row opens the bulk menu.
    click_row(cx, window, "Failed thread card", MouseButton::Right);
    for label in [
        "Settle (2)",
        "Regenerate titles (2)",
        "Mark unread (2)",
        "Delete (2)",
    ] {
        assert!(labelled(cx, window, label), "the bulk menu has `{label}`");
    }
    assert!(
        !labelled(cx, window, "Rename thread"),
        "and none of the single-thread rows"
    );
    press(cx, window, "escape");
    assert!(!cx.read(|cx| app.read(cx).thread_menu_open_for_test()));

    // Shift-click picks from the last thread picked to this one.
    hold(
        cx,
        window,
        gpui_kit::Modifiers {
            shift: true,
            ..gpui_kit::Modifiers::default()
        },
    );
    click_row(
        cx,
        window,
        "Unselected background working thread",
        MouseButton::Left,
    );
    hold(cx, window, gpui_kit::Modifiers::default());
    assert_eq!(
        picked(cx),
        ["thread-failed", "thread-waiting", "thread-working-bg"],
        "the range from the anchor joins"
    );
    click_row(cx, window, "Failed thread card", MouseButton::Right);
    assert!(labelled(cx, window, "Settle (3)"));
    press(cx, window, "escape");

    // The menu of a thread that is not picked is its own, and a plain click ends the selection.
    click_row(cx, window, "Pinned active thread", MouseButton::Right);
    assert!(labelled(cx, window, "Rename thread"));
    press(cx, window, "escape");
    click_row(cx, window, "Pinned active thread", MouseButton::Left);
    assert!(picked(cx).is_empty(), "opening a thread ends the selection");
    assert_eq!(open_thread(cx, &app).as_deref(), Some("thread-pinned"));
}

#[gpui_kit::test]
fn search_results_are_slim_options_that_take_no_tab_stop(cx: &mut TestAppContext) {
    let (window, app) = mount_kitchen_sink(cx);
    assert!(!sidebar_rows(cx, &app).is_empty());
    search_for(cx, window, &app, "thread");
    assert!(
        sidebar_rows(cx, &app).is_empty(),
        "no result is a row the keyboard can reach (tabIndex -1)"
    );
    assert!(
        labelled(cx, window, "Failed thread card, conn-gpui"),
        "a result is named by its title and project"
    );
    let results = cx.read(|cx| app.read(cx).search_results_for_test(cx));
    assert!(
        results.contains(&"thread-settled-1".to_owned()),
        "settled threads are results"
    );
    assert!(
        !labelled(cx, window, "Settle thread"),
        "a result has no hover controls, the card's settle button among them"
    );
    // Clicking a result opens it, and the keyboard stays in the box.
    click_row(
        cx,
        window,
        "Failed thread card, conn-gpui",
        MouseButton::Left,
    );
    assert_eq!(open_thread(cx, &app).as_deref(), Some("thread-failed"));
    assert_eq!(cx.read(|cx| app.read(cx).search_text_for_test(cx)), "");
}

#[gpui_kit::test]
fn keys_typed_while_an_input_method_composes_belong_to_it(cx: &mut TestAppContext) {
    let (window, app) = mount_kitchen_sink(cx);
    search_for(cx, window, &app, "thr");
    let before = search_highlight(cx, &app);
    assert!(before.is_some(), "the search has results");
    let _ = cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| {
            app.compose_in_search_for_test("e", window, cx)
        });
    });
    render_twice(cx, window);

    press(cx, window, "down");
    assert_eq!(
        search_highlight(cx, &app),
        before,
        "ArrowDown picks a candidate, it does not move the highlight"
    );
    press(cx, window, "enter");
    assert_eq!(
        open_thread(cx, &app).as_deref(),
        Some("thread-selected"),
        "Enter commits the composition, it does not open a result"
    );
    press(cx, window, "escape");
    assert!(
        !cx.read(|cx| app.read(cx).search_text_for_test(cx))
            .is_empty(),
        "Escape cancels the composition, it does not clear the search"
    );
}

#[gpui_kit::test]
fn opening_a_thread_the_project_filter_hides_widens_the_filter(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(two_project_shell(), cx);
            app.select_workspace(Some("proj-other".to_owned()), cx);
        });
    });
    render_twice(cx, window);
    assert_eq!(
        cx.read(|cx| app.read(cx).active_workspace_for_test().map(str::to_owned)),
        Some("proj-other".to_owned())
    );
    cx.update(|cx| {
        app.update(cx, |app, cx| app.select_thread("thread-failed", cx));
    });
    render_twice(cx, window);
    assert_eq!(
        cx.read(|cx| app.read(cx).active_workspace_for_test().map(str::to_owned)),
        None,
        "the thread's project is not in the filter, so the filter shows every project"
    );
    assert!(
        labelled(cx, window, "Failed thread card"),
        "and the thread's row is there"
    );
}

#[gpui_kit::test]
fn files_dropped_on_a_thread_row_open_that_thread(cx: &mut TestAppContext) {
    let (window, app) = mount_kitchen_sink(cx);
    let file = std::env::temp_dir().join(format!("conn-row-drop-{}.png", std::process::id()));
    if let Err(err) = std::fs::write(&file, [0x89_u8, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        panic!("failed to write the dropped file: {err}");
    }
    let _ = cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| {
            app.thread_files_dropped("thread-failed", vec![file.clone()], window, cx);
        });
    });
    render_twice(cx, window);
    assert_eq!(
        open_thread(cx, &app).as_deref(),
        Some("thread-failed"),
        "the drop opens the thread it landed on (the composer takes the files once it has a server)"
    );
    let _ = std::fs::remove_file(file);
}

#[gpui_kit::test]
fn an_open_subagent_keeps_its_parents_row_current_for_the_walk(cx: &mut TestAppContext) {
    let (window, app) = mount_kitchen_sink(cx);
    let mut shell = kitchen_sink_shell();
    let mut subagent = make_thread_shell(ThreadSeedSpec {
        id: "thread-subagent",
        project_id: "proj-parity",
        title: "Delegated subagent",
        status: "running",
        activity_run_status: Some("running"),
        pinned_at: None,
        settled_at: None,
        pending_kind: None,
    });
    subagent.lineage.parent_thread_id = Some("thread-waiting".to_owned());
    subagent.lineage.relationship_to_parent =
        Some(conn_contract::OrchestrationV2AppThreadLineageRelationshipToParent::Subagent);
    shell.threads.push(subagent);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(shell, cx);
            app.select_thread("thread-subagent", cx);
        });
    });
    render_twice(cx, window);
    let order = cx.read(|cx| app.read(cx).traversal_ids_for_test());
    assert!(
        !order.iter().any(|id| id == "thread-subagent"),
        "a subagent has no row of its own"
    );
    let parent = order
        .iter()
        .position(|id| id == "thread-waiting")
        .unwrap_or(0);

    press(cx, window, "cmd-shift-]");
    assert_eq!(
        open_thread(cx, &app).as_deref(),
        order.get(parent + 1).map(String::as_str),
        "⌘⇧] walks on from the parent's row"
    );
}

/// The kitchen sink with `count` older settled threads, newest first (`Older settled 00`...).
fn kitchen_sink_with_older_settled(count: usize) -> ShellState {
    let base = kitchen_sink_shell();
    let older: Vec<(String, String, String)> = (0..count)
        .map(|n| {
            (
                format!("old-{n:02}"),
                format!("Older settled {n:02}"),
                format!("2026-11-10T00:{:02}:00.000Z", 59 - n),
            )
        })
        .collect();
    let mut threads = base.threads.clone();
    for (id, title, at) in &older {
        threads.push(make_thread_shell(ThreadSeedSpec {
            id,
            project_id: "proj-parity",
            title,
            status: "completed",
            activity_run_status: None,
            pinned_at: None,
            settled_at: Some(at),
            pending_kind: None,
        }));
    }
    ShellState::from_parts(base.projects, threads, Vec::new(), Some(100))
}

#[gpui_kit::test]
fn the_settled_shelf_shows_ten_rows_and_its_footer_adds_a_page(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_with_older_settled(12), cx);
            app.toggle_settled_shelf(cx);
        });
    });
    render_twice(cx, window);
    let rows = sidebar_rows(cx, &app);
    assert!(rows.contains(&"old-08".to_owned()), "ten rows show");
    assert!(!rows.contains(&"old-09".to_owned()));
    assert!(
        rows.contains(&"shelf:settled:more".to_owned()),
        "the footer is a row the keyboard reaches"
    );
    // The list scrolls; what is below the fold is not on screen to be found.
    reveal_row(cx, window, &app, "shelf:settled:more");
    assert!(
        labelled(cx, window, "Settled (13)"),
        "the header counts every settled thread"
    );
    assert!(
        labelled(cx, window, "Show 3 more"),
        "the footer offers the rest"
    );

    click_row(cx, window, "Show 3 more", MouseButton::Left);
    let rows = sidebar_rows(cx, &app);
    assert!(rows.contains(&"old-11".to_owned()), "a page more shows");
    assert!(
        !rows.contains(&"shelf:settled:more".to_owned()),
        "and the footer is gone"
    );

    // Closing the shelf keeps the choice, and drops the rows and the footer.
    reveal_row(cx, window, &app, "shelf:settled");
    click_row(cx, window, "Settled (13)", MouseButton::Left);
    assert!(!sidebar_rows(cx, &app).contains(&"old-00".to_owned()));
}

fn reveal_row(cx: &mut TestAppContext, window: AnyWindowHandle, app: &Entity<ConnApp>, key: &str) {
    cx.update(|cx| app.update(cx, |app, _| app.reveal_sidebar_row_for_test(key)));
    render_twice(cx, window);
}

#[gpui_kit::test]
fn enter_on_the_shelf_footer_shows_more_and_does_not_close_the_shelf(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_with_older_settled(12), cx);
            app.toggle_settled_shelf(cx);
        });
    });
    render_twice(cx, window);
    focus_sidebar_row(cx, window, &app, "shelf:settled:more");
    press(cx, window, "enter");
    assert!(
        sidebar_rows(cx, &app).contains(&"old-11".to_owned()),
        "a page more shows"
    );
    assert!(cx.read(|cx| app.read(cx).settled_shelf_open_for_test()));
}

fn drag_row(
    cx: &mut TestAppContext,
    window: AnyWindowHandle,
    from: Point<Pixels>,
    to: Point<Pixels>,
) {
    let held = Some(MouseButton::Left);
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_move(from, None, cx);
        window.pointer_down(from, MouseButton::Left, cx);
        // Less than the drag distance is still a press.
        window.pointer_move(
            Point {
                x: from.x,
                y: from.y + px(3.0),
            },
            held,
            cx,
        );
        window.pointer_move(
            Point {
                x: from.x,
                y: from.y + px(12.0),
            },
            held,
            cx,
        );
        window.pointer_move(to, held, cx);
        window.render_frame(cx);
    });
}

fn release(cx: &mut TestAppContext, window: AnyWindowHandle, at: Point<Pixels>) {
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_up(at, MouseButton::Left, cx);
        window.render_frame(cx);
        window.render_frame(cx);
    });
}

fn row_center(cx: &mut TestAppContext, window: AnyWindowHandle, label: &str) -> Point<Pixels> {
    match cx.update_window(window, |_, window, cx| center_by_label(window, cx, label)) {
        Ok(at) => at,
        Err(err) => panic!("failed to locate `{label}`: {err}"),
    }
}

#[gpui_kit::test]
fn dragging_a_row_over_pinned_pins_it_and_over_another_active_row_reorders(
    cx: &mut TestAppContext,
) {
    use conn_state::sidebar_drag::{DropPlan, Section};
    let (window, app) = mount_kitchen_sink(cx);
    cx.update(|cx| app.update(cx, |app, _| app.allow_gestures_offline_for_test()));
    let failed = row_center(cx, window, "Failed thread card");
    let pinned = row_center(cx, window, "Pinned active thread");

    drag_row(cx, window, failed, pinned);
    assert_eq!(
        cx.read(|cx| app.read(cx).held_row_for_test()),
        Some(("thread-failed".to_owned(), Some(Section::Pinned))),
        "held over the pinned row it would land in Pinned"
    );
    assert!(
        labelled(cx, window, "Pinned") && labelled(cx, window, "Active"),
        "both sections show their labels while a row is held"
    );
    assert!(labelled(cx, window, "Pin"), "the held row wears the verb");
    release(cx, window, pinned);
    assert!(
        matches!(
            cx.read(|cx| app.read(cx).last_drop_for_test()),
            Some(DropPlan::Pin { .. })
        ),
        "the drop pins"
    );
    assert_eq!(
        open_thread(cx, &app).as_deref(),
        Some("thread-selected"),
        "the click that ends a drag opens nothing"
    );
    assert!(cx.read(|cx| app.read(cx).held_row_for_test()).is_none());

    // Dropped on another active row, it takes that row's place among the active rows.
    let order = cx.read(|cx| app.read(cx).traversal_ids_for_test());
    let active: Vec<&String> = order
        .iter()
        .filter(|id| id.as_str() != "thread-pinned" && id.as_str() != "thread-settled-1")
        .collect();
    assert!(active.len() >= 3);
    let title = |id: &str| match id {
        "thread-failed" => "Failed thread card",
        "thread-selected" => "Selected kitchen-sink thread",
        "thread-waiting" => "Thread awaiting approval",
        _ => "Unselected background working thread",
    };
    let first = row_center(cx, window, title(active[0]));
    let last = row_center(cx, window, title(active[active.len() - 1]));
    drag_row(cx, window, first, last);
    release(cx, window, last);
    assert!(
        matches!(
            cx.read(|cx| app.read(cx).last_drop_for_test()),
            Some(DropPlan::MoveActive {
                unpin: false,
                unsettle: false,
                ..
            })
        ),
        "the drop reorders the active rows"
    );
}

#[gpui_kit::test]
fn dragging_an_active_row_to_the_settled_header_settles_it_and_escape_cancels(
    cx: &mut TestAppContext,
) {
    use conn_state::sidebar_drag::{DropPlan, Section};
    let (window, app) = mount_kitchen_sink(cx);
    cx.update(|cx| app.update(cx, |app, _| app.allow_gestures_offline_for_test()));
    let failed = row_center(cx, window, "Failed thread card");
    let header = row_center(cx, window, "Settled (1)");

    drag_row(cx, window, failed, header);
    assert_eq!(
        cx.read(|cx| app.read(cx).held_row_for_test()),
        Some(("thread-failed".to_owned(), Some(Section::Settled)))
    );
    assert!(
        labelled(cx, window, "Settle"),
        "the held row says what it would do"
    );
    press(cx, window, "escape");
    assert!(
        cx.read(|cx| app.read(cx).held_row_for_test()).is_none(),
        "Escape lets go"
    );
    release(cx, window, header);
    assert!(
        cx.read(|cx| app.read(cx).last_drop_for_test()).is_none(),
        "and nothing dropped"
    );

    drag_row(cx, window, failed, header);
    release(cx, window, header);
    assert_eq!(
        cx.read(|cx| app.read(cx).last_drop_for_test()),
        Some(DropPlan::Settle)
    );
}

#[gpui_kit::test]
fn a_press_that_does_not_move_far_is_a_click_and_a_search_holds_rows_still(
    cx: &mut TestAppContext,
) {
    let (window, app) = mount_kitchen_sink(cx);
    cx.update(|cx| app.update(cx, |app, _| app.allow_gestures_offline_for_test()));
    let failed = row_center(cx, window, "Failed thread card");
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_move(failed, None, cx);
        window.pointer_down(failed, MouseButton::Left, cx);
        window.pointer_move(
            Point {
                x: failed.x,
                y: failed.y + px(3.0),
            },
            Some(MouseButton::Left),
            cx,
        );
        window.pointer_up(failed, MouseButton::Left, cx);
        window.render_frame(cx);
    });
    assert_eq!(
        open_thread(cx, &app).as_deref(),
        Some("thread-failed"),
        "a press that stayed within the drag distance opens the thread"
    );
}

#[gpui_kit::test]
fn the_settle_button_sweeps_the_rows_between_and_applies_them_on_release(cx: &mut TestAppContext) {
    use crate::app::PressMode;
    use conn_state::sidebar_drag::SweepAction;
    let (window, app) = mount_kitchen_sink(cx);
    cx.update(|cx| app.update(cx, |app, _| app.allow_gestures_offline_for_test()));
    let order = cx.read(|cx| app.read(cx).traversal_ids_for_test());
    let active: Vec<String> = order
        .iter()
        .filter(|id| id.as_str() != "thread-pinned" && id.as_str() != "thread-settled-1")
        .cloned()
        .collect();
    let title = |id: &str| match id {
        "thread-failed" => "Failed thread card",
        "thread-selected" => "Selected kitchen-sink thread",
        "thread-waiting" => "Thread awaiting approval",
        _ => "Unselected background working thread",
    };
    let top = row_center(cx, window, title(&active[0]));
    let third = row_center(cx, window, title(&active[2]));
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_move(top, None, cx);
        app.update(cx, |app, cx| {
            app.row_pressed(
                &active[0],
                top,
                PressMode::Sweep(SweepAction::Settle),
                true,
                cx,
            );
        });
        window.pointer_move(
            Point {
                x: top.x,
                y: top.y + px(12.0),
            },
            Some(MouseButton::Left),
            cx,
        );
        window.pointer_move(third, Some(MouseButton::Left), cx);
        window.render_frame(cx);
    });
    assert_eq!(
        cx.read(|cx| app.read(cx).swept_rows_for_test()),
        active[..3].to_vec(),
        "the rows from the button's row to the one under the pointer"
    );
    release(cx, window, third);
    assert_eq!(
        cx.read(|cx| app.read(cx).last_sweep_for_test()),
        Some(active[..3].to_vec()),
        "release applies the sweep"
    );
}

fn message_hit(thread_id: &str, snippet: &str) -> conn_contract::OrchestrationThreadSearchMatch {
    match from_json(json!({
        "threadId": thread_id,
        "projectId": "proj-parity",
        "source": "assistant",
        "snippet": snippet,
        "messageCreatedAt": "2026-11-22T10:00:00.000Z",
    })) {
        Ok(found) => found,
        Err(err) => panic!("search match failed to decode: {err}"),
    }
}

#[gpui_kit::test]
fn a_thread_a_message_matches_is_listed_after_the_title_matches_with_the_message(
    cx: &mut TestAppContext,
) {
    let (window, app) = mount_kitchen_sink(cx);
    search_for(cx, window, &app, "zebrafish");
    assert!(
        cx.read(|cx| app.read(cx).search_results_for_test(cx))
            .is_empty(),
        "no title says it"
    );
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.message_matches_for_test(
                "zebrafish",
                vec![message_hit(
                    "thread-failed",
                    "…the zebrafish migration finished…",
                )],
                cx,
            );
        });
    });
    render_twice(cx, window);
    assert_eq!(
        cx.read(|cx| app.read(cx).search_results_for_test(cx)),
        ["thread-failed"],
        "the thread is listed for its message"
    );
    assert_eq!(
        cx.read(|cx| app.read(cx).excerpt_for_test("thread-failed"))
            .as_deref(),
        Some("…the zebrafish migration finished…")
    );
    assert!(labelled(cx, window, "Failed thread card, conn-gpui"));
}

/// The launcher renders in the open, tab-less right panel, then gives way to a picked surface and
/// does not return when a panel with tabs reopens. The "no tabs shows the launcher" rule itself
/// is `LayoutState::shows_surface_launcher`; this drives its wiring through real frames, where
/// debug assertions catch duplicate AX ids and hover styles.
#[gpui_kit::test]
fn the_right_panel_renders_the_launcher_then_a_picked_surface_without_panic(
    cx: &mut TestAppContext,
) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
        });
    });
    let frames = |cx: &mut TestAppContext| {
        for _ in 0..3 {
            let _ = cx.update_window(window, |_, w, cx| w.render_frame(cx));
            cx.run_until_parked();
        }
    };
    let open = |cx: &mut TestAppContext| cx.update(|cx| app.read(cx).layout().right_panel_open);

    cx.update(|cx| app.update(cx, |app, cx| app.toggle_right_panel(cx)));
    frames(cx);
    assert!(open(cx), "toggling opens the right panel on the launcher");

    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_right_panel_tab(conn_state::RightPanelTab::Browser, cx);
        });
    });
    frames(cx);

    // The add menu's Browser adds a peer tab each time (`createBrowserSurface`), each with its
    // own browser rendered in turn.
    let browser_tabs = |cx: &mut TestAppContext| {
        cx.update(|cx| app.read(cx).right_panel_tabs().browser_ids().count())
    };
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.add_right_panel_tab(conn_state::RightPanelTab::Browser, cx);
        });
    });
    frames(cx);
    assert_eq!(browser_tabs(cx), 2, "a second browser tab opens");
    let first = cx.update(|cx| app.read(cx).right_panel_tabs().tabs()[0].clone());
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_right_panel_surface(first.clone(), cx)
        })
    });
    frames(cx);
    cx.update(|cx| app.update(cx, |app, cx| app.close_right_panel_tab(&first, cx)));
    frames(cx);
    assert_eq!(browser_tabs(cx), 1, "closing one leaves the other");
    assert!(
        open(cx),
        "closing a tab that is not the last keeps the panel"
    );

    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.toggle_right_panel(cx);
            app.toggle_right_panel(cx);
        });
    });
    frames(cx);
    assert!(open(cx), "reopening restores the panel with its tab");
}

/// Closing a browser tab releases its browser (and with it the last frame and the Chromium
/// view): no handle keeps the closed panel alive.
#[gpui_kit::test]
fn closing_a_browser_tab_releases_its_browser(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    let frames = |cx: &mut TestAppContext| {
        for _ in 0..3 {
            let _ = cx.update_window(window, |_, w, cx| w.render_frame(cx));
            cx.run_until_parked();
        }
    };
    for _ in 0..2 {
        cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.add_right_panel_tab(conn_state::RightPanelTab::Browser, cx);
            });
        });
        frames(cx);
    }
    let first = cx.update(|cx| app.read(cx).right_panel_tabs().tabs()[0].clone());
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_right_panel_surface(first.clone(), cx)
        })
    });
    frames(cx);
    let conn_state::PanelSurface::Browser(id) = first else {
        panic!("the add menu opens browser tabs");
    };
    let Some(weak) = cx.update(|cx| app.read(cx).browser_weak_for_test(id, cx)) else {
        panic!("the shown tab has a browser");
    };
    cx.update(|cx| app.update(cx, |app, cx| app.close_right_panel_tab(&first, cx)));
    frames(cx);
    assert!(
        weak.upgrade().is_none(),
        "the closed tab's browser is released"
    );
}

/// A link opened in background tab B keeps its address when its opener A closes before B was
/// ever shown: B loads the link, not a blank page.
#[gpui_kit::test]
fn closing_the_opener_keeps_a_background_tabs_link(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    let frames = |cx: &mut TestAppContext| {
        for _ in 0..3 {
            let _ = cx.update_window(window, |_, w, cx| w.render_frame(cx));
            cx.run_until_parked();
        }
    };
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.add_right_panel_tab(conn_state::RightPanelTab::Browser, cx);
        });
    });
    frames(cx);
    let opener = cx.update(|cx| app.read(cx).right_panel_tabs().tabs()[0].clone());
    const LINK: &str = "http://localhost:3000/docs";
    cx.update(|cx| app.update(cx, |app, cx| app.open_browser_tab(LINK.into(), true, cx)));
    frames(cx);
    let background = cx.update(|cx| app.read(cx).right_panel_tabs().tabs()[1].clone());
    assert_eq!(
        cx.update(|cx| app.read(cx).right_panel_tabs().active().cloned()),
        Some(opener.clone()),
        "a background tab leaves the opener showing"
    );
    cx.update(|cx| app.update(cx, |app, cx| app.close_right_panel_tab(&opener, cx)));
    frames(cx);
    let conn_state::PanelSurface::Browser(id) = background else {
        panic!("the link opens a browser tab");
    };
    let target = cx.update(|cx| app.read(cx).browser_target_for_test(id, cx));
    assert_eq!(target.as_deref(), Some(LINK));
}

/// Each thread has its own browser tabs (`rightPanelStore.byThreadKey`). A tab that does not
/// show keeps its browser, so its page (scroll, form values) is still there when it shows
/// again, after a thread switch or a sibling tab's close. A deleted thread's browsers go.
#[gpui_kit::test]
fn browser_tabs_keep_their_pages_per_thread(cx: &mut TestAppContext) {
    use conn_state::PanelSurface;
    const ONE: &str = "https://one.example/";
    const TWO: &str = "https://two.example/";
    let (window, app) = mount_two_thread_app(cx);
    let frames = |cx: &mut TestAppContext| {
        for _ in 0..3 {
            let _ = cx.update_window(window, |_, w, cx| w.render_frame(cx));
            cx.run_until_parked();
        }
    };
    let tabs =
        |cx: &mut TestAppContext| cx.update(|cx| app.read(cx).right_panel_tabs().tabs().to_vec());
    let browser_id = |surface: &PanelSurface| match surface {
        PanelSurface::Browser(id) => *id,
        other => panic!("{other:?} is not a browser tab"),
    };

    cx.update(|cx| app.update(cx, |app, cx| app.select_thread("thread-selected", cx)));
    for url in [ONE, TWO] {
        cx.update(|cx| app.update(cx, |app, cx| app.open_browser_tab(url.into(), false, cx)));
        frames(cx);
    }
    let a_tabs = tabs(cx);
    let [one, two] = [browser_id(&a_tabs[0]), browser_id(&a_tabs[1])];
    let page_one = cx
        .update(|cx| app.read(cx).browser_weak_for_test(one, cx))
        .expect("the first tab was shown, so it has a browser");

    cx.update(|cx| app.update(cx, |app, cx| app.select_thread("thread-other", cx)));
    frames(cx);
    assert!(tabs(cx).is_empty(), "another thread starts with no tabs");
    assert!(!cx.update(|cx| app.read(cx).layout().right_panel_open));
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.add_right_panel_tab(conn_state::RightPanelTab::Browser, cx)
        })
    });
    frames(cx);
    let b_tab = browser_id(&tabs(cx)[0]);
    assert!(
        ![one, two].contains(&b_tab),
        "browser ids differ across threads"
    );
    let page_b = cx
        .update(|cx| app.read(cx).browser_weak_for_test(b_tab, cx))
        .expect("the shown tab has a browser");

    cx.update(|cx| app.update(cx, |app, cx| app.select_thread("thread-selected", cx)));
    frames(cx);
    assert_eq!(tabs(cx), a_tabs, "thread A gets its tabs back");
    assert!(cx.update(|cx| app.read(cx).layout().right_panel_open));
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.close_right_panel_tab(&PanelSurface::Browser(two), cx)
        })
    });
    frames(cx);
    assert_eq!(
        cx.update(|cx| app.read(cx).browser_weak_for_test(one, cx))
            .and_then(|weak| weak.upgrade())
            .map(|page| page.entity_id()),
        page_one.upgrade().map(|page| page.entity_id()),
        "the first page is the same browser after the switch and the close"
    );
    assert_eq!(
        cx.update(|cx| app.read(cx).browser_target_for_test(one, cx))
            .as_deref(),
        Some(ONE)
    );
    assert!(page_b.upgrade().is_some(), "a hidden thread keeps its page");

    // What a delete made here does once the server took it.
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            let owner = app.panel_owner_for_test("thread-other");
            app.release_thread_panel(&owner, cx)
        })
    });
    frames(cx);
    assert!(
        page_b.upgrade().is_none(),
        "a deleted thread's browser is released"
    );
}

/// `thread.removed` as the TypeScript server sends it for both a delete and an archive.
fn thread_removed(id: &str) -> ClientEvent {
    match from_json(json!({
        "kind": "thread.removed",
        "sequence": 10_000,
        "location": "active",
        "threadId": id,
    })) {
        Ok(item) => ClientEvent::Shell(item),
        Err(err) => panic!("thread.removed failed: {err}"),
    }
}

/// The server's word that `thread` moved to the archive.
fn thread_archived(thread: &ThreadShell) -> ClientEvent {
    thread_updated(thread, "archive")
}

/// `thread.updated` placing `thread` in `location` (`active` brings an archived thread back).
fn thread_updated(thread: &ThreadShell, location: &str) -> ClientEvent {
    let thread = match serde_json::to_value(thread) {
        Ok(value) => value,
        Err(err) => panic!("ThreadShell did not serialize: {err}"),
    };
    match from_json(json!({
        "kind": "thread.updated",
        "sequence": 10_001,
        "location": location,
        "thread": thread,
    })) {
        Ok(item) => ClientEvent::Shell(item),
        Err(err) => panic!("thread.updated failed: {err}"),
    }
}

/// Two projects, one thread each that the panel tests switch between.
fn mount_two_thread_app(cx: &mut TestAppContext) -> (AnyWindowHandle, Entity<ConnApp>) {
    let (window, app) = mount_app(cx);
    let mut shell = two_project_shell();
    shell.threads.push(make_thread_shell(ThreadSeedSpec {
        id: "thread-other",
        project_id: "proj-other",
        title: "Other project thread",
        status: "completed",
        activity_run_status: None,
        pinned_at: None,
        settled_at: None,
        pending_kind: None,
    }));
    shell.synchronized = true;
    cx.update(|cx| app.update(cx, |app, cx| app.set_shell(shell, cx)));
    (window, app)
}

fn render_frames(cx: &mut TestAppContext, window: AnyWindowHandle) {
    for _ in 0..3 {
        let _ = cx.update_window(window, |_, w, cx| w.render_frame(cx));
        cx.run_until_parked();
    }
}

/// Opens a browser tab on `thread` and returns its browser once it rendered.
fn open_thread_browser(
    cx: &mut TestAppContext,
    window: AnyWindowHandle,
    app: &Entity<ConnApp>,
    thread: &str,
) -> (
    conn_state::BrowserTabId,
    gpui_kit::WeakEntity<crate::panels::BrowserPanelHandle>,
) {
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_thread(thread, cx);
            app.add_right_panel_tab(conn_state::RightPanelTab::Browser, cx);
        })
    });
    render_frames(cx, window);
    let id = cx.update(|cx| {
        app.read(cx)
            .right_panel_tabs()
            .browser_ids()
            .last()
            .expect("a browser tab is open")
    });
    let page = cx
        .update(|cx| app.read(cx).browser_weak_for_test(id, cx))
        .expect("the shown tab has a browser");
    (id, page)
}

/// Shell events close no browser tabs. `thread.removed` is what the TypeScript server sends for
/// an archive as well as a delete, and the thread can come back; an archive, a workspace filter
/// and a server switch only change what the shell lists. The browser cap bounds what is left.
#[gpui_kit::test]
fn shell_events_close_no_browser_tabs(cx: &mut TestAppContext) {
    const PAGE: &str = "https://docs.example/";
    let (window, app) = mount_two_thread_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_thread("thread-selected", cx);
            app.open_browser_tab(PAGE.into(), false, cx);
        })
    });
    render_frames(cx, window);
    let tabs = cx.update(|cx| app.read(cx).right_panel_tabs().tabs().to_vec());
    let id = cx
        .update(|cx| app.read(cx).right_panel_tabs().browser_ids().last())
        .expect("a browser tab is open");
    let removed = cx
        .update(|cx| app.read(cx).browser_weak_for_test(id, cx))
        .expect("the shown tab has a browser");
    let (_, archived) = open_thread_browser(cx, window, &app, "thread-pinned");
    let (_, filtered) = open_thread_browser(cx, window, &app, "thread-other");
    let (_, shown) = open_thread_browser(cx, window, &app, "thread-waiting");
    let shell_thread = |cx: &mut TestAppContext, id: &str| {
        cx.update(|cx| app.read(cx).shell().find_thread(id).cloned())
            .expect("the thread is listed")
    };
    let (selected, pinned) = (
        shell_thread(cx, "thread-selected"),
        shell_thread(cx, "thread-pinned"),
    );

    // The TypeScript server archives with `thread.removed` (location active), then a restore
    // brings the thread back with `thread.updated`.
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.apply_event_for_test(thread_removed("thread-selected"), cx);
            app.apply_event_for_test(thread_updated(&selected, "active"), cx);
            app.apply_event_for_test(thread_archived(&pinned), cx);
            // The filter hides thread-other's project from the sidebar.
            app.select_workspace(Some("proj-parity".to_owned()), cx);
        })
    });
    render_frames(cx, window);
    assert!(removed.upgrade().is_some(), "thread.removed closes nothing");
    assert!(archived.upgrade().is_some(), "an archive closes nothing");
    assert!(
        filtered.upgrade().is_some(),
        "a workspace filter closes nothing"
    );
    cx.update(|cx| app.update(cx, |app, cx| app.select_thread("thread-selected", cx)));
    render_frames(cx, window);
    assert_eq!(
        cx.update(|cx| app.read(cx).right_panel_tabs().tabs().to_vec()),
        tabs,
        "the restored thread has its tabs"
    );
    assert_eq!(
        cx.update(|cx| app.read(cx).browser_target_for_test(id, cx))
            .as_deref(),
        Some(PAGE),
        "and its page"
    );

    // A server switch empties the shell and the selection.
    cx.update(|cx| app.update(cx, |app, cx| app.switch_server_state_for_test(cx)));
    render_frames(cx, window);
    for (page, what) in [
        (&removed, "restored"),
        (&archived, "archived"),
        (&filtered, "filtered"),
        (&shown, "shown"),
    ] {
        assert!(
            page.upgrade().is_some(),
            "a server switch closes nothing ({what})"
        );
    }
}

/// Runs one automation command as the automation socket does.
#[cfg(feature = "automation")]
fn automation(
    cx: &mut TestAppContext,
    window: AnyWindowHandle,
    app: &Entity<ConnApp>,
    cmd: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let weak = app.downgrade();
    let result = std::rc::Rc::new(std::cell::RefCell::new(None));
    let slot = result.clone();
    cx.spawn(move |mut acx| async move {
        let outcome = crate::automation::run(&weak, window, &cmd, &mut acx).await;
        *slot.borrow_mut() = Some(outcome);
    })
    .detach();
    cx.run_until_parked();
    let outcome = result.borrow_mut().take();
    outcome.expect("the command finished")
}

#[cfg(feature = "automation")]
fn preview_requests(
    cx: &mut TestAppContext,
    app: &Entity<ConnApp>,
    id: conn_state::BrowserTabId,
) -> Option<usize> {
    cx.update(|cx| {
        app.read(cx)
            .browser_weak_for_test(id, cx)
            .and_then(|weak| weak.upgrade())
            .map(|page| page.read(cx).preview_requests())
    })
}

/// Headless tests have no Chromium page, so a command that reaches a browser gets this from it.
#[cfg(feature = "automation")]
const NO_VIEW: &str = "No active browser view.";

/// Browser commands act on the shown thread's tabs only. A thread with no browser tab gets
/// "No browser tab is open." from every command, `browser-state` and `browser-title` included,
/// while another thread's page is alive and untouched.
#[cfg(feature = "automation")]
#[gpui_kit::test]
fn browser_commands_without_a_browser_tab_say_so(cx: &mut TestAppContext) {
    let (window, app) = mount_two_thread_app(cx);
    let (tab_a, _) = open_thread_browser(cx, window, &app, "thread-selected");
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_thread("thread-other", cx);
            app.select_right_panel_tab(conn_state::RightPanelTab::Files, cx);
        })
    });
    render_frames(cx, window);
    for cmd in [
        "browser-state",
        "browser-title",
        "browser-act",
        "browser-eval",
    ] {
        assert_eq!(
            automation(cx, window, &app, json!({ "cmd": cmd, "expression": "1" })),
            Err("No browser tab is open.".to_owned()),
            "{cmd}"
        );
    }
    assert_eq!(
        preview_requests(cx, &app, tab_a),
        Some(0),
        "A's page is untouched"
    );
}

/// A tab whose browser the cap closed is still the thread's tab. Back on that thread with Files
/// on top, `browser-act` makes its page again from the saved address and acts there.
#[cfg(feature = "automation")]
#[gpui_kit::test]
fn browser_act_reaches_an_evicted_tab_of_the_shown_thread(cx: &mut TestAppContext) {
    const PAGE: &str = "https://a.example/";
    let (window, app) = mount_two_thread_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_thread("thread-selected", cx);
            app.open_browser_tab(PAGE.into(), false, cx);
        })
    });
    render_frames(cx, window);
    let tab_a = cx
        .update(|cx| app.read(cx).right_panel_tabs().browser_ids().last())
        .expect("A has a browser tab");
    cx.update(|cx| app.update(cx, |app, cx| app.select_thread("thread-other", cx)));
    for n in 0..7 {
        cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.open_browser_tab(format!("https://b{n}.example/"), false, cx)
            })
        });
        render_frames(cx, window);
    }
    assert_eq!(
        preview_requests(cx, &app, tab_a),
        None,
        "seven of B's browsers evict A's"
    );

    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_thread("thread-selected", cx);
            app.select_right_panel_tab(conn_state::RightPanelTab::Files, cx);
        })
    });
    render_frames(cx, window);
    assert_eq!(
        automation(
            cx,
            window,
            &app,
            json!({ "cmd": "browser-act", "action": "click" })
        ),
        Err(NO_VIEW.to_owned()),
        "the command reaches a page, not the no-tab error"
    );
    assert_eq!(
        preview_requests(cx, &app, tab_a),
        Some(1),
        "A's recreated page took it"
    );
    assert_eq!(
        cx.update(|cx| app.read(cx).browser_target_for_test(tab_a, cx))
            .as_deref(),
        Some(PAGE),
        "it loads A's saved address"
    );
}

/// When the browser tab shown last closes, commands go to the thread's most recently shown
/// remaining browser tab (`previewStateStore` `removeSession`).
#[cfg(feature = "automation")]
#[gpui_kit::test]
fn browser_eval_falls_back_to_the_most_recent_remaining_tab(cx: &mut TestAppContext) {
    let (window, app) = mount_two_thread_app(cx);
    cx.update(|cx| app.update(cx, |app, cx| app.select_thread("thread-selected", cx)));
    let mut ids = Vec::new();
    for url in ["https://a.example/", "https://b.example/"] {
        cx.update(|cx| app.update(cx, |app, cx| app.open_browser_tab(url.into(), false, cx)));
        render_frames(cx, window);
        ids.push(
            cx.update(|cx| app.read(cx).right_panel_tabs().browser_ids().last())
                .expect("a browser tab is open"),
        );
    }
    let (a, b) = (ids[0], ids[1]);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_right_panel_tab(conn_state::RightPanelTab::Files, cx);
            app.close_right_panel_tab(&conn_state::PanelSurface::Browser(b), cx);
        })
    });
    render_frames(cx, window);
    assert_eq!(
        automation(
            cx,
            window,
            &app,
            json!({ "cmd": "browser-eval", "expression": "1" })
        ),
        Err(NO_VIEW.to_owned())
    );
    assert_eq!(
        preview_requests(cx, &app, a),
        Some(1),
        "A's page took the eval"
    );
}

/// `Cmd+T` opens the `+` menu, but not while a dialog such as Settings is open: the shortcut
/// leaves the keyboard where it is (`LAUNCHER_SHORTCUT_BLOCKING_LAYERS`).
#[gpui_kit::test]
fn cmd_t_does_nothing_while_settings_is_open(cx: &mut TestAppContext) {
    let (window, app) = mount_two_thread_app(cx);
    let _ = open_thread_browser(cx, window, &app, "thread-selected");
    let menu_open =
        |cx: &mut TestAppContext| cx.update(|cx| app.read(cx).right_panel_add_menu_open_for_test());
    let _ = cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| app.open_settings(window, cx));
        window.render_frame(cx);
    });
    let focused_before = cx
        .update_window(window, |_, window, cx| window.focused(cx))
        .ok()
        .flatten();
    press(cx, window, "cmd-t");
    assert!(!menu_open(cx), "the + menu stays shut behind Settings");
    let focused_after = cx
        .update_window(window, |_, window, cx| window.focused(cx))
        .ok()
        .flatten();
    assert_eq!(focused_after, focused_before, "Settings keeps the keyboard");

    let _ = cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| app.open_settings(window, cx));
        window.render_frame(cx);
    });
    press(cx, window, "cmd-t");
    assert!(
        menu_open(cx),
        "with Settings closed, Cmd+T opens the + menu"
    );
}

/// Browsers parked in tabs that do not show stay live up to a cap; past it the least recently
/// shown one closes. Its tab stays with address and title, and loads the page again when shown.
#[gpui_kit::test]
fn parked_browsers_beyond_the_cap_close_least_recently_shown_first(cx: &mut TestAppContext) {
    let (window, app) = mount_two_thread_app(cx);
    cx.update(|cx| app.update(cx, |app, cx| app.select_thread("thread-selected", cx)));
    // One shown and six parked fill the cap; the eighth tab pushes the first one out.
    let urls: Vec<String> = (1..=8)
        .map(|n| format!("https://page{n}.example/"))
        .collect();
    let mut pages = Vec::new();
    for url in &urls {
        cx.update(|cx| app.update(cx, |app, cx| app.open_browser_tab(url.clone(), false, cx)));
        render_frames(cx, window);
        let id = cx
            .update(|cx| app.read(cx).right_panel_tabs().browser_ids().last())
            .expect("a browser tab is open");
        let page = cx
            .update(|cx| app.read(cx).browser_weak_for_test(id, cx))
            .expect("the shown tab has a browser");
        pages.push((id, page));
    }
    assert!(
        pages[0].1.upgrade().is_none(),
        "the least recently shown browser closed"
    );
    assert!(pages[1..].iter().all(|(_, page)| page.upgrade().is_some()));
    assert_eq!(
        cx.update(|cx| app.read(cx).right_panel_tabs().browser_ids().count()),
        8,
        "every tab stays"
    );
    let (first, _) = pages[0];
    let title = cx.update(|cx| {
        app.read(cx)
            .right_panel_for_test()
            .read(cx)
            .browser_tab_title(first, cx)
    });
    assert_eq!(title, "page1.example", "the closed tab keeps its title");

    // Shown again, it loads its address in a new browser, and the next oldest closes.
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_right_panel_surface(conn_state::PanelSurface::Browser(first), cx)
        })
    });
    render_frames(cx, window);
    assert_eq!(
        cx.update(|cx| app.read(cx).browser_target_for_test(first, cx))
            .as_deref(),
        Some(urls[0].as_str())
    );
    assert!(
        pages[1].1.upgrade().is_none(),
        "now the second tab is the oldest"
    );
    assert!(pages[2..].iter().all(|(_, page)| page.upgrade().is_some()));
}

fn panel_request(value: serde_json::Value) -> conn_contract::AgentPanelRequest {
    match from_json(value) {
        Ok(request) => request,
        Err(err) => panic!("AgentPanelRequest failed: {err}"),
    }
}

/// A database the test never reaches: a SQLite file that does not exist.
fn unreachable_database() -> conn_desktop::database::api::PanelConnection {
    let mut connection = conn_desktop::database::api::new_connection(None);
    connection.name = "test".to_owned();
    connection.connection.driver = conn_desktop::database::DatabaseDriver::Sqlite;
    connection.connection.database = "/nonexistent/conn-thread-panel-test.sqlite".to_owned();
    connection
}

/// An agent's query for a thread the user is not looking at waits in that thread's Database
/// editor (`openDatabaseQuery`). It lands only once that thread shows, its project's
/// connections have loaded and one is chosen; an older Vault load answering late does not
/// count. Running it needs the panel on screen, so the agent hears where the query is.
#[gpui_kit::test]
fn a_background_database_query_waits_for_its_thread_and_connections(cx: &mut TestAppContext) {
    let (window, app) = mount_two_thread_app(cx);
    cx.update(|cx| app.update(cx, |app, cx| app.select_thread("thread-selected", cx)));
    render_frames(cx, window);
    let ask = |run: bool| {
        panel_request(json!({
            "requestId": "req-sql",
            "threadId": "thread-other",
            "panel": "database",
            "sql": "select 2",
            "run": run,
            "focusWindow": true,
        }))
    };
    let shown = cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.prepare_background_panel_for_test(&ask(false), cx)
        })
    });
    assert_eq!(shown, None);
    let ran = cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.prepare_background_panel_for_test(&ask(true), cx)
        })
    });
    assert_eq!(
        ran.as_deref(),
        Some("not on thread The query is in its Database panel.")
    );
    let database = cx.update(|cx| {
        app.read(cx)
            .right_panel_for_test()
            .read(cx)
            .database_for_test()
    });
    let other = cx.update(|cx| app.read(cx).panel_owner_for_test("thread-other"));
    cx.update(|cx| {
        let app = app.read(cx);
        assert_eq!(
            app.layout().selected_thread_id.as_deref(),
            Some("thread-selected"),
            "an agent never switches threads"
        );
        assert!(app.right_panel_tabs().tabs().is_empty());
        assert_eq!(
            database.read(cx).pending_sql_for_test(&other).as_deref(),
            Some("select 2")
        );
    });

    // Two Vault loads overlap, as a Refresh while the first still runs.
    let (first, second) = cx.update(|cx| {
        database.update(cx, |db, _| {
            (
                db.begin_vault_load_for_test(),
                db.begin_vault_load_for_test(),
            )
        })
    });
    cx.update(|cx| app.update(cx, |app, cx| app.select_thread("thread-other", cx)));
    render_frames(cx, window);
    cx.update(|cx| {
        let app = app.read(cx);
        assert!(app.layout().right_panel_open);
        assert_eq!(
            app.right_panel_tabs().active(),
            Some(&conn_state::PanelSurface::Kind(
                conn_state::RightPanelTab::Database
            ))
        );
    });
    let waiting =
        |cx: &mut TestAppContext| cx.update(|cx| database.read(cx).pending_sql_for_test(&other));
    assert!(waiting(cx).is_some(), "the connections are still loading");
    cx.update(|cx| {
        database.update(cx, |db, cx| {
            db.finish_vault_load_for_test(first, vec![unreachable_database()], cx)
        })
    });
    assert!(
        waiting(cx).is_some(),
        "the older load's answer does not count"
    );
    cx.update(|cx| {
        database.update(cx, |db, cx| {
            db.finish_vault_load_for_test(second, vec![unreachable_database()], cx)
        })
    });
    assert_eq!(waiting(cx), None);
    assert_eq!(
        cx.update(|cx| database.read(cx).sql_for_test()).as_deref(),
        Some("select 2"),
        "the query is in the chosen connection's editor"
    );
}

/// Each thread keeps its own right panel: tabs, open state, maximize, terminal drawer and
/// width. They survive switching threads, and a restart through the saved file.
#[gpui_kit::test]
fn each_thread_keeps_its_whole_right_panel_across_switches_and_restarts(cx: &mut TestAppContext) {
    let dir = std::env::temp_dir().join(format!(
        "conn-thread-panels-{}",
        crate::commands::new_thread_id()
    ));
    let path = dir.join("thread-panels.json");
    let (window, app) = mount_two_thread_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_thread_panels_path_for_test(path.clone(), cx);
            app.learn_primary_environment_for_test("env-a", cx);
            app.select_thread("thread-selected", cx);
            app.add_right_panel_tab(conn_state::RightPanelTab::Diff, cx);
            app.toggle_right_panel_maximized(cx);
            app.set_drawer_and_width_for_test(true, 820.0);
        })
    });
    render_frames(cx, window);
    cx.update(|cx| app.update(cx, |app, cx| app.select_thread("thread-other", cx)));
    render_frames(cx, window);
    cx.update(|cx| {
        let app = app.read(cx);
        assert!(!app.layout().right_panel_open && app.right_panel_tabs().tabs().is_empty());
        assert_eq!(
            app.right_panel_state_for_test(),
            (false, false, 820.0),
            "a thread never shown takes the width it finds"
        );
    });
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.add_right_panel_tab(conn_state::RightPanelTab::Files, cx);
            app.set_drawer_and_width_for_test(false, 640.0);
            app.select_thread("thread-selected", cx);
        })
    });
    let diff = conn_state::PanelSurface::Kind(conn_state::RightPanelTab::Diff);
    cx.update(|cx| {
        let app = app.read(cx);
        assert!(app.layout().right_panel_open);
        assert_eq!(app.right_panel_tabs().active(), Some(&diff));
        assert_eq!(app.right_panel_state_for_test(), (true, true, 820.0));
    });
    cx.update(|cx| app.update(cx, |app, cx| app.save_thread_panels_for_test(cx)));
    cx.run_until_parked();
    assert!(path.exists());

    // A restart: a new window reads the file.
    let (_, restarted) = mount_two_thread_app(cx);
    cx.update(|cx| {
        restarted.update(cx, |app, cx| {
            app.set_thread_panels_path_for_test(path.clone(), cx);
            app.learn_primary_environment_for_test("env-a", cx);
            app.select_thread("thread-other", cx);
        })
    });
    cx.update(|cx| {
        let app = restarted.read(cx);
        assert!(app.layout().right_panel_open);
        assert_eq!(
            app.right_panel_tabs().tabs(),
            [conn_state::PanelSurface::Kind(
                conn_state::RightPanelTab::Files
            )]
        );
        assert_eq!(app.right_panel_state_for_test(), (false, false, 640.0));
    });
    cx.update(|cx| restarted.update(cx, |app, cx| app.select_thread("thread-selected", cx)));
    cx.update(|cx| {
        let app = restarted.read(cx);
        assert_eq!(app.right_panel_tabs().active(), Some(&diff));
        assert_eq!(app.right_panel_state_for_test(), (true, true, 820.0));
    });
    let _ = std::fs::remove_dir_all(dir);
}

/// An agent on a linked environment reaches its own thread's panel (linked connections now
/// deliver every panel request) through the dispatch every request takes: on the thread the
/// user is looking at it opens there; on another thread it waits there. Neither switches.
#[gpui_kit::test]
fn a_linked_environments_agent_drives_its_own_threads_panel(cx: &mut TestAppContext) {
    let (window, app) = mount_two_thread_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.add_linked_shell_for_test(
                "mini",
                "mini",
                linked_mini_shell("/work/mini", "Mini diagnostics"),
                cx,
            );
            app.select_thread("thread-selected", cx);
        })
    });
    render_frames(cx, window);
    let linked_thread = cx.update(|cx| {
        app.read(cx)
            .shell()
            .threads
            .iter()
            .find(|t| t.title == "Mini diagnostics")
            .map(|t| t.id.clone())
            .expect("the linked thread is listed")
    });
    let request = |panel: &str| {
        panel_request(json!({
            "requestId": format!("req-{panel}"),
            "threadId": linked_thread,
            "panel": panel,
            "focusWindow": true,
        }))
    };
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            drop(app.dispatch_agent_panel_request_for_test(request("diff"), Some("mini"), cx))
        })
    });
    render_frames(cx, window);
    cx.update(|cx| {
        let app = app.read(cx);
        assert_eq!(
            app.layout().selected_thread_id.as_deref(),
            Some("thread-selected")
        );
        assert!(
            app.right_panel_tabs().tabs().is_empty(),
            "the shown thread's panel is untouched"
        );
    });
    cx.update(|cx| app.update(cx, |app, cx| app.select_thread(linked_thread.clone(), cx)));
    render_frames(cx, window);
    let files = conn_state::PanelSurface::Kind(conn_state::RightPanelTab::Files);
    let diff = conn_state::PanelSurface::Kind(conn_state::RightPanelTab::Diff);
    cx.update(|cx| {
        let app = app.read(cx);
        assert!(app.layout().right_panel_open);
        assert_eq!(
            app.right_panel_tabs().tabs(),
            std::slice::from_ref(&diff),
            "it waited here"
        );
    });
    // On the shown linked thread it opens at once.
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            drop(app.dispatch_agent_panel_request_for_test(request("files"), Some("mini"), cx))
        })
    });
    render_frames(cx, window);
    cx.update(|cx| {
        let app = app.read(cx);
        assert_eq!(app.right_panel_tabs().active(), Some(&files));
        assert_eq!(
            app.layout().selected_thread_id.as_deref(),
            Some(linked_thread.as_str())
        );
    });
}

/// Two environments hold thread id `T` (`a_thread_id_two_environments_hold_belongs_to_the_first`
/// in conn-state's `environments.rs`): the sidebar lists the primary's `T`. A linked agent's
/// request for its own `T`, even `run: true` SQL while the primary `T` shows, never reaches the
/// primary `T`'s panel or its Database editor; the same request from the primary does.
#[gpui_kit::test]
fn a_linked_agent_never_drives_the_primary_thread_with_the_same_id(cx: &mut TestAppContext) {
    let (window, app) = mount_two_thread_app(cx);
    let mut mini = linked_mini_shell("/work/mini", "Mini's copy");
    mini.threads[0].id = "thread-selected".to_owned();
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.add_linked_shell_for_test("mini", "mini", mini, cx);
            app.learn_primary_environment_for_test("nick", cx);
            app.select_thread("thread-selected", cx);
        })
    });
    render_frames(cx, window);
    let primary = cx.update(|cx| {
        let app = app.read(cx);
        assert_eq!(
            app.shell()
                .threads
                .iter()
                .filter(|t| t.id == "thread-selected")
                .map(|t| t.title.as_str())
                .collect::<Vec<_>>(),
            ["Selected kitchen-sink thread"],
            "the primary's T is the one listed"
        );
        app.panel_owner_for_test("thread-selected")
    });
    let linked = conn_state::PanelOwner::new("mini", "thread-selected");
    assert_ne!(primary, linked);
    let database = cx.update(|cx| {
        app.read(cx)
            .right_panel_for_test()
            .read(cx)
            .database_for_test()
    });
    let ask = |id: &str| {
        panel_request(json!({
            "requestId": id,
            "threadId": "thread-selected",
            "panel": "database",
            "sql": "select secret",
            "run": true,
            "focusWindow": true,
        }))
    };
    let mut answer = cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.dispatch_agent_panel_request_for_test(ask("from-mini"), Some("mini"), cx)
        })
    });
    render_frames(cx, window);
    let response = answer.try_recv().expect("the dispatch answered");
    assert!(!response.panel.ok);
    assert!(response.panel.database.is_none(), "nothing ran");
    assert!(
        response
            .panel
            .error
            .as_deref()
            .is_some_and(|e| e.ends_with("The query is in its Database panel.")),
        "{:?}",
        response.panel.error
    );
    cx.update(|cx| {
        let app = app.read(cx);
        assert!(
            app.right_panel_tabs().tabs().is_empty() && !app.layout().right_panel_open,
            "the primary T's panel is untouched"
        );
        let db = database.read(cx);
        assert_eq!(db.pending_sql_for_test(&primary), None);
        assert_eq!(
            db.pending_sql_for_test(&linked).as_deref(),
            Some("select secret"),
            "it waits in the linked T's own editor"
        );
    });

    // The primary's agent drives its own T at once.
    let request = panel_request(json!({
        "requestId": "from-primary",
        "threadId": "thread-selected",
        "panel": "diff",
        "focusWindow": true,
    }));
    let mut answer = cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.dispatch_agent_panel_request_for_test(request, None, cx)
        })
    });
    render_frames(cx, window);
    assert!(answer.try_recv().expect("answered").panel.ok);
    cx.update(|cx| {
        assert_eq!(
            app.read(cx).right_panel_tabs().active(),
            Some(&conn_state::PanelSurface::Kind(
                conn_state::RightPanelTab::Diff
            ))
        );
    });
}

/// Past the cap of waiting queries, a new thread's query is refused with a reason; the queries
/// already accepted all stay.
#[gpui_kit::test]
fn the_thirty_third_waiting_query_is_refused_and_the_first_kept(cx: &mut TestAppContext) {
    let (window, app) = mount_two_thread_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.learn_primary_environment_for_test("nick", cx);
            app.select_thread("thread-selected", cx)
        })
    });
    render_frames(cx, window);
    let ask = |thread: String| {
        panel_request(json!({
            "requestId": format!("req-{thread}"),
            "threadId": thread,
            "panel": "database",
            "sql": format!("select '{thread}'"),
            "focusWindow": false,
        }))
    };
    let mut answers = Vec::new();
    for index in 0..33 {
        let rx = cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.dispatch_agent_panel_request_for_test(ask(format!("t{index}")), None, cx)
            })
        });
        render_frames(cx, window);
        answers.push(rx);
    }
    let outcomes: Vec<_> = answers
        .iter_mut()
        .map(|rx| rx.try_recv().expect("answered").panel)
        .collect();
    assert!(outcomes[..32].iter().all(|panel| panel.ok));
    let refused = &outcomes[32];
    assert!(!refused.ok);
    assert_eq!(
        refused.error.as_deref(),
        Some(crate::panels::TOO_MANY_PENDING_QUERIES)
    );
    let (first, last) = cx.update(|cx| {
        let app = app.read(cx);
        (
            app.panel_owner_for_test("t0"),
            app.panel_owner_for_test("t32"),
        )
    });
    cx.update(|cx| {
        let database = app
            .read(cx)
            .right_panel_for_test()
            .read(cx)
            .database_for_test();
        let db = database.read(cx);
        assert_eq!(
            db.pending_sql_for_test(&first).as_deref(),
            Some("select 't0'")
        );
        assert_eq!(db.pending_sql_for_test(&last), None);
    });
}

/// A browser tab's address is saved when its page navigates, not only on panel actions, so a
/// restart reopens the page the tab was on. Saves wait for a pause and write off the UI
/// thread: a burst of navigations is one write.
#[gpui_kit::test]
fn a_browser_tab_reopens_on_the_page_it_navigated_to(cx: &mut TestAppContext) {
    let dir = std::env::temp_dir().join(format!(
        "conn-thread-panels-{}",
        crate::commands::new_thread_id()
    ));
    let path = dir.join("thread-panels.json");
    let (window, app) = mount_two_thread_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_thread_panels_path_for_test(path.clone(), cx);
            app.learn_primary_environment_for_test("env-a", cx);
            app.select_thread("thread-selected", cx);
            app.open_browser_tab("https://first.example/".into(), false, cx);
        })
    });
    render_frames(cx, window);
    let settle = |cx: &mut TestAppContext, ms: u64| {
        cx.executor()
            .advance_clock(std::time::Duration::from_millis(ms));
        cx.run_until_parked();
    };
    settle(cx, 1_000);
    let writes =
        |cx: &mut TestAppContext| cx.update(|cx| app.read(cx).thread_panel_writes_for_test());
    let before = writes(cx);
    assert!(before >= 1, "opening the tab was saved");
    let id = cx.update(|cx| {
        app.read(cx)
            .right_panel_tabs()
            .last_browser()
            .expect("a browser tab")
    });
    let page = cx
        .update(|cx| app.read(cx).browser_weak_for_test(id, cx))
        .and_then(|page| page.upgrade())
        .expect("the tab's page");
    // Links and redirects commit pages in quick succession; no panel action follows.
    for step in 1..=5 {
        cx.update(|cx| {
            page.update(cx, |page, cx| {
                page.commit_url_for_test(&format!("https://second.example/{step}"), cx)
            })
        });
        settle(cx, 100);
    }
    assert_eq!(writes(cx), before, "nothing is written during the burst");
    settle(cx, 600);
    assert_eq!(writes(cx), before + 1, "one write after it");
    let saved = std::fs::read_to_string(&path).expect("the layout was saved");
    assert!(saved.contains("https://second.example/5"), "{saved}");

    let (restart_window, restarted) = mount_two_thread_app(cx);
    cx.update(|cx| {
        restarted.update(cx, |app, cx| {
            app.set_thread_panels_path_for_test(path.clone(), cx);
            app.learn_primary_environment_for_test("env-a", cx);
            app.select_thread("thread-selected", cx);
        })
    });
    render_frames(cx, restart_window);
    let target = cx.update(|cx| {
        let app = restarted.read(cx);
        let id = app.right_panel_tabs().last_browser().expect("restored tab");
        app.browser_target_for_test(id, cx)
    });
    assert_eq!(target.as_deref(), Some("https://second.example/5"));
    let _ = std::fs::remove_dir_all(dir);
}

/// The primary's panels are keyed by the environment id it reported last, saved with the
/// layout. At launch that id keys them at once; the same id confirmed changes nothing, another
/// id is another server that starts fresh while the old one's panels stay saved.
#[gpui_kit::test]
fn the_primary_keeps_its_panels_by_its_last_environment_id(cx: &mut TestAppContext) {
    let dir = std::env::temp_dir().join(format!(
        "conn-thread-panels-{}",
        crate::commands::new_thread_id()
    ));
    let path = dir.join("thread-panels.json");
    let diff = conn_state::PanelSurface::Kind(conn_state::RightPanelTab::Diff);
    let (window, app) = mount_two_thread_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_thread_panels_path_for_test(path.clone(), cx);
            app.learn_primary_environment_for_test("env-a", cx);
            app.select_thread("thread-selected", cx);
            app.add_right_panel_tab(conn_state::RightPanelTab::Diff, cx);
            app.save_thread_panels_for_test(cx);
        })
    });
    cx.run_until_parked();

    // A relaunch: the panels show from the saved id before any snapshot.
    let relaunch = |cx: &mut TestAppContext| {
        let (window, app) = mount_two_thread_app(cx);
        cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.set_thread_panels_path_for_test(path.clone(), cx);
                app.select_thread("thread-selected", cx);
            })
        });
        render_frames(cx, window);
        app
    };
    let tabs = |cx: &mut TestAppContext, app: &Entity<ConnApp>| {
        cx.update(|cx| app.read(cx).right_panel_tabs().tabs().to_vec())
    };
    let same = relaunch(cx);
    assert_eq!(
        tabs(cx, &same),
        std::slice::from_ref(&diff),
        "from the saved id"
    );
    cx.update(|cx| {
        same.update(cx, |app, cx| {
            app.learn_primary_environment_for_test("env-a", cx)
        })
    });
    assert_eq!(
        tabs(cx, &same),
        std::slice::from_ref(&diff),
        "confirming it changes nothing"
    );

    let other = relaunch(cx);
    cx.update(|cx| {
        other.update(cx, |app, cx| {
            app.learn_primary_environment_for_test("env-b", cx);
            app.save_thread_panels_for_test(cx);
        })
    });
    cx.run_until_parked();
    assert!(tabs(cx, &other).is_empty(), "another server starts fresh");
    let saved = std::fs::read_to_string(&path).expect("saved");
    assert!(
        saved.contains("\"primaryEnvironment\":\"env-b\""),
        "{saved}"
    );
    assert!(
        saved.contains("\"environment\":\"env-a\""),
        "the old server's panels stay saved under its id: {saved}"
    );
    let _ = window;
    let _ = std::fs::remove_dir_all(dir);
}

/// An agent's request for the primary is refused, with a reason to retry, until the server
/// confirmed its environment id on this connection: before the first snapshot, and again after
/// a reconnect until the next one. It is never filed under the id from before.
#[gpui_kit::test]
fn the_primarys_agent_requests_wait_for_the_server_to_say_who_it_is(cx: &mut TestAppContext) {
    let (window, app) = mount_two_thread_app(cx);
    cx.update(|cx| app.update(cx, |app, cx| app.select_thread("thread-selected", cx)));
    render_frames(cx, window);
    let ask = |id: &str| {
        panel_request(json!({
            "requestId": id,
            "threadId": "thread-other",
            "panel": "database",
            "sql": "select 1",
            "focusWindow": false,
        }))
    };
    let send = |cx: &mut TestAppContext, id: &str| {
        let mut rx = cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.dispatch_agent_panel_request_for_test(ask(id), None, cx)
            })
        });
        render_frames(cx, window);
        rx.try_recv().expect("answered").panel
    };
    let database = cx.update(|cx| {
        app.read(cx)
            .right_panel_for_test()
            .read(cx)
            .database_for_test()
    });
    let waiting = |cx: &mut TestAppContext, environment: &str| {
        cx.update(|cx| {
            database
                .read(cx)
                .pending_sql_for_test(&conn_state::PanelOwner::new(environment, "thread-other"))
        })
    };

    let early = send(cx, "before-snapshot");
    assert!(!early.ok);
    assert_eq!(early.error.as_deref(), Some(crate::app::PRIMARY_NOT_READY));
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.learn_primary_environment_for_test("env-a", cx)
        })
    });
    assert!(send(cx, "confirmed").ok);
    assert_eq!(waiting(cx, "env-a").as_deref(), Some("select 1"));

    // A reconnect reaches server B; until B's snapshot, nothing is filed under A.
    cx.update(|cx| app.update(cx, |app, cx| app.primary_disconnected_for_test(cx)));
    let after = send(cx, "after-reconnect");
    assert_eq!(after.error.as_deref(), Some(crate::app::PRIMARY_NOT_READY));
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.learn_primary_environment_for_test("env-b", cx)
        })
    });
    let filed = send(cx, "on-b");
    assert!(filed.ok);
    assert_eq!(waiting(cx, "env-b").as_deref(), Some("select 1"));
    cx.update(|cx| {
        assert_eq!(
            app.read(cx).panel_owner_for_test("thread-other"),
            conn_state::PanelOwner::new("env-b", "thread-other")
        );
    });
}

/// A `thread-panels.json` of another format (an earlier build's) is set aside once as `.bak`,
/// and the panels start empty.
#[gpui_kit::test]
fn an_old_layout_file_is_set_aside_and_panels_start_empty(cx: &mut TestAppContext) {
    let dir = std::env::temp_dir().join(format!(
        "conn-thread-panels-{}",
        crate::commands::new_thread_id()
    ));
    std::fs::create_dir_all(&dir).expect("a temp folder");
    let path = dir.join("thread-panels.json");
    let old = r#"{"threads":[{"owner":"thread-selected","open":true,"tabs":[{"kind":"panel","tab":"files"}],"active":0}]}"#;
    std::fs::write(&path, old).expect("the old file");
    let (window, app) = mount_two_thread_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_thread_panels_path_for_test(path.clone(), cx);
            app.select_thread("thread-selected", cx);
        })
    });
    render_frames(cx, window);
    assert!(cx.update(|cx| app.read(cx).right_panel_tabs().tabs().is_empty()));
    assert!(!path.exists());
    assert_eq!(
        std::fs::read_to_string(dir.join("thread-panels.json.bak"))
            .as_deref()
            .ok(),
        Some(old)
    );
    let _ = std::fs::remove_dir_all(dir);
}

/// Quitting while a write is in flight loses nothing: the write finishes, and the layout
/// changed since is written after it.
#[gpui_kit::test]
fn quitting_during_a_write_leaves_the_final_layout_on_disk(cx: &mut TestAppContext) {
    let dir = std::env::temp_dir().join(format!(
        "conn-thread-panels-{}",
        crate::commands::new_thread_id()
    ));
    let path = dir.join("thread-panels.json");
    let (window, app) = mount_two_thread_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_thread_panels_path_for_test(path.clone(), cx);
            app.learn_primary_environment_for_test("env-a", cx);
            app.select_thread("thread-selected", cx);
            app.add_right_panel_tab(conn_state::RightPanelTab::Diff, cx);
            app.save_thread_panels_for_test(cx);
            assert!(app.thread_panel_write_in_flight_for_test());
            // A change lands while that write runs.
            app.add_right_panel_tab(conn_state::RightPanelTab::Files, cx);
        })
    });
    let _ = window;
    cx.quit();
    let saved = std::fs::read_to_string(&path).expect("written before quitting");
    let saved = conn_state::SavedThreadPanels::from_json(&saved).expect("this format");
    let tabs: Vec<_> = saved.threads[0].tabs.clone();
    assert_eq!(
        tabs,
        [
            conn_state::SavedSurface::Panel {
                tab: conn_state::RightPanelTab::Diff
            },
            conn_state::SavedSurface::Panel {
                tab: conn_state::RightPanelTab::Files
            },
        ],
        "the final layout"
    );
    let _ = std::fs::remove_dir_all(dir);
}

/// A linked thread's project is on another machine. When this Mac has a checkout with a
/// `.env` at the same path, that is not the thread's database: the panel offers no `.env`
/// connection for it, and an agent's SQL with no connection chosen for that environment is
/// refused, never run against the local database.
#[gpui_kit::test]
fn a_linked_threads_sql_never_uses_this_macs_env(cx: &mut TestAppContext) {
    let root = std::env::temp_dir().join(format!(
        "conn-linked-env-{}",
        crate::commands::new_thread_id()
    ));
    std::fs::create_dir_all(&root).expect("a temp checkout");
    std::fs::write(
        root.join(".env"),
        "DB_CONNECTION=sqlite\nDB_DATABASE=/nonexistent/local-only.sqlite\n",
    )
    .expect("a local .env");
    let root_text = root.to_string_lossy().into_owned();
    let (window, app) = mount_two_thread_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.add_linked_shell_for_test(
                "mini",
                "mini",
                linked_mini_shell(&root_text, "Mini database work"),
                cx,
            );
            app.select_thread("thread-mini", cx);
        })
    });
    render_frames(cx, window);
    let database = cx.update(|cx| {
        app.read(cx)
            .right_panel_for_test()
            .read(cx)
            .database_for_test()
    });
    assert!(
        !cx.update(|cx| database.read(cx).offers_env_connection_for_test()),
        "no connection from this Mac's .env"
    );
    let mut answer = cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.dispatch_agent_panel_request_for_test(
                panel_request(json!({
                    "requestId": "linked-sql",
                    "threadId": "thread-mini",
                    "panel": "database",
                    "sql": "select * from users",
                    "run": true,
                    "focusWindow": false,
                })),
                Some("mini"),
                cx,
            )
        })
    });
    render_frames(cx, window);
    let response = answer.try_recv().expect("answered").panel;
    assert!(!response.ok);
    assert!(response.database.is_none(), "nothing ran");
    assert_eq!(
        response.error.as_deref(),
        Some(crate::panels::NO_LINKED_CONNECTION)
    );
    assert_eq!(
        cx.update(|cx| database.read(cx).sql_for_test()),
        None,
        "no connection is chosen"
    );

    // The same checkout for a thread on this Mac offers its .env, so the fixture is a real one.
    cx.update(|cx| {
        database.update(cx, |db, cx| {
            db.set_linked_environment(None);
            db.set_project(Some("proj-mini".into()), Some(root_text.clone()), cx);
        })
    });
    assert!(cx.update(|cx| database.read(cx).offers_env_connection_for_test()));
    let _ = std::fs::remove_dir_all(root);
}

/// Switching to a thread whose panel is closed, with its browser tab selected, runs no
/// annotation script in that browser, even when Watch changed meanwhile.
#[gpui_kit::test]
fn a_closed_panels_browser_gets_no_annotation_script(cx: &mut TestAppContext) {
    let (window, app) = mount_two_thread_app(cx);
    let (_, page_b) = open_thread_browser(cx, window, &app, "thread-other");
    cx.update(|cx| app.update(cx, |app, cx| app.toggle_right_panel(cx)));
    let (_, _page_a) = open_thread_browser(cx, window, &app, "thread-selected");
    let scripts = |cx: &mut TestAppContext| {
        cx.update(|cx| page_b.upgrade().map(|p| p.read(cx).annotation_scripts()))
            .expect("B's page is alive")
    };
    let before = scripts(cx);
    // Watch changes while A shows.
    cx.update(|cx| {
        let panel = app.read(cx).right_panel_for_test().clone();
        panel.update(cx, |p, cx| p.set_annotations(Vec::new(), true, true, cx));
    });
    cx.update(|cx| app.update(cx, |app, cx| app.select_thread("thread-other", cx)));
    render_frames(cx, window);
    assert!(!cx.update(|cx| app.read(cx).layout().right_panel_open));
    assert_eq!(
        scripts(cx),
        before,
        "a closed panel's browser runs no script"
    );
    cx.update(|cx| {
        let panel = app.read(cx).right_panel_for_test().clone();
        panel.update(cx, |p, cx| p.set_annotations(Vec::new(), false, false, cx));
    });
    assert_eq!(scripts(cx), before, "nor while its panel stays closed");

    cx.update(|cx| app.update(cx, |app, cx| app.toggle_right_panel(cx)));
    render_frames(cx, window);
    let visible = cx.update(|cx| page_b.upgrade().map(|p| p.read(cx).visible_for_test()));
    assert_eq!(visible, Some(true), "opening the panel shows B's page");
}

/// Annotation and project syncs reach only the browser on screen, and only when they changed.
/// A hidden thread's page keeps its own project and catches up when it shows.
#[gpui_kit::test]
fn hidden_browsers_get_no_annotation_scripts(cx: &mut TestAppContext) {
    let (window, app) = mount_two_thread_app(cx);
    let (_, parity) = open_thread_browser(cx, window, &app, "thread-selected");
    let (_, other) = open_thread_browser(cx, window, &app, "thread-other");
    let scripts = |cx: &mut TestAppContext, page: &gpui_kit::WeakEntity<_>| {
        cx.update(|cx| {
            page.upgrade()
                .map(|p: Entity<crate::panels::BrowserPanelHandle>| p.read(cx).annotation_scripts())
        })
        .expect("the page is alive")
    };
    let project = |cx: &mut TestAppContext, page: &gpui_kit::WeakEntity<_>| {
        cx.update(|cx| {
            page.upgrade()
                .map(|p: Entity<crate::panels::BrowserPanelHandle>| {
                    p.read(cx).project_for_test().map(str::to_owned)
                })
        })
        .expect("the page is alive")
    };
    let push = |cx: &mut TestAppContext, watching: bool| {
        cx.update(|cx| {
            let panel = app.read(cx).right_panel_for_test().clone();
            panel.update(cx, |p, cx| {
                p.set_annotations(Vec::new(), watching, true, cx)
            });
        });
    };
    assert_eq!(project(cx, &parity).as_deref(), Some("proj-parity"));
    assert_eq!(project(cx, &other).as_deref(), Some("proj-other"));
    let (hidden_before, shown_before) = (scripts(cx, &parity), scripts(cx, &other));

    push(cx, true);
    assert_eq!(
        scripts(cx, &parity),
        hidden_before,
        "a hidden page runs no script"
    );
    assert_eq!(
        scripts(cx, &other),
        shown_before + 1,
        "the shown page hears the change"
    );
    push(cx, true);
    assert_eq!(
        scripts(cx, &other),
        shown_before + 1,
        "an unchanged queue runs no script"
    );
    assert_eq!(
        project(cx, &parity).as_deref(),
        Some("proj-parity"),
        "nor does it move projects"
    );

    // A page that finishes loading while hidden gets no bridge or overlay until it shows.
    let injections = |cx: &mut TestAppContext, page: &gpui_kit::WeakEntity<_>| {
        cx.update(|cx| {
            page.upgrade()
                .map(|p: Entity<crate::panels::BrowserPanelHandle>| {
                    p.read(cx).injections_for_test()
                })
        })
        .expect("the page is alive")
    };
    let load_end = |cx: &mut TestAppContext, page: &gpui_kit::WeakEntity<_>| {
        cx.update(|cx| {
            if let Some(p) = page.upgrade() {
                let p: Entity<crate::panels::BrowserPanelHandle> = p;
                p.update(cx, |p, cx| p.load_end_for_test(cx));
            }
        });
    };
    // The same holds for the debug bar's host script on load start.
    let host_scripts = |cx: &mut TestAppContext, page: &gpui_kit::WeakEntity<_>| {
        cx.update(|cx| {
            page.upgrade()
                .map(|p: Entity<crate::panels::BrowserPanelHandle>| {
                    p.read(cx).host_scripts_for_test()
                })
        })
        .expect("the page is alive")
    };
    let load_start = |cx: &mut TestAppContext, page: &gpui_kit::WeakEntity<_>| {
        cx.update(|cx| {
            if let Some(p) = page.upgrade() {
                let p: Entity<crate::panels::BrowserPanelHandle> = p;
                p.update(cx, |p, cx| p.load_start_for_test(cx));
            }
        });
    };
    let hidden_hosts = host_scripts(cx, &parity);
    load_start(cx, &parity);
    assert_eq!(
        host_scripts(cx, &parity),
        hidden_hosts,
        "a hidden page that starts loading runs no host script"
    );
    let shown_hosts = host_scripts(cx, &other);
    load_start(cx, &other);
    assert_eq!(
        host_scripts(cx, &other),
        shown_hosts + 1,
        "a shown page gets its host script on load start"
    );

    let (bridge_before, overlay_before) = injections(cx, &parity);
    load_end(cx, &parity);
    assert_eq!(
        injections(cx, &parity),
        (bridge_before, overlay_before),
        "a hidden page that loads runs no bridge or overlay"
    );
    let shown_injections = injections(cx, &other);
    load_end(cx, &other);
    assert_eq!(
        injections(cx, &other).0,
        shown_injections.0 + 1,
        "a shown page gets its bridge on load"
    );

    cx.update(|cx| app.update(cx, |app, cx| app.select_thread("thread-selected", cx)));
    render_frames(cx, window);
    assert_eq!(
        injections(cx, &parity).0,
        bridge_before + 1,
        "the hidden page takes its bridge once it shows"
    );
    assert_eq!(
        host_scripts(cx, &parity),
        hidden_hosts + 1,
        "and its host script, once"
    );
    assert_eq!(project(cx, &parity).as_deref(), Some("proj-parity"));
    assert!(
        scripts(cx, &parity) > hidden_before,
        "the page catches up on the queue once it shows"
    );
    assert_eq!(project(cx, &other).as_deref(), Some("proj-other"));
}

/// A thread with no tabs shows the launcher, never another thread's browser.
#[gpui_kit::test]
fn an_empty_thread_never_shows_another_threads_browser(cx: &mut TestAppContext) {
    let (window, app) = mount_two_thread_app(cx);
    let (_, page_a) = open_thread_browser(cx, window, &app, "thread-selected");
    // B opens and closes a browser tab, so Browser is its last tab kind with none left.
    let (b_tab, _) = open_thread_browser(cx, window, &app, "thread-other");
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.close_right_panel_tab(&conn_state::PanelSurface::Browser(b_tab), cx);
            app.toggle_right_panel(cx);
            // The next chat sync (any batch from the server) pushes the panel's surface.
            app.select_thread("thread-other", cx);
        })
    });
    render_frames(cx, window);
    assert!(cx.update(|cx| app.read(cx).right_panel_shows_launcher_for_test()));
    let visible = cx.update(|cx| page_a.upgrade().map(|p| p.read(cx).visible_for_test()));
    assert_eq!(
        visible,
        Some(false),
        "A's page stays hidden behind B's launcher"
    );
}

/// A discarded draft's browser stays while `Undo` can bring the draft back, and goes when the
/// notice expires.
#[gpui_kit::test]
fn a_discarded_drafts_browser_goes_when_undo_expires(cx: &mut TestAppContext) {
    let (window, app) = mount_two_thread_app(cx);
    let _ = cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| {
            app.start_new_thread(Some("proj-other".to_owned()), Some(window), cx);
        });
    });
    type_into_composer(cx, window, &app, "draft with a page");
    let draft = cx
        .update(|cx| app.read(cx).open_draft_id_for_test())
        .expect("the draft is open");
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.add_right_panel_tab(conn_state::RightPanelTab::Browser, cx)
        })
    });
    render_frames(cx, window);
    let id = cx
        .update(|cx| app.read(cx).right_panel_tabs().browser_ids().last())
        .expect("the draft has a browser tab");
    let page = cx
        .update(|cx| app.read(cx).browser_weak_for_test(id, cx))
        .expect("the shown tab has a browser");

    let _ = cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| app.discard_draft_row(&draft, window, cx));
    });
    render_frames(cx, window);
    assert!(
        page.upgrade().is_some(),
        "Undo can still bring the draft and its page back"
    );

    cx.executor()
        .advance_clock(Duration::from_secs(conn_state::DISCARD_UNDO_SECS + 1));
    render_frames(cx, window);
    assert!(
        page.upgrade().is_none(),
        "an expired discard releases the draft's browser"
    );
}

// ---- the workspace rail: drag to reorder, right-click menu, remove ----

fn rail_workspace(id: &str, name: &str) -> conn_desktop::orbit::OrbitWorkspace {
    conn_desktop::orbit::OrbitWorkspace {
        id: id.to_owned(),
        name: name.to_owned(),
        color: "#3b82f6".to_owned(),
        icon: None,
        image: None,
        project_refs: Vec::new(),
        project_keys: Vec::new(),
    }
}

fn mount_rail(cx: &mut TestAppContext) -> (AnyWindowHandle, Entity<ConnApp>) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_rail_workspaces_for_test(
                vec![
                    rail_workspace("ws-a", "Alpha"),
                    rail_workspace("ws-b", "Beta"),
                    rail_workspace("ws-c", "Gamma"),
                ],
                cx,
            );
        });
    });
    render_twice(cx, window);
    (window, app)
}

fn rail_ids(cx: &mut TestAppContext, app: &Entity<ConnApp>) -> Vec<String> {
    cx.read(|cx| app.read(cx).rail_workspace_ids_for_test())
}

#[gpui_kit::test]
fn dragging_a_workspace_tile_makes_room_and_a_drop_reorders_the_rail(cx: &mut TestAppContext) {
    let (window, app) = mount_rail(cx);
    let alpha = row_center(cx, window, "Workspace Alpha");
    let gamma = row_center(cx, window, "Workspace Gamma");

    drag_row(cx, window, alpha, gamma);
    assert_eq!(
        cx.read(|cx| app.read(cx).rail_held_for_test()),
        Some(("ws-a".to_owned(), "ws-c".to_owned())),
        "held over Gamma's place"
    );
    assert!(
        !labelled(cx, window, "Workspace Alpha"),
        "the held tile has left its place for the pointer to carry"
    );
    assert_eq!(
        rail_ids(cx, &app),
        ["ws-a", "ws-b", "ws-c"],
        "nothing is saved yet"
    );

    release(cx, window, gamma);
    assert_eq!(rail_ids(cx, &app), ["ws-b", "ws-c", "ws-a"]);
    assert!(cx.read(|cx| app.read(cx).rail_held_for_test()).is_none());
    assert_eq!(
        cx.read(|cx| app.read(cx).active_workspace_for_test().map(str::to_owned)),
        None,
        "the click that ends a drag selects nothing"
    );
    let first = row_center(cx, window, "Workspace Beta");
    let last = row_center(cx, window, "Workspace Alpha");
    assert!(first.y < last.y, "the rail draws the new order");
}

#[gpui_kit::test]
fn a_press_that_moves_less_than_six_pixels_selects_the_workspace(cx: &mut TestAppContext) {
    let (window, app) = mount_rail(cx);
    let beta = row_center(cx, window, "Workspace Beta");
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_move(beta, None, cx);
        window.pointer_down(beta, MouseButton::Left, cx);
        window.pointer_move(
            Point {
                x: beta.x,
                y: beta.y + px(4.0),
            },
            Some(MouseButton::Left),
            cx,
        );
        window.pointer_up(beta, MouseButton::Left, cx);
        window.render_frame(cx);
    });
    assert!(cx.read(|cx| app.read(cx).rail_held_for_test()).is_none());
    assert_eq!(rail_ids(cx, &app), ["ws-a", "ws-b", "ws-c"]);
    assert_eq!(
        cx.read(|cx| app.read(cx).active_workspace_for_test().map(str::to_owned)),
        Some("ws-b".to_owned()),
        "a click still selects"
    );
}

#[gpui_kit::test]
fn escape_lets_go_of_a_held_workspace_tile_without_a_drop(cx: &mut TestAppContext) {
    let (window, app) = mount_rail(cx);
    let alpha = row_center(cx, window, "Workspace Alpha");
    let gamma = row_center(cx, window, "Workspace Gamma");
    drag_row(cx, window, alpha, gamma);
    assert!(cx.read(|cx| app.read(cx).rail_held_for_test()).is_some());
    press(cx, window, "escape");
    assert!(cx.read(|cx| app.read(cx).rail_held_for_test()).is_none());
    release(cx, window, gamma);
    assert_eq!(
        rail_ids(cx, &app),
        ["ws-a", "ws-b", "ws-c"],
        "nothing moved"
    );
    assert!(labelled(cx, window, "Workspace Alpha"), "the tile is back");
}

#[gpui_kit::test]
fn a_lone_workspace_has_nothing_to_reorder(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_rail_workspaces_for_test(vec![rail_workspace("ws-a", "Alpha")], cx);
        });
    });
    render_twice(cx, window);
    let alpha = row_center(cx, window, "Workspace Alpha");
    drag_row(
        cx,
        window,
        alpha,
        Point {
            x: alpha.x,
            y: alpha.y + px(120.0),
        },
    );
    assert!(cx.read(|cx| app.read(cx).rail_held_for_test()).is_none());
    release(cx, window, alpha);
}

#[gpui_kit::test]
fn right_clicking_a_workspace_tile_offers_remove_workspace(cx: &mut TestAppContext) {
    let (window, app) = mount_rail(cx);
    click_row(cx, window, "Workspace Beta", MouseButton::Right);
    assert!(cx.read(|cx| app.read(cx).rail_menu_open_for_test()));
    assert!(labelled(cx, window, "Remove workspace"));
    assert_eq!(
        cx.read(|cx| app.read(cx).active_workspace_for_test().map(str::to_owned)),
        None,
        "a right-click selects nothing"
    );
    press(cx, window, "escape");
    assert!(
        !cx.read(|cx| app.read(cx).rail_menu_open_for_test()),
        "Escape closes the menu"
    );
}

#[gpui_kit::test]
fn removing_a_workspace_drops_it_and_the_active_one_falls_back_to_all_projects(
    cx: &mut TestAppContext,
) {
    let (window, app) = mount_rail(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_workspace(Some("ws-b".to_owned()), cx);
            app.remove_workspace_for_test("ws-c", cx);
        });
    });
    render_twice(cx, window);
    assert_eq!(rail_ids(cx, &app), ["ws-a", "ws-b"]);
    assert_eq!(
        cx.read(|cx| app.read(cx).active_workspace_for_test().map(str::to_owned)),
        Some("ws-b".to_owned()),
        "removing another workspace keeps the one in scope"
    );
    cx.update(|cx| app.update(cx, |app, cx| app.remove_workspace_for_test("ws-b", cx)));
    render_twice(cx, window);
    assert_eq!(rail_ids(cx, &app), ["ws-a"]);
    assert_eq!(
        cx.read(|cx| app.read(cx).active_workspace_for_test().map(str::to_owned)),
        None,
        "the removed workspace was in scope"
    );
    assert!(!labelled(cx, window, "Workspace Beta"));
}

// ---- the panel seams: drag to resize, double-click to reset ----

fn seam_x(cx: &mut TestAppContext, window: AnyWindowHandle, label: &str) -> Point<Pixels> {
    row_center(cx, window, label)
}

fn drag_seam(
    cx: &mut TestAppContext,
    window: AnyWindowHandle,
    from: Point<Pixels>,
    dx: f32,
) -> Point<Pixels> {
    let to = Point {
        x: from.x + px(dx),
        y: from.y,
    };
    let held = Some(MouseButton::Left);
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_move(from, None, cx);
        window.pointer_down(from, MouseButton::Left, cx);
        window.render_frame(cx);
        window.pointer_move(to, held, cx);
        window.render_frame(cx);
    });
    to
}

fn layout_widths(cx: &mut TestAppContext, app: &Entity<ConnApp>) -> (f32, f32) {
    cx.read(|cx| {
        let layout = app.read(cx).layout();
        (layout.sidebar_width, layout.right_panel_width)
    })
}

fn mount_with_right_panel(cx: &mut TestAppContext) -> (AnyWindowHandle, Entity<ConnApp>) {
    let (window, app) = mount_app(cx);
    if !cx.read(|cx| app.read(cx).layout().right_panel_open) {
        cx.update(|cx| app.update(cx, |app, cx| app.toggle_right_panel(cx)));
    }
    render_twice(cx, window);
    (window, app)
}

#[gpui_kit::test]
fn dragging_the_sidebar_seam_widens_the_sidebar_beside_an_open_right_panel(
    cx: &mut TestAppContext,
) {
    let (window, app) = mount_with_right_panel(cx);
    let (before, panel) = layout_widths(cx, &app);
    let seam = seam_x(cx, window, "Resize sidebar");
    let to = drag_seam(cx, window, seam, 60.0);
    let (during, _) = layout_widths(cx, &app);
    release(cx, window, to);
    let (after, panel_after) = layout_widths(cx, &app);
    assert!(
        (after - (before + 60.0)).abs() < 1.5,
        "the sidebar follows the pointer: {before} -> {after}"
    );
    assert_eq!(during, after, "and keeps that width on release");
    assert!(
        panel_after >= conn_state::RIGHT_PANEL_MIN_WIDTH && panel_after <= panel,
        "the right panel gives way only as far as it must: {panel} -> {panel_after}"
    );
}

#[gpui_kit::test]
fn dragging_the_sidebar_seam_stops_at_the_minimum_and_the_maximum(cx: &mut TestAppContext) {
    let (window, app) = mount_with_right_panel(cx);
    let seam = seam_x(cx, window, "Resize sidebar");
    let to = drag_seam(cx, window, seam, -600.0);
    release(cx, window, to);
    assert_eq!(layout_widths(cx, &app).0, conn_state::SIDEBAR_MIN_WIDTH);
    let seam = seam_x(cx, window, "Resize sidebar");
    let to = drag_seam(cx, window, seam, 1000.0);
    release(cx, window, to);
    let (sidebar, _) = layout_widths(cx, &app);
    assert!(
        sidebar <= conn_state::SIDEBAR_MAX_WIDTH && sidebar > conn_state::SIDEBAR_MIN_WIDTH,
        "it grows to the cap and no further: {sidebar}"
    );
}

#[gpui_kit::test]
fn double_clicking_a_seam_resets_its_width(cx: &mut TestAppContext) {
    let (window, app) = mount_with_right_panel(cx);
    let seam = seam_x(cx, window, "Resize sidebar");
    let to = drag_seam(cx, window, seam, 80.0);
    release(cx, window, to);
    assert_ne!(layout_widths(cx, &app).0, conn_state::SIDEBAR_DEFAULT_WIDTH);
    render_twice(cx, window);
    let seam = seam_x(cx, window, "Resize sidebar");
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_move(seam, None, cx);
        // The test pointer always reports one click; the second press of a double click says two.
        window.pointer_down(seam, MouseButton::Left, cx);
        window.pointer_up(seam, MouseButton::Left, cx);
        window.dispatch_event(
            gpui_kit::InputEvent::to_platform_input(gpui_kit::MouseDownEvent {
                button: MouseButton::Left,
                position: seam,
                modifiers: window.modifiers(),
                click_count: 2,
                first_mouse: false,
            }),
            cx,
        );
        window.pointer_up(seam, MouseButton::Left, cx);
        window.render_frame(cx);
    });
    assert_eq!(layout_widths(cx, &app).0, conn_state::SIDEBAR_DEFAULT_WIDTH);
}

#[gpui_kit::test]
fn dragging_the_right_panel_seam_resizes_the_panel(cx: &mut TestAppContext) {
    let (window, app) = mount_with_right_panel(cx);
    let (_, before) = layout_widths(cx, &app);
    let seam = seam_x(cx, window, "Resize panel");
    let to = drag_seam(cx, window, seam, -80.0);
    release(cx, window, to);
    let (_, after) = layout_widths(cx, &app);
    assert!(
        (after - (before + 80.0)).abs() < 1.5,
        "dragging left widens the panel: {before} -> {after}"
    );
}

#[gpui_kit::test]
fn a_seam_drag_keeps_the_width_for_the_next_launch_and_a_reset_forgets_it(cx: &mut TestAppContext) {
    let (window, app) = mount_with_right_panel(cx);
    assert_eq!(
        cx.read(|cx| app.read(cx).saved_panel_widths_for_test()),
        (None, None)
    );
    let seam = seam_x(cx, window, "Resize sidebar");
    let to = drag_seam(cx, window, seam, 50.0);
    release(cx, window, to);
    let (sidebar, _) = layout_widths(cx, &app);
    assert_eq!(
        cx.read(|cx| app.read(cx).saved_panel_widths_for_test()),
        (Some(sidebar), None),
        "the width it ended on is kept"
    );
    // A press that goes nowhere keeps nothing new.
    render_twice(cx, window);
    let seam = seam_x(cx, window, "Resize sidebar");
    let to = drag_seam(cx, window, seam, 0.0);
    release(cx, window, to);
    assert_eq!(
        cx.read(|cx| app.read(cx).saved_panel_widths_for_test()).0,
        Some(sidebar)
    );
}

#[gpui_kit::test]
fn a_wide_sidebar_squeezes_the_right_panel_as_drawn_and_keeps_its_width(cx: &mut TestAppContext) {
    let (window, app) = mount_with_right_panel(cx);
    let (_, panel) = layout_widths(cx, &app);
    let seam = seam_x(cx, window, "Resize sidebar");
    let to = drag_seam(cx, window, seam, 400.0);
    release(cx, window, to);
    let (sidebar, panel_after) = layout_widths(cx, &app);
    assert_eq!(sidebar, conn_state::SIDEBAR_MAX_WIDTH);
    assert_eq!(
        panel_after, panel,
        "the width kept for the panel is not touched"
    );
    let drawn = cx.read(|cx| {
        app.read(cx)
            .right_panel_effective_width_for_test(TEST_WINDOW_WIDTH)
    });
    // The chat keeps 360: 1440 - 54 - 480 - 360 = 546.
    assert_eq!(drawn, 546.0);
}

#[gpui_kit::test]
fn threads_of_a_linked_environment_are_listed_and_name_their_environment_in_the_hover_card(
    cx: &mut TestAppContext,
) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            let project: ProjectShell = match from_json(json!({
                "id": "proj-mini",
                "title": "orbit",
                "workspaceRoot": "/Users/mini/orbit",
                "defaultModelSelection": null,
                "scripts": [],
                "createdAt": "2026-11-20T09:00:00.000Z",
                "updatedAt": "2026-11-22T15:00:00.000Z",
            })) {
                Ok(project) => project,
                Err(err) => panic!("linked ProjectShell failed: {err}"),
            };
            let thread = make_thread_shell(ThreadSeedSpec {
                id: "thread-mini",
                project_id: "proj-mini",
                title: "Map Stalled Orbit Threads and PRs",
                status: "completed",
                activity_run_status: None,
                pinned_at: None,
                settled_at: None,
                pending_kind: None,
            });
            app.add_linked_shell_for_test(
                "mini",
                "mini",
                ShellState::from_parts(vec![project], vec![thread], Vec::new(), Some(1)),
                cx,
            );
        });
    });
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        // The merged list shows the other environment's thread beside the primary one's, and
        // its row carries no machine icon: the hover card names the environment.
        let _ = window.find_by_label("Map Stalled Orbit Threads and PRs");
        let _ = window.find_by_label("Failed thread card");
        assert!(
            window.try_find_by_label("Environment mini").is_none(),
            "a row shows no environment icon"
        );
    });
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.open_thread_hover_for_test("thread-mini", cx)
        });
    });
    for _ in 0..3 {
        let _ = cx.update_window(window, |_, w, cx| w.render_frame(cx));
        cx.run_until_parked();
    }
    assert!(
        cx.update_window(window, |_, w, cx| has_label(w, cx, "Environment mini"))
            .unwrap_or(false),
        "the hover card names the environment"
    );
    cx.read(|cx| {
        let app = app.read(cx);
        assert_eq!(
            app.thread_environment_for_test("thread-mini").as_deref(),
            Some("mini")
        );
        assert_eq!(app.thread_environment_for_test("thread-failed"), None);
    });
}

fn linked_mini_shell(project_root: &str, thread_title: &str) -> ShellState {
    let project: ProjectShell = match from_json(json!({
        "id": "proj-mini",
        "title": "No project",
        "workspaceRoot": project_root,
        "defaultModelSelection": null,
        "scripts": [],
        "createdAt": "2026-11-20T09:00:00.000Z",
        "updatedAt": "2026-11-22T15:00:00.000Z",
    })) {
        Ok(project) => project,
        Err(err) => panic!("linked ProjectShell failed: {err}"),
    };
    let mut thread = make_thread_shell(ThreadSeedSpec {
        id: "thread-mini",
        project_id: "proj-mini",
        title: thread_title,
        status: "completed",
        activity_run_status: None,
        pinned_at: None,
        settled_at: None,
        pending_kind: None,
    });
    // A scratch thread has no branch.
    thread.branch = None;
    ShellState::from_parts(vec![project], vec![thread], Vec::new(), Some(1))
}

#[gpui_kit::test]
fn remote_child_opens_from_its_parent_card_without_a_sidebar_row(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            let mut mini = linked_mini_shell("/work/mini", "Mini diagnostics");
            mini.threads[0].delegated_from = Some(
                from_json(json!({
                    "environmentId": "agent", "threadId": "thread-selected", "title": "Parent"
                }))
                .unwrap(),
            );
            app.add_linked_shell_for_test("mini", "mini", mini, cx);
            let mut parent = kitchen_sink_thread();
            parent
                .entries
                .retain(|row| matches!(row, TimelineEntry::Subagent { .. }));
            if let TimelineEntry::Subagent {
                child_thread_id,
                remote_child,
                ..
            } = &mut parent.entries[0]
            {
                *child_thread_id = None;
                *remote_child = Some(
                    from_json(json!({
                        "threadId": "thread-mini", "environmentId": "mini", "label": "Mini"
                    }))
                    .unwrap(),
                );
            }
            app.set_thread_for_test("thread-selected".to_owned(), parent, cx);
        });
    });
    cx.update_window(window, |_, w, cx| w.render_frame(cx))
        .unwrap();
    cx.run_until_parked();
    cx.update_window(window, |_, w, cx| {
        w.render_frame(cx);
        assert!(w.try_find_by_label("Mini diagnostics").is_none());
        let card = center_by_label(w, cx, "Open Inspect sidebar card hover styles");
        w.pointer_down(card, MouseButton::Left, cx);
        w.pointer_up(card, MouseButton::Left, cx);
        w.render_frame(cx);
        assert!(w.try_find_by_label("Thread favicon: thread-mini").is_none());
    })
    .unwrap();
    assert_eq!(open_thread(cx, &app).as_deref(), Some("thread-mini"));
    assert_eq!(
        cx.read(|cx| app.read(cx).thread_environment_for_test("thread-mini")),
        Some("mini".to_owned())
    );
}

#[gpui_kit::test]
fn a_saved_environment_lists_its_threads_while_it_is_offline_and_its_switch_takes_them_out_and_back(
    cx: &mut TestAppContext,
) {
    let (_window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            // Restored from its last snapshot: no connection, as when it is asleep.
            app.add_linked_shell_for_test(
                "studio",
                "superheroicons / studio",
                linked_mini_shell("/work/studio", "Icon audit"),
                cx,
            );
        });
    });
    cx.read(|cx| {
        let app = app.read(cx);
        assert!(
            app.merged_thread_ids_for_test()
                .contains(&"thread-mini".to_owned())
        );
        let rows = app.linked_settings_rows();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "superheroicons / studio");
        assert!(rows[0].enabled);
        assert_eq!(
            rows[0].state,
            crate::orbit_sync::LinkedEnvironmentState::Offline
        );
        assert_eq!(rows[0].thread_count, 1);
    });

    // Conn's switch: off takes the environment's threads out of the list and keeps it saved.
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_linked_environment_enabled("studio", false, cx);
        });
    });
    cx.read(|cx| {
        let app = app.read(cx);
        assert!(
            !app.merged_thread_ids_for_test()
                .contains(&"thread-mini".to_owned())
        );
        let rows = app.linked_settings_rows();
        assert_eq!(
            rows.len(),
            1,
            "it stays listed in Settings, to switch back on"
        );
        assert!(!rows[0].enabled);
        assert_eq!(
            rows[0].state,
            crate::orbit_sync::LinkedEnvironmentState::Off
        );
    });
}

#[gpui_kit::test]
fn a_scratch_thread_on_another_machine_names_its_machine_on_the_meta_line(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.add_linked_shell_for_test(
                "mini",
                "mini",
                linked_mini_shell("/Users/mini/.conn/scratch", "Quick question"),
                cx,
            );
            app.set_linked_scratch_root_for_test("mini", "/Users/mini/.conn/scratch");
        });
    });
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        // Conn's `scratchMachineLabel`: the scratch project's thread has no branch, so the
        // meta line says which machine it is on instead.
        let machine = window.find_by_label("Machine mini");
        let row = window.find_by_label("Quick question");
        assert!(row.bounds().contains(&machine.bounds().center()));
        // It names the machine once: the title line carries no second icon.
        assert!(
            window.try_find_by_label("Environment mini").is_none(),
            "a scratch row shows the machine label, not the icon"
        );
    });
}

#[gpui_kit::test]
fn the_shelf_counts_older_settled_threads_of_every_environment(cx: &mut TestAppContext) {
    let (_window, app) = mount_app(cx);
    let item = |before: &str, project: &str, count: i64| {
        from_json(json!({
            "kind": "snapshot",
            "snapshot": {
                "schemaVersion": 1,
                "snapshotSequence": 5,
                "projects": [{
                    "id": project, "title": project, "workspaceRoot": format!("/w/{project}"),
                    "defaultModelSelection": null, "scripts": [],
                    "createdAt": "2026-11-20T09:00:00.000Z", "updatedAt": "2026-11-22T15:00:00.000Z"
                }],
                "threads": [],
                "archivedThreads": [],
                "olderSettled": { "before": before, "asOfSequence": 5,
                    "counts": [{ "projectId": project, "count": count }] }
            }
        }))
        .expect("snapshot decodes")
    };
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            let mut primary = ShellState::default();
            primary.apply(item("2026-11-10T00:00:00.000Z", "proj-primary", 3));
            app.set_shell(primary, cx);
            let mut mini = ShellState::default();
            mini.apply(item("2026-11-12T00:00:00.000Z", "proj-mini", 5));
            app.add_linked_shell_for_test("mini", "mini", mini, cx);
        });
    });
    cx.read(|cx| {
        // 3 on this environment and 5 on mini: both count toward "Show more".
        assert_eq!(app.read(cx).unloaded_older_settled_for_test(), 8);
    });
}

#[gpui_kit::test]
fn the_composer_reads_the_catalog_of_the_open_threads_environment(cx: &mut TestAppContext) {
    let (_window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.add_linked_shell_for_test(
                "mini",
                "mini",
                linked_mini_shell("/Users/mini/work", "Mini thread"),
                cx,
            );
            app.set_linked_config_for_test(
                "mini",
                std::sync::Arc::new(conn_state::providers::ServerConfigState::new()),
            );
            // A thread of this environment: its own catalog.
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
            assert!(app.active_server_config_is_primary_for_test());
            // A thread of mini: mini's catalog.
            app.set_thread_for_test(
                "thread-mini".to_owned(),
                ThreadState::new("thread-mini"),
                cx,
            );
            assert!(!app.active_server_config_is_primary_for_test());
            // And back.
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
            assert!(app.active_server_config_is_primary_for_test());
        });
    });
}

/// The context meter's popover opens when the pointer rests on the meter and closes when it
/// leaves the meter and the popover, with web's 150ms delays; a click pins it open.
#[gpui_kit::test]
fn the_context_meter_popover_closes_when_the_pointer_leaves(cx: &mut TestAppContext) {
    use std::time::Duration;

    let (_window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
        });
    });
    let composer = cx.update(|cx| app.read(cx).chat_for_test().read(cx).composer_for_test());
    let open =
        |cx: &mut TestAppContext| cx.update(|cx| composer.read(cx).context_meter_open_for_test());
    let settle = |cx: &mut TestAppContext| {
        cx.executor().advance_clock(Duration::from_millis(200));
        cx.run_until_parked();
    };
    let delay = Duration::from_millis(150);

    cx.update(|cx| {
        composer.update(cx, |composer, cx| {
            composer.set_context_window(Some(Default::default()), cx);
            composer.meter_trigger_hover(true, delay, cx);
        });
    });
    assert!(!open(cx), "hover alone waits out the open delay");
    settle(cx);
    assert!(open(cx), "resting on the meter opens the popover");

    cx.update(|cx| composer.update(cx, |c, cx| c.meter_trigger_hover(false, delay, cx)));
    settle(cx);
    assert!(!open(cx), "leaving the meter closes the popover");

    // A click pins it; the pointer leaving then does not close it.
    cx.update(|cx| {
        composer.update(cx, |c, cx| {
            c.meter_trigger_hover(true, delay, cx);
            c.meter_click(cx);
            c.meter_trigger_hover(false, delay, cx);
        });
    });
    settle(cx);
    assert!(open(cx), "a clicked popover stays open");
}

/// Every right-panel surface exposes its controls to Nick's annotator through the AX tree: each
/// interactive element has a label, and no two elements share one path (a duplicate id).
#[gpui_kit::test]
fn every_right_panel_surface_has_labelled_unique_ax_controls(cx: &mut TestAppContext) {
    use conn_state::RightPanelTab;
    let (window, app) = mount_with_right_panel(cx);
    let interactive = |role: &str| {
        [
            "Button",
            "Tab",
            "MenuItem",
            "Switch",
            "CheckBox",
            "RadioButton",
            "Link",
            "ComboBox",
        ]
        .contains(&role)
    };
    let mut problems: Vec<String> = Vec::new();
    for tab in RightPanelTab::MENU_ORDER {
        cx.update(|cx| app.update(cx, |app, cx| app.select_right_panel_tab(tab, cx)));
        render_twice(cx, window);
        let elements = cx
            .update_window(window, |_, window, _| window.elements())
            .unwrap_or_default();
        let mut seen = std::collections::HashSet::new();
        for element in &elements {
            let path = format!("{:?}", element.path());
            if !seen.insert(path.clone()) {
                problems.push(format!("{tab:?}: duplicate AX path {path}"));
            }
            let role = element.role().map(|r| format!("{r:?}")).unwrap_or_default();
            let unlabelled = element.label().is_none_or(|l| l.trim().is_empty());
            if interactive(&role) && unlabelled && element.visible() {
                problems.push(format!("{tab:?}: {role} without a label at {path}"));
            }
        }
        eprintln!("AX audit {tab:?}: {} elements", elements.len());
    }
    assert!(problems.is_empty(), "AX problems:\n{}", problems.join("\n"));
}

#[gpui_kit::test]
fn a_threads_linked_issues_are_in_the_hover_card_and_not_on_the_row(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    let mut shell = kitchen_sink_shell();
    let issue = |key: &str| {
        json!({
            "tracker": "github", "host": "github.com", "scope": "nckrtl/conn", "key": key,
            "projectId": "p", "url": "https://github.com/nckrtl/conn/issues/1", "source": "agent",
            "linkedAt": "2026-11-23T10:00:00.000Z", "displayKey": format!("#{key}"), "title": "t"
        })
    };
    for thread in &mut shell.threads {
        if thread.id == "thread-pinned" {
            let mut value = serde_json::to_value(&*thread).expect("a thread serializes");
            value["issues"] = json!([issue("1"), issue("2"), issue("3")]);
            *thread = from_json(value).expect("a thread with issues decodes");
        }
    }
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(shell, cx);
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
        });
    });
    assert!(
        !cx.update_window(window, |_, w, cx| has_label(w, cx, "3 linked issues"))
            .unwrap_or(true),
        "the row no longer shows the linked issues"
    );
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.open_thread_hover_for_test("thread-pinned", cx)
        });
    });
    for _ in 0..3 {
        let _ = cx.update_window(window, |_, w, cx| w.render_frame(cx));
        cx.run_until_parked();
    }
    assert!(
        cx.update_window(window, |_, w, cx| has_label(w, cx, "3 linked issues"))
            .unwrap_or(false),
        "the hover card lists them"
    );
}

#[gpui_kit::test]
fn hovering_the_settle_button_highlights_only_its_icon(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), kitchen_sink_thread(), cx);
        });
    });
    // The icon takes its colour from the button's group on hover; a debug build trips on a
    // second hover style on the same element, so moving the pointer over it must not panic.
    let _ = cx.update_window(window, |_, window, cx| {
        let row = center_by_label(window, cx, "Failed thread card");
        window.pointer_move(row, None, cx);
        window.render_frame(cx);
        // The settle icon sits at the right end of the title line; move across the row's width.
        for dx in [60.0, 120.0, 160.0] {
            let over = Point {
                x: px(f32::from(row.x) + dx),
                y: px(f32::from(row.y) - 8.0),
            };
            window.pointer_move(over, None, cx);
            window.render_frame(cx);
        }
    });
}

fn mount_with_two_environments(cx: &mut TestAppContext) -> (AnyWindowHandle, Entity<ConnApp>) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            // The rail starts with no workspace, not the ones saved on this machine.
            app.set_rail_workspaces_for_test(Vec::new(), cx);
            app.add_linked_shell_for_test(
                "mini",
                "mini",
                linked_mini_shell("/Users/mini/work", "Mini thread"),
                cx,
            );
        });
    });
    (window, app)
}

#[gpui_kit::test]
fn the_rail_plus_opens_the_workspace_editor_and_a_created_workspace_scopes_the_sidebar(
    cx: &mut TestAppContext,
) {
    let (window, app) = mount_with_two_environments(cx);
    // The `+` is a workspace editor, not the folder picker.
    let plus = match cx.update_window(window, |_, window, cx| {
        center_by_label(window, cx, "New workspace")
    }) {
        Ok(pt) => pt,
        Err(err) => panic!("no rail + button: {err}"),
    };
    let _ = cx.update_window(window, |_, window, cx| {
        window.pointer_down(plus, MouseButton::Left, cx);
        window.pointer_up(plus, MouseButton::Left, cx);
        window.render_frame(cx);
    });
    let editor = cx
        .read(|cx| app.read(cx).workspace_editor_for_test())
        .expect("the + opens the workspace editor");

    // The picker lists the projects of every connected environment, under their machines.
    let listed = cx.read(|cx| editor.read(cx).listed_for_test());
    assert!(
        listed.contains(&"primary:proj-parity".to_owned()),
        "{listed:?}"
    );
    assert!(listed.contains(&"mini:proj-mini".to_owned()), "{listed:?}");

    let _ = cx.update_window(window, |_, window, cx| {
        editor.update(cx, |editor, cx| {
            editor.set_name_for_test("  Orbit   work ", window, cx);
            editor.style_for_test("violet", Some("rocket"), cx);
            editor.toggle_for_test("mini:proj-mini", true, cx);
            editor.save_for_test(cx);
        });
    });
    cx.read(|cx| {
        let app = app.read(cx);
        let saved = app.workspaces_for_test();
        assert_eq!(saved.len(), 1);
        assert_eq!(
            saved[0].name, "Orbit work",
            "the name is trimmed and collapsed"
        );
        assert_eq!(saved[0].color, "violet");
        assert_eq!(saved[0].icon.as_deref(), Some("rocket"));
        assert_eq!(saved[0].project_refs, ["mini:proj-mini"]);
        assert_eq!(
            app.active_workspace_for_test(),
            Some(saved[0].id.as_str()),
            "a created workspace is selected"
        );
        assert!(
            app.workspace_editor_for_test().is_none(),
            "the editor closes"
        );
    });
    // The sidebar now shows only the threads of its projects.
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        let _ = window.find_by_label("Mini thread");
        assert!(
            window.try_find_by_label("Failed thread card").is_none(),
            "a thread of another project is out of the workspace"
        );
    });
}

#[gpui_kit::test]
fn the_workspace_editor_refuses_a_taken_name_edits_and_deletes(cx: &mut TestAppContext) {
    let (window, app) = mount_with_two_environments(cx);
    let create = |cx: &mut TestAppContext, name: &str| {
        let _ = cx.update_window(window, |_, window, cx| {
            app.update(cx, |app, cx| app.open_workspace_editor(None, window, cx));
        });
        let editor = cx
            .read(|cx| app.read(cx).workspace_editor_for_test())
            .expect("an editor");
        let _ = cx.update_window(window, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor.set_name_for_test(name, window, cx);
                editor.save_for_test(cx);
            });
        });
        editor
    };
    let first = create(cx, "Orbit");
    cx.read(|cx| {
        assert!(
            app.read(cx).workspace_editor_for_test().is_none(),
            "{:?}",
            first.read(cx).error_for_test()
        )
    });

    // The same name in another case is taken: the editor stays open and says why.
    let second = create(cx, "orbit");
    cx.read(|cx| {
        assert!(app.read(cx).workspace_editor_for_test().is_some());
        assert_eq!(
            second.read(cx).error_for_test().as_deref(),
            Some("A workspace named \"orbit\" already exists.")
        );
        assert_eq!(app.read(cx).workspaces_for_test().len(), 1);
    });
    let _ = cx.update_window(window, |_, window, cx| {
        second.update(cx, |editor, cx| {
            editor.set_name_for_test("", window, cx);
            editor.save_for_test(cx);
        });
    });
    cx.read(|cx| {
        assert_eq!(
            second.read(cx).error_for_test().as_deref(),
            Some("Give the workspace a name.")
        );
    });

    // Edit… opens the workspace with its own values, and a save renames it in place.
    let id = cx.read(|cx| app.read(cx).workspaces_for_test()[0].id.clone());
    let _ = cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| {
            app.workspace_editor_for_test_close(window, cx);
            app.open_workspace_editor(Some(id.clone()), window, cx);
        });
    });
    let editing = cx
        .read(|cx| app.read(cx).workspace_editor_for_test())
        .expect("the Edit… editor");
    let _ = cx.update_window(window, |_, window, cx| {
        editing.update(cx, |editor, cx| {
            editor.set_name_for_test("Orbit core", window, cx);
            editor.save_for_test(cx);
        });
    });
    cx.read(|cx| {
        let saved = app.read(cx).workspaces_for_test();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].id, id);
        assert_eq!(saved[0].name, "Orbit core");
    });

    // Delete removes it, and the sidebar shows every project again.
    let _ = cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| {
            app.open_workspace_editor(Some(id.clone()), window, cx)
        });
    });
    let deleting = cx
        .read(|cx| app.read(cx).workspace_editor_for_test())
        .expect("an editor");
    cx.update(|cx| deleting.update(cx, |editor, cx| editor.delete_for_test(cx)));
    cx.read(|cx| {
        let app = app.read(cx);
        assert!(app.workspaces_for_test().is_empty());
        assert_eq!(app.active_workspace_for_test(), None);
    });
}

#[gpui_kit::test]
fn a_letter_an_icon_and_an_image_workspace_tile_have_the_same_size_and_shape(
    cx: &mut TestAppContext,
) {
    let picture = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        120,
        80,
        image::Rgba([250, 250, 250, 255]),
    ));
    let url = crate::workspace_image::data_url_from_image(&picture).expect("a data url");
    let workspace = |id: &str, name: &str, icon: Option<&str>, image: Option<&str>| {
        conn_desktop::orbit::OrbitWorkspace {
            id: id.to_owned(),
            name: name.to_owned(),
            color: "blue".to_owned(),
            icon: icon.map(str::to_owned),
            image: image.map(str::to_owned),
            project_refs: Vec::new(),
            project_keys: Vec::new(),
        }
    };
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_rail_workspaces_for_test(
                vec![
                    workspace("w-letter", "Letter", None, None),
                    workspace("w-icon", "Icon", Some("rocket"), None),
                    workspace("w-image", "Image", None, Some(&url)),
                ],
                cx,
            );
        });
    });
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        let sizes: Vec<(f32, f32)> = ["Badge Letter", "Badge Icon", "Badge Image"]
            .iter()
            .map(|label| {
                let bounds = window.find_by_label(label).bounds();
                (f32::from(bounds.size.width), f32::from(bounds.size.height))
            })
            .collect();
        // `size-7`: every kind is the same 28px square inside the 38px button.
        assert_eq!(sizes, vec![(28.0, 28.0); 3], "{sizes:?}");
        let button = window.find_by_label("Workspace Image").bounds();
        assert_eq!(
            (f32::from(button.size.width), f32::from(button.size.height)),
            (38.0, 38.0)
        );
    });
}
