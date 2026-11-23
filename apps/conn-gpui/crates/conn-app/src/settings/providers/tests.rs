//! Headless renders of Settings → Providers and Projects with model preferences, a managed
//! policy and a project scope, so a duplicate AccessKit id or a render
//! panic fails here before it reaches the live app.

use std::sync::Arc;

use conn_state::providers::ServerConfigState;
use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::test::{TestQueryExt as _, TestWindowExt as _};
use gpui_kit::{
    AnyWindowHandle, AppContext as _, Bounds, Entity, Point, TestAppContext, WindowBounds,
    WindowOptions, px, size,
};
use serde_json::{Value, json};

use super::{ProvidersInit, ProvidersView};
use crate::settings::ScheduledTaskProjectOption;
use crate::settings::projects::ProjectsView;
use crate::theme::apply_kit_theme;

fn config() -> Arc<ServerConfigState> {
    let mut snapshot: Value = serde_json::from_str(include_str!(
        "../../../../../../../crates/conn-state/tests/fixtures/server-config-snapshot.json"
    ))
    .expect("fixture is JSON");
    let config = &mut snapshot["config"];
    config["settings"]["favorites"] = json!([{ "provider": "codex", "model": "gpt-6-astra" }]);
    config["settings"]["providerModelPreferences"] =
        json!({ "codex": { "hiddenModels": ["gpt-6.1-sol"], "modelOrder": [] } });
    config["settings"]["providerInstances"] = json!({
        "codex": {
            "driver": "codex",
            "config": { "customModels": ["my-model"] },
            "environment": [
                { "name": "A", "value": "1", "sensitive": false },
                { "name": "TOKEN", "value": "", "sensitive": true, "valueRedacted": true },
            ],
        },
        "claudeAgent": { "driver": "claudeAgent", "environment": [{ "name": "B", "value": "2" }] },
    });
    config["settings"]["projectSettingsOverrides"] =
        json!({ "p1": { "providerInstances": { "codex": { "enabled": false } } } });
    config["managedPolicy"] = json!({
        "organization": "Acme",
        "lockedSettings": [],
        "limits": { "providers": {
            "allowedDrivers": ["codex", "claudeAgent"],
            "lockedInstanceFields": {
                "codex": ["config.binaryPath"],
                "claudeAgent": ["environment"],
            },
        } },
    });
    let mut state = ServerConfigState::new();
    state.apply(serde_json::from_value(snapshot).expect("snapshot event"));
    Arc::new(state)
}

fn init(cx: &mut gpui_kit::App) -> Tokens {
    gpui_kit::init(cx);
    let theme = conn_theme::theme_by_id("dark-ocean").expect("built-in theme");
    let tokens = Tokens::derive(&theme);
    apply_kit_theme(&tokens, cx);
    tokens
}

fn tall_window() -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
            Point::default(),
            size(px(1200.0), px(2400.0)),
        ))),
        ..Default::default()
    }
}

fn mount(cx: &mut TestAppContext) -> (AnyWindowHandle, Entity<ProvidersView>) {
    cx.update(|cx| {
        let tokens = init(cx);
        gpui_kit::open_window(tall_window(), cx, |window, cx| {
            window.activate_window();
            cx.new(|cx| {
                ProvidersView::new(
                    ProvidersInit {
                        tokens,
                        geometry: ShellGeometry::default(),
                        connection: None,
                        environment_label: "Mini".to_owned(),
                    },
                    window,
                    cx,
                )
            })
        })
        .expect("window opens")
    })
}

fn has(cx: &mut TestAppContext, window: AnyWindowHandle, label: &str) -> bool {
    cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.try_find_by_label(label).is_some()
    })
    .unwrap_or(false)
}

#[gpui_kit::test]
fn the_editor_renders_models_locks_and_a_project_scope(cx: &mut TestAppContext) {
    let (window, view) = mount(cx);
    cx.update(|cx| {
        view.update(cx, |view, cx| {
            view.set_server_config(config(), cx);
            view.focus_provider("codex".to_owned(), cx);
        });
    });
    assert!(has(cx, window, "Remove GPT-6-Astra from favorites"));
    assert!(
        has(cx, window, "Add my-model to favorites"),
        "custom models list too"
    );
    assert!(
        has(cx, window, "Managed by Acme."),
        "binaryPath is the policy's"
    );
    assert!(has(cx, window, "Accent color for Codex"));

    cx.update(|cx| {
        view.update(cx, |view, cx| {
            view.focus_provider("claudeAgent".to_owned(), cx);
        });
    });
    assert!(
        has(cx, window, "Managed by Acme."),
        "the whole environment is locked"
    );
    assert!(!has(cx, window, "Add variable"));

    cx.update(|cx| {
        view.update(cx, |view, cx| {
            view.set_project_scope(Some(("p1".to_owned(), "Conn".to_owned())), cx);
        });
    });
    assert!(has(cx, window, "Show device settings"));
    assert!(
        has(cx, window, "Use device setting"),
        "codex has a project override"
    );
}

#[gpui_kit::test]
fn the_projects_page_counts_each_projects_overrides(cx: &mut TestAppContext) {
    let window = cx.update(|cx| {
        let tokens = init(cx);
        let projects = vec![
            ScheduledTaskProjectOption {
                id: "p1".to_owned(),
                name: "Conn".to_owned(),
            },
            ScheduledTaskProjectOption {
                id: "p2".to_owned(),
                name: "Conn".to_owned(),
            },
        ];
        gpui_kit::open_window(tall_window(), cx, |window, cx| {
            window.activate_window();
            cx.new(|cx| {
                let mut view = ProjectsView::new(tokens, ShellGeometry::default(), projects);
                view.set_server_config(config(), cx);
                view
            })
        })
        .expect("window opens")
    });
    let (window, _) = window;
    assert!(has(cx, window, "Conn: 1 provider set for this project."));
    assert!(has(cx, window, "Conn: Uses the device's providers."));
}

#[gpui_kit::test]
fn a_custom_model_opens_its_editor_and_takes_options(cx: &mut TestAppContext) {
    let (window, view) = mount(cx);
    cx.update(|cx| {
        view.update(cx, |view, cx| {
            view.set_server_config(config(), cx);
            view.focus_provider("codex".to_owned(), cx);
        });
    });
    assert!(
        has(cx, window, "Edit my-model"),
        "a custom row has a pencil"
    );
    assert!(!has(cx, window, "Add custom option"), "closed until asked");

    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.toggle_custom_edit("codex", "my-model", window, cx);
            view.edit_custom(|d| d.add_preset("reasoningEffort"), window, cx);
        });
    })
    .expect("window");
    assert!(has(cx, window, "Add custom option"));
    assert!(
        has(cx, window, "Add option Speed"),
        "an option already added is not offered again"
    );
    assert!(!has(cx, window, "Add option Reasoning"));
    assert!(has(cx, window, "Option 1 type Choices"));
    assert!(has(cx, window, "Add choice to option 1"));

    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.edit_custom(|d| d.add_custom_option(), window, cx);
            view.save_custom_edit(cx);
        });
    })
    .expect("window");
    assert!(
        has(cx, window, "Option 2 needs an id."),
        "a blank option blocks the save and names itself"
    );
}
