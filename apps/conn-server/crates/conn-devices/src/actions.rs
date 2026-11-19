//! Device settings the panel reads and changes (`DeviceActions.ts`): simctl and serve-sim's
//! accessibility helper on iOS, adb on Android. Typed actions only: serve-sim's own socket
//! would run any shell command.

use serde_json::{Map, Value, json};

use crate::{
    errors::DeviceError,
    host::{Ready, RunOptions, RunResult},
};

fn ok(operation: &str, result: RunResult) -> Result<String, DeviceError> {
    if result.code == 0 {
        Ok(result.stdout)
    } else {
        Err(DeviceError::command_failed(
            operation,
            result.code,
            result.stderr,
        ))
    }
}

fn unsupported(operation: &str, platform: &str) -> DeviceError {
    DeviceError::ActionUnavailable {
        operation: operation.into(),
        platform: platform.into(),
        reason: "unsupported",
    }
}

fn helper_missing(operation: &str) -> DeviceError {
    DeviceError::ActionUnavailable {
        operation: operation.into(),
        platform: "ios".into(),
        reason: "helper_missing",
    }
}

fn s(input: &Value, key: &str) -> String {
    input[key].as_str().unwrap_or_default().to_owned()
}

fn supported(platform: &str, input: &Value) -> bool {
    let kind = input["type"].as_str().unwrap_or_default();
    let ios = [
        "setAppearance",
        "setTextSize",
        "setToggle",
        "setLiquidGlass",
        "setColorFilter",
        "setLocation",
        "clearLocation",
        "setPermission",
        "openUrl",
        "launchApp",
        "terminateApp",
        "sendPush",
    ];
    let android = [
        "setAppearance",
        "setTextSize",
        "setToggle",
        "setOrientation",
        "setLocation",
        "clearLocation",
        "setPermission",
        "openUrl",
        "launchApp",
        "terminateApp",
    ];
    let actions: &[&str] = if platform == "ios" { &ios } else { &android };
    if !actions.contains(&kind) {
        return false;
    }
    if kind == "setToggle" {
        let setting = input["setting"].as_str().unwrap_or_default();
        let toggles: &[&str] = if platform == "ios" {
            &[
                "reduceMotion",
                "increaseContrast",
                "reduceTransparency",
                "showBorders",
                "voiceOver",
            ]
        } else {
            &["reduceMotion", "networkEnabled"]
        };
        return toggles.contains(&setting);
    }
    true
}

const IOS_TEXT_SIZES: [(&str, &str); 4] = [
    ("small", "small"),
    ("default", "large"),
    ("large", "extra-extra-large"),
    ("extra-large", "accessibility-large"),
];
const ANDROID_TEXT_SIZES: [(&str, &str); 4] = [
    ("small", "0.85"),
    ("default", "1.0"),
    ("large", "1.15"),
    ("extra-large", "1.3"),
];

fn lookup<'a>(table: &[(&'a str, &'a str)], key: &str) -> &'a str {
    table
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| *v)
        .unwrap_or_default()
}

fn text_size_from_ios(category: &str) -> &'static str {
    if let Some((size, _)) = IOS_TEXT_SIZES.iter().find(|(_, v)| *v == category) {
        return size;
    }
    if category.starts_with("accessibility") {
        return "extra-large";
    }
    if matches!(category, "extra-small" | "small" | "medium") {
        return "small";
    }
    if category.contains("extra") {
        "large"
    } else {
        "default"
    }
}

fn text_size_from_android(scale: f64) -> &'static str {
    if scale <= 0.9 {
        "small"
    } else if scale >= 1.25 {
        "extra-large"
    } else if scale >= 1.1 {
        "large"
    } else {
        "default"
    }
}

async fn simctl(
    ready: &Ready,
    udid: &str,
    args: &[&str],
    operation: &str,
) -> Result<String, DeviceError> {
    let mut full = vec!["simctl".to_owned()];
    if let Some((first, rest)) = args.split_first() {
        full.push((*first).to_owned());
        full.push(udid.to_owned());
        full.extend(rest.iter().map(|a| (*a).to_owned()));
    } else {
        full.push(udid.to_owned());
    }
    ok(
        operation,
        ready.run("xcrun", &full, RunOptions::default()).await,
    )
}

async fn ax_settings(ready: &Ready, udid: &str, args: &[&str]) -> Result<String, DeviceError> {
    let Some(helper) = &ready.helpers.ax_settings else {
        return Err(helper_missing("accessibility"));
    };
    let mut full = vec![
        "simctl".to_owned(),
        "spawn".into(),
        udid.to_owned(),
        helper.clone(),
    ];
    full.extend(args.iter().map(|a| (*a).to_owned()));
    ok(
        "accessibility",
        ready.run("xcrun", &full, RunOptions::default()).await,
    )
}

/// `runDeviceAction`.
pub(crate) async fn run(ready: &Ready, platform: &str, input: &Value) -> Result<(), DeviceError> {
    let kind = s(input, "type");
    if !supported(platform, input) {
        return Err(unsupported(&kind, platform));
    }
    if platform == "ios" {
        run_ios(ready, input, &kind).await
    } else {
        run_android(ready, input, &kind).await
    }
}

fn number(value: &Value) -> String {
    // JavaScript's `String(n)` for the coordinates: integers without a fraction.
    match value.as_f64() {
        Some(n) if n.fract() == 0.0 && n.abs() < 1e15 => format!("{}", n as i64),
        Some(n) => format!("{n}"),
        None => String::new(),
    }
}

async fn run_ios(ready: &Ready, input: &Value, kind: &str) -> Result<(), DeviceError> {
    let udid = s(input, "deviceId");
    let value = s(input, "value");
    match kind {
        "setAppearance" => {
            simctl(ready, &udid, &["ui", "appearance", &value], "appearance").await?
        }
        "setTextSize" => {
            simctl(
                ready,
                &udid,
                &["ui", "content_size", lookup(&IOS_TEXT_SIZES, &value)],
                "text size",
            )
            .await?
        }
        "setToggle" => {
            let on = input["value"].as_bool().unwrap_or(false);
            let setting = s(input, "setting");
            if setting == "increaseContrast" {
                simctl(
                    ready,
                    &udid,
                    &[
                        "ui",
                        "increase_contrast",
                        if on { "enabled" } else { "disabled" },
                    ],
                    "increase contrast",
                )
                .await?
            } else {
                let option = match setting.as_str() {
                    "reduceMotion" => "reduce-motion",
                    "reduceTransparency" => "reduce-transparency",
                    "showBorders" => "show-borders",
                    _ => "voiceover",
                };
                ax_settings(
                    ready,
                    &udid,
                    &["set", option, if on { "on" } else { "off" }],
                )
                .await?
            }
        }
        "setLiquidGlass" => ax_settings(ready, &udid, &["set", "liquid-glass", &value]).await?,
        "setColorFilter" => ax_settings(ready, &udid, &["set", "color-filter", &value]).await?,
        "setLocation" => {
            let at = format!(
                "{},{}",
                number(&input["latitude"]),
                number(&input["longitude"])
            );
            simctl(ready, &udid, &["location", "set", &at], "location").await?
        }
        "clearLocation" => simctl(ready, &udid, &["location", "clear"], "location").await?,
        "setPermission" => {
            let permission = s(input, "permission");
            let decision = s(input, "decision");
            let app = s(input, "appId");
            if permission == "notifications" {
                let Some(cli) = &ready.helpers.sim_cli else {
                    return Err(helper_missing("permission"));
                };
                let args: Vec<String> = [
                    cli.as_str(),
                    "permissions",
                    &decision,
                    &permission,
                    &app,
                    "-d",
                    &udid,
                ]
                .map(str::to_owned)
                .to_vec();
                ok(
                    "permission",
                    ready
                        .run(&ready.node_path, &args, RunOptions::default())
                        .await,
                )?
            } else {
                let service = match permission.as_str() {
                    "location" | "camera" | "microphone" | "photos" | "contacts" | "calendar"
                    | "reminders" | "motion" | "media-library" | "faceid" => permission.clone(),
                    _ => return Err(unsupported("permission", "ios")),
                };
                simctl(
                    ready,
                    &udid,
                    &["privacy", &decision, &service, &app],
                    "permission",
                )
                .await?
            }
        }
        "openUrl" => simctl(ready, &udid, &["openurl", &s(input, "url")], "open url").await?,
        "launchApp" => simctl(ready, &udid, &["launch", &s(input, "appId")], "launch").await?,
        "terminateApp" => {
            simctl(
                ready,
                &udid,
                &["terminate", &s(input, "appId")],
                "terminate",
            )
            .await?
        }
        "sendPush" => {
            let payload = match &input["payload"] {
                Value::String(alert) => json!({ "aps": { "alert": alert } }),
                other => other.clone(),
            };
            let args: Vec<String> = ["simctl", "push", &udid, &s(input, "appId"), "-"]
                .map(str::to_owned)
                .to_vec();
            ok(
                "push",
                ready
                    .run(
                        "xcrun",
                        &args,
                        RunOptions {
                            stdin: Some(payload.to_string()),
                            ..RunOptions::default()
                        },
                    )
                    .await,
            )?
        }
        other => return Err(unsupported(other, "ios")),
    };
    Ok(())
}

/// `adb shell` joins its arguments before the device's shell parses them.
fn android_word(value: &str) -> String {
    let safe = !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || "@%+=:,./-".contains(c));
    if safe {
        value.to_owned()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

async fn adb(
    ready: &Ready,
    serial: &str,
    args: &[String],
    operation: &str,
) -> Result<String, DeviceError> {
    let mut full = vec!["-s".to_owned(), serial.to_owned()];
    full.extend(args.iter().cloned());
    ok(
        operation,
        ready.run("adb", &full, RunOptions::default()).await,
    )
}

async fn shell(
    ready: &Ready,
    serial: &str,
    args: &[&str],
    operation: &str,
) -> Result<String, DeviceError> {
    let mut full = vec!["shell".to_owned()];
    full.extend(args.iter().map(|a| android_word(a)));
    adb(ready, serial, &full, operation).await
}

const ORIENTATIONS: [&str; 4] = [
    "portrait",
    "landscape_left",
    "portrait_upside_down",
    "landscape_right",
];

async fn run_android(ready: &Ready, input: &Value, kind: &str) -> Result<(), DeviceError> {
    let serial = s(input, "deviceId");
    let value = s(input, "value");
    match kind {
        "setAppearance" => {
            shell(
                ready,
                &serial,
                &[
                    "cmd",
                    "uimode",
                    "night",
                    if value == "dark" { "yes" } else { "no" },
                ],
                "appearance",
            )
            .await?;
        }
        "setTextSize" => {
            shell(
                ready,
                &serial,
                &[
                    "settings",
                    "put",
                    "system",
                    "font_scale",
                    lookup(&ANDROID_TEXT_SIZES, &value),
                ],
                "text size",
            )
            .await?;
        }
        "setToggle" => {
            let on = input["value"].as_bool().unwrap_or(false);
            match s(input, "setting").as_str() {
                "networkEnabled" => {
                    let state = if on { "enable" } else { "disable" };
                    shell(ready, &serial, &["svc", "wifi", state], "network").await?;
                    shell(ready, &serial, &["svc", "data", state], "network").await?;
                }
                "reduceMotion" => {
                    let scale = if on { "0" } else { "1" };
                    for key in [
                        "animator_duration_scale",
                        "transition_animation_scale",
                        "window_animation_scale",
                    ] {
                        shell(
                            ready,
                            &serial,
                            &["settings", "put", "global", key, scale],
                            "reduce motion",
                        )
                        .await?;
                    }
                }
                _ => return Err(unsupported(kind, "android")),
            }
        }
        "setOrientation" => {
            let wm = shell(ready, &serial, &["wm", "size"], "orientation")
                .await
                .ok();
            let index = ORIENTATIONS.iter().position(|o| *o == value).unwrap_or(0);
            let landscape_native = wm
                .as_deref()
                .and_then(last_size)
                .is_some_and(|(w, h)| w > h);
            // A landscape-native tablet sits a quarter turn further along.
            let rotation = if landscape_native {
                (index + 3) % 4
            } else {
                index
            };
            if serial.starts_with("emulator-") {
                let gravity = ["0:9.81:0", "9.81:0:0", "0:-9.81:0", "-9.81:0:0"]
                    .get(rotation)
                    .copied()
                    .unwrap_or_default();
                shell(
                    ready,
                    &serial,
                    &["settings", "put", "system", "accelerometer_rotation", "1"],
                    "orientation",
                )
                .await?;
                shell(
                    ready,
                    &serial,
                    &["cmd", "window", "user-rotation", "free"],
                    "orientation",
                )
                .await?;
                let args: Vec<String> = ["emu", "sensor", "set", "acceleration", gravity]
                    .map(str::to_owned)
                    .to_vec();
                adb(ready, &serial, &args, "orientation").await?;
            } else {
                let number = rotation.to_string();
                shell(
                    ready,
                    &serial,
                    &["cmd", "window", "user-rotation", "lock", &number],
                    "orientation",
                )
                .await?;
            }
        }
        "setLocation" => {
            let args = vec![
                "emu".to_owned(),
                "geo".into(),
                "fix".into(),
                number(&input["longitude"]),
                number(&input["latitude"]),
            ];
            adb(ready, &serial, &args, "location").await?;
        }
        "clearLocation" => {}
        "setPermission" => {
            let permissions: &[&str] = match s(input, "permission").as_str() {
                "camera" => &["android.permission.CAMERA"],
                "microphone" => &["android.permission.RECORD_AUDIO"],
                "photos" => &[
                    "android.permission.READ_MEDIA_IMAGES",
                    "android.permission.READ_EXTERNAL_STORAGE",
                ],
                "contacts" => &[
                    "android.permission.READ_CONTACTS",
                    "android.permission.WRITE_CONTACTS",
                ],
                "calendar" => &[
                    "android.permission.READ_CALENDAR",
                    "android.permission.WRITE_CALENDAR",
                ],
                "location" => &[
                    "android.permission.ACCESS_FINE_LOCATION",
                    "android.permission.ACCESS_COARSE_LOCATION",
                ],
                "notifications" => &["android.permission.POST_NOTIFICATIONS"],
                "motion" => &["android.permission.ACTIVITY_RECOGNITION"],
                _ => return Err(unsupported("permission", "android")),
            };
            let verb = if s(input, "decision") == "grant" {
                "grant"
            } else {
                "revoke"
            };
            let app = s(input, "appId");
            let mut first_failure = None;
            let mut any_success = false;
            for permission in permissions {
                match shell(
                    ready,
                    &serial,
                    &["pm", verb, &app, permission],
                    "permission",
                )
                .await
                {
                    Ok(_) => any_success = true,
                    Err(error) => {
                        first_failure.get_or_insert(error);
                    }
                }
            }
            if let (Some(failure), false) = (first_failure, any_success) {
                return Err(failure);
            }
        }
        "openUrl" => {
            shell(
                ready,
                &serial,
                &[
                    "am",
                    "start",
                    "-a",
                    "android.intent.action.VIEW",
                    "-d",
                    &s(input, "url"),
                ],
                "open url",
            )
            .await?;
        }
        "launchApp" => {
            shell(
                ready,
                &serial,
                &[
                    "monkey",
                    "-p",
                    &s(input, "appId"),
                    "-c",
                    "android.intent.category.LAUNCHER",
                    "1",
                ],
                "launch",
            )
            .await?;
        }
        "terminateApp" => {
            shell(
                ready,
                &serial,
                &["am", "force-stop", &s(input, "appId")],
                "terminate",
            )
            .await?;
        }
        other => return Err(unsupported(other, "android")),
    }
    Ok(())
}

/// The last `size: WxH` of `wm size` (an override follows the physical size).
fn last_size(text: &str) -> Option<(u64, u64)> {
    text.match_indices("size: ")
        .filter_map(|(at, _)| {
            let rest = text.get(at + 6..)?;
            let (w, rest) = rest.split_once('x')?;
            let h: String = rest.chars().take_while(char::is_ascii_digit).collect();
            Some((w.trim().parse().ok()?, h.parse().ok()?))
        })
        .last()
}

/// `readDeviceDetail`: `{ settings, foregroundApp }`.
pub(crate) async fn read(ready: &Ready, platform: &str, device_id: &str) -> Value {
    if platform == "ios" {
        read_ios(ready, device_id).await
    } else {
        read_android(ready, device_id).await
    }
}

async fn read_ios(ready: &Ready, udid: &str) -> Value {
    let ui = |option: &'static str| async move {
        simctl(ready, udid, &["ui", option], option)
            .await
            .ok()
            .map(|out| out.trim().to_lowercase())
    };
    let (appearance, content, contrast, status) = tokio::join!(
        ui("appearance"),
        ui("content_size"),
        ui("increase_contrast"),
        async {
            ax_settings(ready, udid, &["status"])
                .await
                .ok()
                .and_then(|text| serde_json::from_str::<Map<String, Value>>(&text).ok())
                .filter(|map| map.values().all(Value::is_string))
        }
    );
    let mut settings = Map::new();
    if let Some(appearance) = appearance.filter(|a| a == "light" || a == "dark") {
        settings.insert("appearance".into(), json!(appearance));
    }
    if let Some(content) = content.filter(|c| !c.is_empty()) {
        settings.insert("textSize".into(), json!(text_size_from_ios(&content)));
    }
    if let Some(contrast) = contrast.filter(|c| !c.is_empty()) {
        settings.insert("increaseContrast".into(), json!(contrast == "enabled"));
    }
    if let Some(status) = status {
        let on_off = |key: &str| match status.get(key).and_then(Value::as_str) {
            Some("on") => Some(true),
            Some("off") => Some(false),
            _ => None,
        };
        for (key, field) in [
            ("reduce-motion", "reduceMotion"),
            ("reduce-transparency", "reduceTransparency"),
            ("show-borders", "showBorders"),
            ("voiceover", "voiceOver"),
        ] {
            if let Some(value) = on_off(key) {
                settings.insert(field.into(), json!(value));
            }
        }
        if let Some(glass) = status
            .get("liquid-glass")
            .and_then(Value::as_str)
            .filter(|g| *g == "clear" || *g == "tinted")
        {
            settings.insert("liquidGlass".into(), json!(glass));
        }
        if let Some(filter) = status
            .get("color-filter")
            .and_then(Value::as_str)
            .filter(|f| ["none", "grayscale", "red-green", "green-red", "blue-yellow"].contains(f))
        {
            settings.insert("colorFilter".into(), json!(filter));
        }
    }
    json!({ "settings": settings, "foregroundApp": null })
}

async fn read_android(ready: &Ready, serial: &str) -> Value {
    let get = |args: &'static [&'static str]| async move {
        let mut full = vec!["shell".to_owned()];
        full.extend(args.iter().map(|a| (*a).to_owned()));
        adb(
            ready,
            serial,
            &full,
            args.first().copied().unwrap_or("shell"),
        )
        .await
        .ok()
        .map(|out| out.trim().to_owned())
    };
    let (night, font, animator, wifi, focus) = tokio::join!(
        get(&["cmd", "uimode", "night"]),
        get(&["settings", "get", "system", "font_scale"]),
        get(&["settings", "get", "global", "animator_duration_scale"]),
        get(&["settings", "get", "global", "wifi_on"]),
        get(&["dumpsys", "window"]),
    );
    let mut settings = Map::new();
    if let Some(night) = &night {
        if night.contains("yes") {
            settings.insert("appearance".into(), json!("dark"));
        } else if night.contains("no") {
            settings.insert("appearance".into(), json!("light"));
        }
    }
    if let Some(scale) = font
        .filter(|f| f != "null")
        .and_then(|f| f.parse::<f64>().ok())
        .filter(|n| n.is_finite())
    {
        settings.insert("textSize".into(), json!(text_size_from_android(scale)));
    }
    if let Some(animator) = animator.filter(|a| a != "null") {
        settings.insert(
            "reduceMotion".into(),
            json!(animator.parse::<f64>().ok() == Some(0.0)),
        );
    }
    if let Some(wifi) = wifi.filter(|w| w == "1" || w == "0") {
        settings.insert("networkEnabled".into(), json!(wifi == "1"));
    }
    let foreground = focus.as_deref().and_then(focused_app);
    json!({
        "settings": settings,
        "foregroundApp": foreground.map(|id| json!({ "id": id })),
    })
}

/// `m(?:CurrentFocus|FocusedApp)=\w+\{[^ ]+ u\d+ ([^/ ]+)\/`
fn focused_app(dump: &str) -> Option<String> {
    for marker in ["mCurrentFocus=", "mFocusedApp="] {
        for (at, _) in dump.match_indices(marker) {
            let rest = dump.get(at + marker.len()..)?;
            let word_end = rest.find(|c: char| !(c.is_alphanumeric() || c == '_'))?;
            if word_end == 0 {
                continue;
            }
            let Some(rest) = rest.get(word_end..).and_then(|r| r.strip_prefix('{')) else {
                continue;
            };
            let Some((_token, rest)) = rest.split_once(' ') else {
                continue;
            };
            let Some(rest) = rest.strip_prefix('u') else {
                continue;
            };
            let digits = rest.chars().take_while(char::is_ascii_digit).count();
            if digits == 0 {
                continue;
            }
            let Some(rest) = rest.get(digits..).and_then(|r| r.strip_prefix(' ')) else {
                continue;
            };
            let end = rest.find(['/', ' ']).unwrap_or(rest.len());
            if rest.get(end..end + 1) == Some("/") && end > 0 {
                return rest.get(..end).map(str::to_owned);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_text_sizes_and_words() {
        assert_eq!(text_size_from_ios("extra-extra-large"), "large", "xxl");
        assert_eq!(
            text_size_from_ios("accessibility-medium"),
            "extra-large",
            "a11y"
        );
        assert_eq!(text_size_from_android(1.0), "default", "1.0");
        assert_eq!(android_word("a b"), "'a b'", "quoted");
        assert_eq!(
            android_word("https://x.y/z?q=1"),
            "'https://x.y/z?q=1'",
            "query quoted"
        );
        assert_eq!(number(&json!(52.0)), "52", "integer");
        assert_eq!(number(&json!(52.37)), "52.37", "fraction");
    }

    #[test]
    fn reads_the_focused_app() {
        let dump = "  mCurrentFocus=Window{abc u0 com.example.app/com.example.Main}";
        assert_eq!(
            focused_app(dump).as_deref(),
            Some("com.example.app"),
            "focus"
        );
        assert_eq!(
            last_size("Physical size: 1080x2400\nOverride size: 2400x1080"),
            Some((2400, 1080)),
            "size"
        );
    }
}
