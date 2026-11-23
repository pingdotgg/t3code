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
        window.press("cmd-2", cx);
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
            app.toggle_project_collapsed(crate::sidebar::thread_list::SETTLED_SHELF_TOGGLE_KEY, cx);
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
