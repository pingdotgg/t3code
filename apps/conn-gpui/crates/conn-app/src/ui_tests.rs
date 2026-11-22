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
            cx.new(|cx| ConnApp::new(theme.id, tokens, None, window, cx))
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

    ShellState {
        projects: vec![project],
        threads,
        archived_threads: Vec::new(),
        sequence: Some(100),
        synchronized: true,
    }
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
                    },
                    UserInputOption {
                        value: Some("headless".to_owned()),
                        label: "Headless".to_owned(),
                        description: "Fast local GPUI test".to_owned(),
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
            remote_label: None,
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
    // sit above Conn's 20px (`h-[1.25rem]`, `ChatView.tsx:4067`) bottom spacer + ~4.5px shell
    // inset/border (never slammed flush against the bottom of the window).
    const SHELL_BOTTOM_CHROME_PX: f32 = 4.5;
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        let card = window.find_by_label("Message input card");
        let bottom_gap = TEST_WINDOW_HEIGHT - f32::from(card.bounds().bottom());
        assert!(
            (23.5..=26.0).contains(&bottom_gap),
            "composer card must keep 20px bottom breathing room + ~4.5px shell inset (got {bottom_gap:.1}px)"
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

    // 3. Even with `persist_composer_context_strip = false`, a new-thread draft always renders the
    // context strip (workspace/branch + permissions) with the same symmetric 9px margins.
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_persist_composer_context_strip(false, cx);
            app.start_new_thread(None, None, cx);
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
            "draft context strip top margin should be ~9px (got {top_gap:.1}px)"
        );
        assert!(
            (8.0..=10.5).contains(&bottom_gap),
            "draft context strip bottom margin should be ~9px without excessive padding (got {bottom_gap:.1}px)"
        );
        assert!(
            (top_gap - bottom_gap).abs() <= 1.5,
            "draft context strip vertical margins must be symmetric (top {top_gap:.1}px vs bottom {bottom_gap:.1}px)"
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
