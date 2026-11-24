//! Headless renders of the bar and every panel, so a render panic or a duplicate AccessKit id
//! fails here before it reaches the live app.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use conn_desktop::laravel_toolbar::model::ToolbarData;
use conn_theme::Tokens;
use gpui_kit::test::{TestQueryExt as _, TestWindowExt as _};
use gpui_kit::{
    AnyWindowHandle, AppContext as _, Bounds, Entity, Point, TestAppContext, WindowBounds,
    WindowOptions, px, size,
};
use serde_json::{Value, json};

use super::{LaravelToolbar, LaravelToolbarEvent, PanelId};
use crate::theme::apply_kit_theme;

fn data(value: Value) -> ToolbarData {
    match value {
        Value::Object(map) => map,
        _ => ToolbarData::new(),
    }
}

fn payload() -> ToolbarData {
    data(json!({
        "request_id": "r1",
        "profiler": {
            "total_wall_time": { "formattedValue": "41ms", "value": 41.27 },
            "total_allocated_memory": { "formattedValue": "12 MB", "value": 12582912 },
            "total_real_memory": { "formattedValue": "14 MB", "value": 14680064 },
            "stages": [
                { "label": "Bootstrapping", "color": "#FC3D46", "wall_time": { "measurement": { "value": 8.28 } },
                  "memory_real_delta": { "measurement": { "value": 2048 } } },
                { "label": "Controller", "color": "#64BAFF", "wall_time": { "measurement": { "value": 20 } },
                  "memory_real_delta": { "measurement": { "value": 26368 } } }
            ]
        },
        "request": {
            "method": "GET", "uri": "/posts", "route_name": "posts.index", "route_uri": "posts",
            "controller_action": "App\\Http\\Controllers\\PostController@index",
            "ip_address": "127.0.0.1", "is_inertia": true,
            "headers": { "accept": ["text/html"] },
            "middleware": [{ "class": "App\\Http\\Middleware\\Authenticate" }]
        },
        "response": {
            "status_code": 200, "size": "9.97 KB", "content_type": "text/html",
            "headers": { "content-type": ["text/html"] },
            "cookies": [{ "name": "session", "value": "abc", "path": "/", "secure": true, "http_only": true }]
        },
        "inertia": {
            "component": "Posts/Index", "version": "2.0",
            "props": { "posts": [{ "id": 1 }], "flag": true }
        },
        "queries": {
            "databases": [{ "driver": "mysql", "name": "app" }],
            "queries": [
                { "sql": "select * from `posts` where id = 1", "duration": 1.5, "is_duplicate": true,
                  "offset": 0.0, "percentage": 0.4, "file": "app/Models/Post.php", "line": 10, "bindings": [] },
                { "sql": "select count(*) from users", "duration": 4.5, "is_slow": true,
                  "offset": 0.4, "percentage": 0.6 }
            ]
        },
        "models": [{ "model": "App\\Models\\Post", "retrieved": 3, "created": 1 }],
        "framework": { "name": "Laravel", "version": "12.1.0", "environment": "local", "debug": true },
        "php": {
            "version": "8.4.1", "sapi": "fpm-fcgi", "memory_limit": "128M", "max_execution_time": "30",
            "settings": { "post_max_size": "8M", "display_errors": "1", "error_reporting": "22527" },
            "opcache": { "enabled": true, "hit_rate": 99.5, "memory_used": 1048576, "memory_free": 2097152 },
            "extensions": ["json", "mbstring"],
            "fpm": { "pool": "www", "active_processes": 2, "idle_processes": 3, "listen_queue": 0,
                     "settings": { "pm": "dynamic", "pm.max_children": "10" } }
        }
    }))
}

fn mount(cx: &mut TestAppContext) -> (AnyWindowHandle, Entity<LaravelToolbar>) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        let theme = conn_theme::theme_by_id("dark-ocean").expect("built-in theme");
        let tokens = Tokens::derive(&theme);
        apply_kit_theme(&tokens, cx);
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Point::default(),
                    size(px(1000.0), px(800.0)),
                ))),
                ..Default::default()
            },
            cx,
            |window, cx| {
                window.activate_window();
                cx.new(|cx| {
                    let mut bar = LaravelToolbar::new(
                        tokens,
                        Rc::new(RefCell::new(None)),
                        Rc::new(Cell::new(Some(conn_web::Rect {
                            x: 0.0,
                            y: 0.0,
                            width: 1000.0,
                            height: 700.0,
                        }))),
                        cx,
                    );
                    bar.orbit.offline_for_test();
                    bar
                })
            },
        )
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
fn the_bar_shows_the_page_request_and_its_counters(cx: &mut TestAppContext) {
    let (window, bar) = mount(cx);
    assert!(
        !has(cx, window, "Timings"),
        "nothing to show before the page reports"
    );
    cx.update(|cx| {
        bar.update(cx, |bar, cx| {
            bar.on_page_data(Some(payload()), "http://x/", cx)
        })
    });
    for label in [
        "Requests on this page",
        "Request details",
        "Timings",
        "Memory",
        "Database queries",
        "Eloquent models",
    ] {
        assert!(has(cx, window, label), "{label}");
    }
}

#[gpui_kit::test]
fn every_panel_renders_with_a_payload(cx: &mut TestAppContext) {
    let (window, bar) = mount(cx);
    cx.update(|cx| {
        bar.update(cx, |bar, cx| {
            bar.on_page_data(Some(payload()), "http://x/", cx)
        })
    });
    for (panel, label) in [
        (PanelId::Requests, "requests panel"),
        (PanelId::Request, "request panel"),
        (PanelId::Timings, "timings panel"),
        (PanelId::Memory, "memory panel"),
        (PanelId::Database, "database panel"),
        (PanelId::Models, "models panel"),
        (PanelId::Environment, "environment panel"),
        (PanelId::Orbit, "orbit panel"),
    ] {
        cx.update(|cx| bar.update(cx, |bar, cx| bar.toggle(panel, cx)));
        assert!(has(cx, window, label), "{label}");
        cx.update(|cx| bar.update(cx, |bar, cx| bar.toggle(panel, cx)));
    }
}

#[gpui_kit::test]
fn the_request_panel_tabs_and_the_environment_tabs_render(cx: &mut TestAppContext) {
    use super::panels::EnvironmentTab;
    use super::requests::RequestTab;
    let (window, bar) = mount(cx);
    cx.update(|cx| {
        bar.update(cx, |bar, cx| {
            bar.on_page_data(Some(payload()), "http://x/", cx)
        })
    });
    cx.update(|cx| bar.update(cx, |bar, cx| bar.toggle(PanelId::Request, cx)));
    for tab in [
        RequestTab::Props,
        RequestTab::Request,
        RequestTab::Response,
        RequestTab::Cookies,
        RequestTab::Route,
    ] {
        cx.update(|cx| bar.update(cx, |bar, _| bar.request_tab = tab));
        assert!(has(cx, window, "Route"), "{tab:?}");
    }
    cx.update(|cx| {
        bar.update(cx, |bar, cx| {
            bar.toggle(PanelId::Request, cx);
            bar.toggle(PanelId::Environment, cx);
        });
    });
    for tab in [
        EnvironmentTab::Php,
        EnvironmentTab::Fpm,
        EnvironmentTab::Framework,
    ] {
        cx.update(|cx| bar.update(cx, |bar, _| bar.env_tab = tab));
        assert!(has(cx, window, "PHP"), "{tab:?}");
    }
}

#[gpui_kit::test]
fn a_page_without_data_clears_the_bar(cx: &mut TestAppContext) {
    let (window, bar) = mount(cx);
    cx.update(|cx| {
        bar.update(cx, |bar, cx| {
            bar.on_page_data(Some(payload()), "http://x/", cx)
        })
    });
    assert!(has(cx, window, "Timings"));
    cx.update(|cx| bar.update(cx, |bar, cx| bar.on_page_data(None, "http://x/other", cx)));
    assert!(!has(cx, window, "Timings"));
    assert!(!cx.update(|cx| bar.read(cx).is_visible()));
}

#[gpui_kit::test]
fn open_in_database_emits_the_query_with_its_bindings(cx: &mut TestAppContext) {
    let (_window, bar) = mount(cx);
    let seen = Rc::new(RefCell::new(Vec::new()));
    let sink = seen.clone();
    cx.update(|cx| {
        cx.subscribe(&bar, move |_, event: &LaravelToolbarEvent, _| {
            sink.borrow_mut().push(event.clone());
        })
        .detach();
        bar.update(cx, |bar, cx| bar.open_query("select 1".to_owned(), cx));
    });
    assert_eq!(
        &*seen.borrow(),
        &[LaravelToolbarEvent::OpenQuery("select 1".to_owned())]
    );
}

#[gpui_kit::test]
fn the_orbit_panel_renders_every_tab_for_a_known_instance(cx: &mut TestAppContext) {
    use conn_desktop::laravel_toolbar::orbit::{
        Dependency, OrbitDependencies, OrbitPage, OrbitProcess, ProcessStatus,
    };

    use super::orbit::{OrbitState, OrbitTab};
    let (window, bar) = mount(cx);
    cx.update(|cx| {
        bar.update(cx, |bar, cx| {
            bar.on_page_data(Some(payload()), "http://x/", cx)
        })
    });
    assert!(
        !has(cx, window, "Orbit"),
        "the item stays hidden until Orbit knows the page"
    );
    let process = |id, name: &str, status| OrbitProcess {
        id,
        name: name.to_owned(),
        command: Some("vp dev".to_owned()),
        status,
        cpu: Some(1.5),
        memory_bytes: Some(2048.0),
    };
    cx.update(|cx| {
        bar.update(cx, |bar, cx| {
            bar.orbit.state = OrbitState::Ready {
                page: OrbitPage {
                    domain: "dlf.test".to_owned(),
                    instance_id: 27,
                    node_name: Some("beast".to_owned()),
                },
                processes: vec![
                    process(1, "vite", ProcessStatus::Running),
                    process(2, "queue", ProcessStatus::Crashed),
                    process(3, "cache", ProcessStatus::Unknown),
                ],
                error: Some("Could not stop queue: refused".to_owned()),
            };
            bar.orbit.set_dependencies_for_test(OrbitDependencies {
                composer: Some(vec![Dependency {
                    id: "laravel/framework".to_owned(),
                    name: "laravel/framework".to_owned(),
                    version: "12.1.0".to_owned(),
                    constraint: Some("^12".to_owned()),
                    development: false,
                }]),
                javascript: None,
                package_manager: Some("bun".to_owned()),
                composer_error: None,
                javascript_error: None,
            });
            bar.toggle(PanelId::Orbit, cx);
        });
    });
    assert!(has(cx, window, "Orbit"), "the bar item");
    assert!(has(cx, window, "orbit panel"));
    for tab in [
        OrbitTab::Processes,
        OrbitTab::Logs,
        OrbitTab::Composer,
        OrbitTab::Javascript,
        OrbitTab::Instance,
    ] {
        cx.update(|cx| bar.update(cx, |bar, _| bar.orbit.tab = tab));
        assert!(has(cx, window, "orbit panel"), "{tab:?}");
    }
    cx.update(|cx| bar.update(cx, |bar, _| bar.orbit.tab = OrbitTab::Processes));
    assert!(has(cx, window, "Stop vite"));
    assert!(has(cx, window, "Start queue"));
    assert!(has(cx, window, "Restart cache"));
    assert!(has(cx, window, "Start all"));
}

fn base64_json(value: &Value) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = value.to_string().into_bytes();
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(TABLE[((n >> (18 - 6 * i)) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[gpui_kit::test]
fn an_api_response_with_toolbar_headers_shows_the_bar_under_the_response(cx: &mut TestAppContext) {
    use conn_desktop::api_request::store::ApiRequestDraft;
    use conn_desktop::api_request::{ApiHeader, ApiResponse, BodyEncoding};
    let (window, bar) = mount(cx);
    let draft = ApiRequestDraft {
        method: "GET".to_owned(),
        url: "https://app.test/api/posts".to_owned(),
        ..ApiRequestDraft::new(None)
    };
    let response = |headers| ApiResponse {
        error: None,
        status: 200,
        status_text: "OK".to_owned(),
        url: "https://app.test/api/posts".to_owned(),
        headers,
        body: String::new(),
        body_encoding: BodyEncoding::Text,
        size: 0,
        truncated: false,
        duration_ms: 1.0,
    };
    // A response with no toolbar data changes nothing.
    cx.update(|cx| {
        bar.update(cx, |bar, cx| {
            bar.receive_api_response(&draft, &response(Vec::new()), cx)
        })
    });
    assert!(!cx.update(|cx| bar.read(cx).is_visible()));
    cx.update(|cx| {
        bar.update(cx, |bar, cx| {
            bar.set_tab_key("api:project", cx);
            bar.receive_api_response(
                &draft,
                &response(vec![ApiHeader::new(
                    "x-toolbar",
                    base64_json(&payload_value()),
                )]),
                cx,
            );
        });
    });
    assert!(cx.update(|cx| bar.read(cx).is_visible()));
    assert!(has(cx, window, "Timings"));
    // Another project's tab starts empty.
    cx.update(|cx| bar.update(cx, |bar, cx| bar.set_tab_key("api:other", cx)));
    assert!(!cx.update(|cx| bar.read(cx).is_visible()));
}

fn payload_value() -> Value {
    Value::Object(payload())
}
