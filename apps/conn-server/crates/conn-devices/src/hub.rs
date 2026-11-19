//! Device operations against expo-device-hub (`DeviceHubOperations.ts`): list, boot, attach the
//! stream, shut down, screenshot.

use std::{collections::HashMap, future::Future, time::Duration};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    errors::DeviceError,
    generated::DEFAULT_DISPLAY_SCREENSHOT,
    host::{Host, Ready, RunOptions, RunResult},
    http,
};

const BOOT_TIMEOUT: Duration = Duration::from_secs(180);
const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(20);
/// Lets the hub's own 30 s simctl timeout report its cause first.
const LIST_TIMEOUT_SECONDS: u64 = 40;
/// expo-device-hub 0.22.1 returns no Android devices when avdmanager fails, before it runs adb.
const AVDMANAGER_LIST_FAILED: &str = "[android-utils] Failed to run `avdmanager list avd`";

/// A device as the host lists it (`HostDevice`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct HubDevice {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) version: String,
    pub(crate) platform: String,
    pub(crate) booted: bool,
    pub(crate) physical: bool,
}

#[derive(Deserialize)]
struct HubError {
    message: String,
    error: Option<String>,
}

#[derive(Deserialize)]
struct HubDeviceList {
    simulators: Vec<HubDevice>,
    emulators: Vec<HubDevice>,
    errors: Option<Vec<HubError>>,
}

#[derive(Deserialize)]
struct HubActionResult {
    ok: bool,
    id: Option<String>,
    serial: Option<String>,
    error: Option<String>,
    errors: Option<Vec<HubError>>,
}

#[derive(Debug, Default)]
pub(crate) struct Listing {
    pub(crate) devices: Vec<HubDevice>,
    pub(crate) detail: Option<String>,
    pub(crate) android_incomplete: bool,
    pub(crate) incomplete_platforms: Vec<String>,
}

fn vendor(platform: &str) -> &'static str {
    if platform == "ios" {
        "/vendor/serve-sim"
    } else {
        "/vendor/serve-emu"
    }
}

/// Hub diagnostics can carry a whole stderr dump.
fn bound(text: &str) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= 2_000 {
        return text.to_owned();
    }
    format!(
        "{}…",
        String::from_utf16_lossy(units.get(..1_999).unwrap_or_default())
    )
}

/// The hub's `error` is a `util.inspect` of Node's exec error; keep the lines before the stack.
fn error_head(error: &str) -> String {
    let lines: Vec<&str> = error.lines().collect();
    let first_frame = lines.iter().position(|line| {
        line.starts_with(char::is_whitespace) && line.trim_start().starts_with("at ")
    });
    lines
        .get(..first_frame.unwrap_or(lines.len()))
        .unwrap_or_default()
        .iter()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn simulator_list_failed(message: &str) -> bool {
    let Some(rest) = message.strip_prefix("[apple-utils] ") else {
        return false;
    };
    rest.strip_prefix("Failed to ").is_some_and(|r| {
        r.starts_with("run `xcrun simctl list devices")
            || r.starts_with("parse JSON output:")
            || r.starts_with("list devices:")
    }) || rest.starts_with("`xcrun simctl list devices --json` did not respond within ")
}

/// CoreSimulator can keep deleted devices; their plist read fails with ENOENT.
fn deleted_simulator(error: &HubError) -> bool {
    let Some(rest) = error
        .message
        .strip_prefix("[apple-utils] Failed to read CoreSimulator plist at ")
    else {
        return false;
    };
    let Some(at) = rest.rfind("/CoreSimulator/Devices/") else {
        return false;
    };
    let tail = rest
        .get(at + "/CoreSimulator/Devices/".len()..)
        .unwrap_or_default();
    let device_plist = tail
        .strip_suffix("/device.plist:")
        .is_some_and(|id| !id.is_empty() && !id.contains('/'));
    let text = error.error.as_deref().unwrap_or_default();
    let enoent = text
        .strip_prefix("Error:")
        .is_some_and(|r| r.trim_start().starts_with("ENOENT:"))
        || [
            "code: 'ENOENT'",
            "code: \"ENOENT\"",
            "code:'ENOENT'",
            "code:\"ENOENT\"",
        ]
        .iter()
        .any(|needle| text.contains(needle));
    device_plist && enoent
}

async fn hub_json<T: for<'de> Deserialize<'de>>(
    method: &str,
    url: &str,
    body: Option<&Value>,
    operation: &str,
    timeout: Duration,
) -> Result<T, DeviceError> {
    let failed = |cause: String| DeviceError::operation(operation, "request_failed", cause);
    let answer = http::fetch(method, url, &[], body, timeout, http::MAX_JSON_BYTES)
        .await
        .map_err(failed)?;
    if !(200..300).contains(&answer.status) {
        return Err(failed(format!("HTTP {}", answer.status)));
    }
    serde_json::from_slice(&answer.body).map_err(|e| failed(e.to_string()))
}

/// Mirrors the hub's own adb discovery for when it skips it; `None` when `adb` failed.
async fn list_adb_devices<F, Fut>(run: &F) -> Option<Vec<HubDevice>>
where
    F: Fn(&'static str, Vec<String>) -> Fut,
    Fut: Future<Output = RunResult>,
{
    let listed = run("adb", vec!["devices".into(), "-l".into()]).await;
    if listed.code != 0 {
        return None;
    }
    let serials: Vec<String> = listed
        .stdout
        .lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            match (words.next(), words.next()) {
                (Some(serial), Some("device")) => Some(serial.to_owned()),
                _ => None,
            }
        })
        .collect();
    let mut devices = Vec::new();
    for serial in serials {
        let getprop = run(
            "adb",
            vec![
                "-s".into(),
                serial.clone(),
                "shell".into(),
                "getprop".into(),
            ],
        )
        .await;
        let props: HashMap<&str, &str> = getprop
            .stdout
            .lines()
            .filter_map(|line| {
                let inner = line.trim().strip_prefix('[')?;
                let (key, rest) = inner.split_once("]: [")?;
                let value = rest.strip_suffix(']')?;
                (!key.contains(']')).then_some((key, value))
            })
            .collect();
        let emulator =
            props.get("ro.kernel.qemu") == Some(&"1") || props.get("ro.boot.qemu") == Some(&"1");
        let avd_name = if emulator {
            run(
                "adb",
                vec![
                    "-s".into(),
                    serial.clone(),
                    "emu".into(),
                    "avd".into(),
                    "name".into(),
                ],
            )
            .await
            .stdout
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty() && *line != "OK" && !line.starts_with("KO"))
            .map(str::to_owned)
        } else {
            None
        };
        let model = props.get("ro.product.model").filter(|m| !m.is_empty());
        let manufacturer = props
            .get("ro.product.manufacturer")
            .filter(|m| !m.is_empty());
        let release = props
            .get("ro.build.version.release")
            .filter(|r| !r.is_empty());
        let name = if emulator {
            avd_name.unwrap_or_else(|| serial.clone())
        } else if let Some(model) = model {
            manufacturer
                .map(|m| format!("{m} {model}"))
                .unwrap_or_else(|| (*model).to_owned())
        } else {
            serial.clone()
        };
        let version = match release {
            Some(r) if r.chars().all(|c| c.is_ascii_digit()) => format!("Android {r}.0"),
            Some(r) => format!("Android {r}"),
            None => "Android".into(),
        };
        devices.push(HubDevice {
            id: serial,
            name,
            platform: "android".into(),
            version,
            booted: true,
            physical: !emulator,
        });
    }
    Some(devices)
}

/// Adds the Android devices the hub could not list: adb devices when its avdmanager failed,
/// and AVDs that have not booted. Returns whether Android discovery is incomplete.
async fn add_android<F, Fut>(
    run: F,
    errors: &[HubError],
    devices: &mut Vec<HubDevice>,
    details: &mut Vec<String>,
) -> bool
where
    F: Fn(&'static str, Vec<String>) -> Fut,
    Fut: Future<Output = RunResult>,
{
    let mut incomplete = false;
    if errors
        .iter()
        .any(|e| e.message.starts_with(AVDMANAGER_LIST_FAILED))
    {
        match list_adb_devices(&run).await {
            Some(found) => devices.extend(found),
            None => {
                incomplete = true;
                details.push("Could not list Android devices (adb devices -l).".into());
            }
        }
    }
    let avds = run("emulator", vec!["-list-avds".into()]).await;
    if avds.code != 0 {
        details.push(format!(
            "Could not list Android virtual devices (emulator -list-avds, exit code {}). Discovered devices remain available.",
            avds.code
        ));
        return true;
    }
    for name in avds.stdout.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if !devices
            .iter()
            .any(|d| d.platform == "android" && d.name == name)
        {
            devices.push(HubDevice {
                id: name.into(),
                name: name.into(),
                platform: "android".into(),
                version: "Android".into(),
                booted: false,
                physical: false,
            });
        }
    }
    incomplete
}

pub(crate) async fn list(ready: &Ready, host: &Host) -> Result<Listing, DeviceError> {
    let url = format!("{}/api/devices", ready.hub_origin);
    let listed = tokio::time::timeout(
        Duration::from_secs(LIST_TIMEOUT_SECONDS),
        hub_json::<HubDeviceList>("GET", &url, None, "list", Duration::from_secs(3600)),
    )
    .await;
    let Ok(listed) = listed else {
        let mut incomplete = Vec::new();
        for platform in ["ios", "android"] {
            if host.platform_available(platform).await {
                incomplete.push(platform.to_owned());
            }
        }
        return Ok(Listing {
            detail: Some(format!(
                "The device hub did not answer within {LIST_TIMEOUT_SECONDS} seconds."
            )),
            incomplete_platforms: incomplete,
            ..Listing::default()
        });
    };
    let hub = listed?;
    let mut devices: Vec<HubDevice> = hub
        .simulators
        .iter()
        .chain(&hub.emulators)
        .cloned()
        .collect();
    let android = host.platform_available("android").await;
    let errors = hub.errors.unwrap_or_default();
    let mut details: Vec<String> = errors
        .iter()
        .filter(|e| {
            !(!android && e.message.starts_with("[android-utils] ")) && !deleted_simulator(e)
        })
        .map(|e| {
            let head = error_head(e.error.as_deref().unwrap_or_default());
            bound(&if head.is_empty() {
                e.message.clone()
            } else {
                format!("{} {head}", e.message)
            })
        })
        .collect();
    let android_incomplete = android
        && add_android(
            |command, args| async move { ready.run(command, &args, RunOptions::default()).await },
            &errors,
            &mut devices,
            &mut details,
        )
        .await;
    let simulators_unlisted =
        hub.simulators.is_empty() && errors.iter().any(|e| simulator_list_failed(&e.message));
    Ok(Listing {
        devices,
        detail: (!details.is_empty()).then(|| details.join("\n")),
        android_incomplete,
        incomplete_platforms: if simulators_unlisted {
            vec!["ios".into()]
        } else {
            Vec::new()
        },
    })
}

async fn attach_ios(ready: &Ready, udid: &str) -> Result<(), DeviceError> {
    hub_json::<HubActionResult>(
        "POST",
        &format!("{}/vendor/serve-sim/grid/api/start", ready.hub_origin),
        Some(&json!({ "udid": udid })),
        "attach stream",
        BOOT_TIMEOUT,
    )
    .await
    .map(|_| ())
}

/// Boots the device and attaches its stream; returns the id it has now (Android AVD names
/// become emulator serials).
pub(crate) async fn boot(ready: &Ready, device: &HubDevice) -> Result<String, DeviceError> {
    let result: HubActionResult = hub_json(
        "POST",
        &format!("{}/api/devices/boot", ready.hub_origin),
        Some(&json!({ "platform": device.platform, "id": device.id, "name": device.name })),
        "boot",
        BOOT_TIMEOUT,
    )
    .await?;
    if !result.ok {
        let diagnostics: Vec<String> = result
            .error
            .iter()
            .cloned()
            .chain(
                result
                    .errors
                    .iter()
                    .flatten()
                    .flat_map(|e| [Some(e.message.clone()), e.error.clone()])
                    .flatten(),
            )
            .filter(|t| !t.trim().is_empty())
            .collect();
        let text = diagnostics.join("\n\n");
        let lower = text.to_lowercase();
        let disk = ["insufficient", "not enough"].iter().any(|w| {
            lower.find(w).is_some_and(|at| {
                let rest = lower.get(at..).unwrap_or_default();
                rest.contains("disk") || rest.contains("space")
            })
        }) || lower.contains("no space left");
        let timeout = lower.contains("timed out")
            || lower.contains("time out")
            || lower.contains("timeout")
            || lower.contains("timedout");
        return Err(DeviceError::Boot {
            host_id: ready.host_id.clone(),
            device_id: device.id.clone(),
            reason: if disk {
                "disk_space"
            } else if timeout {
                "timeout"
            } else {
                "launch_failed"
            },
            diagnostics: (!text.is_empty()).then(|| bound(&text)),
        });
    }
    if device.platform == "ios" {
        attach_ios(ready, &device.id).await?;
    }
    Ok(result
        .serial
        .or(result.id)
        .unwrap_or_else(|| device.id.clone()))
}

/// Prepares the stream of a device that already runs.
pub(crate) async fn attach(ready: &Ready, device: &HubDevice) -> Result<(), DeviceError> {
    if device.platform == "ios" {
        attach_ios(ready, &device.id).await?;
    }
    Ok(())
}

async fn post_shutdown(ready: &Ready, path: &str, body: Value) -> Result<(), DeviceError> {
    let result: HubActionResult = hub_json(
        "POST",
        &format!("{}{path}", ready.hub_origin),
        Some(&body),
        "shutdown",
        Duration::from_secs(15),
    )
    .await?;
    if result.ok {
        Ok(())
    } else {
        Err(DeviceError::operation(
            "shutdown",
            "hub_rejected",
            "The hub refused the shutdown.",
        ))
    }
}

/// serve-sim's shutdown closes its capture session before `simctl shutdown`; it fails for a
/// simulator that is already off, which counts as done.
pub(crate) async fn shutdown(
    ready: &Ready,
    host: &Host,
    id: &str,
    platform: &str,
) -> Result<(), DeviceError> {
    if platform != "ios" {
        return post_shutdown(
            ready,
            "/api/devices/shutdown",
            json!({ "platform": platform, "id": id }),
        )
        .await;
    }
    match post_shutdown(
        ready,
        "/vendor/serve-sim/grid/api/shutdown",
        json!({ "udid": id }),
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(error) => {
            let listing = list(ready, host).await?;
            if listing
                .devices
                .iter()
                .find(|d| d.id == id)
                .is_some_and(|d| !d.booted)
            {
                Ok(())
            } else {
                Err(error)
            }
        }
    }
}

/// Xcode 26 rejects the hub's numeric display ids; iOS 27 needs them.
fn runs_on_xcode26_runtime(version: &str) -> bool {
    version
        .strip_prefix("iOS ")
        .and_then(|rest| {
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            digits.parse::<u32>().ok()
        })
        .is_some_and(|major| major <= 26)
}

pub(crate) async fn screenshot(ready: &Ready, device: &HubDevice) -> Result<Vec<u8>, DeviceError> {
    let url = format!(
        "{}{}/api/screenshot?device={}",
        ready.hub_origin,
        vendor(&device.platform),
        encode_component(&device.id)
    );
    let answer = http::fetch(
        "POST",
        &url,
        &[],
        None,
        SCREENSHOT_TIMEOUT,
        http::MAX_IMAGE_BYTES,
    )
    .await;
    let rejected = match answer {
        Ok(answer) if (200..300).contains(&answer.status) => return Ok(answer.body),
        Ok(answer) => DeviceError::operation(
            "screenshot",
            "hub_rejected",
            format!("HTTP {}", answer.status),
        ),
        Err(cause) => {
            return Err(DeviceError::operation(
                "screenshot",
                "request_failed",
                cause,
            ));
        }
    };
    if !(device.platform == "ios" && runs_on_xcode26_runtime(&device.version)) {
        return Err(rejected);
    }
    let capture = ready
        .run(
            "sh",
            &[
                "-c".into(),
                DEFAULT_DISPLAY_SCREENSHOT.into(),
                "sh".into(),
                device.id.clone(),
            ],
            RunOptions {
                timeout_ms: Some(20_000),
                max_output: Some(crate::process::MAX_OUTPUT_BYTES),
                stdin: None,
            },
        )
        .await;
    if capture.code != 0 {
        return Err(DeviceError::command_failed(
            "screenshot",
            capture.code,
            capture.stderr.trim().to_owned(),
        ));
    }
    let text: String = capture.stdout.split_whitespace().collect();
    Ok(conn_support::base64::decode(&text).unwrap_or_default())
}

/// `encodeURIComponent`.
pub(crate) fn encode_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `extractPng`: the first complete PNG in `bytes`.
pub(crate) fn extract_png(bytes: &[u8]) -> Option<&[u8]> {
    const SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
    let start = bytes.windows(8).position(|w| w == SIGNATURE)?;
    let mut chunk = start + 8;
    while chunk + 12 <= bytes.len() {
        let length = u32::from_be_bytes(bytes.get(chunk..chunk + 4)?.try_into().ok()?) as usize;
        let end = chunk.checked_add(12)?.checked_add(length)?;
        if end > bytes.len() {
            return None;
        }
        if bytes.get(chunk + 4..chunk + 8)? == b"IEND" {
            return bytes.get(start..end);
        }
        chunk = end;
    }
    None
}

/// `pngDimensions`.
pub fn png_dimensions(png: &[u8]) -> (u32, u32) {
    let word = |at: usize| {
        png.get(at..at + 4)
            .and_then(|b| b.try_into().ok())
            .map(u32::from_be_bytes)
    };
    if png.len() >= 24
        && word(0) == Some(0x8950_4e47)
        && word(4) == Some(0x0d0a_1a0a)
        && word(12) == Some(0x4948_4452)
    {
        (word(16).unwrap_or(0), word(20).unwrap_or(0))
    } else {
        (0, 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_error_head() {
        assert_eq!(
            error_head("Error: boom\n  more\n    at x (y)\n  code: 1"),
            "Error: boom more",
            "head"
        );
    }

    #[test]
    fn recognises_failed_listings_and_deleted_simulators() {
        assert!(
            simulator_list_failed("[apple-utils] Failed to list devices: x"),
            "list"
        );
        assert!(
            !simulator_list_failed("[android-utils] Failed to list devices: x"),
            "android"
        );
        assert!(
            deleted_simulator(&HubError {
                message: "[apple-utils] Failed to read CoreSimulator plist at /U/Library/Developer/CoreSimulator/Devices/ABC/device.plist:".into(),
                error: Some("Error: ENOENT: no such file".into()),
            }),
            "deleted"
        );
    }

    /// expo-device-hub returns no Android devices once `avdmanager list avd` fails; adb still
    /// sees the phone (DeviceService.test.ts "lists adb-attached physical devices").
    #[tokio::test]
    async fn lists_adb_devices_when_the_hub_cannot_run_avdmanager() {
        let run = |command: &'static str, args: Vec<String>| {
            let stdout = if command == "adb" && args.iter().any(|a| a == "devices") {
                "List of devices attached\nR52T10ABCDE            device usb:1-1 product:gts9wifi model:SM_X710 device:gts9wifi transport_id:1\n\n"
            } else if command == "adb" && args.iter().any(|a| a == "getprop") {
                "[ro.product.manufacturer]: [samsung]\n[ro.product.model]: [SM-X710]\n[ro.build.version.release]: [15]\n"
            } else {
                ""
            };
            async move {
                RunResult {
                    stdout: stdout.into(),
                    stderr: String::new(),
                    code: 0,
                }
            }
        };
        let errors = vec![HubError {
            message: "[android-utils] Failed to run `avdmanager list avd`:".into(),
            error: Some(
                "Error: Command failed: avdmanager list avd\nUnable to locate a Java Runtime."
                    .into(),
            ),
        }];
        let mut devices = Vec::new();
        let mut details = Vec::new();
        let incomplete = add_android(run, &errors, &mut devices, &mut details).await;
        assert!(!incomplete, "complete");
        assert_eq!(
            devices,
            vec![HubDevice {
                id: "R52T10ABCDE".into(),
                name: "samsung SM-X710".into(),
                version: "Android 15.0".into(),
                platform: "android".into(),
                booted: true,
                physical: true,
            }],
            "adb phone"
        );
    }

    #[test]
    fn finds_a_png_between_warnings() {
        let mut png = vec![137, 80, 78, 71, 13, 10, 26, 10];
        png.extend([0, 0, 0, 0]);
        png.extend(b"IEND");
        png.extend([0, 0, 0, 0]);
        let mut bytes = b"warning\n".to_vec();
        bytes.extend(&png);
        bytes.extend(b"tail");
        assert_eq!(extract_png(&bytes), Some(png.as_slice()), "png");
        assert!(runs_on_xcode26_runtime("iOS 26.1"), "26");
        assert!(!runs_on_xcode26_runtime("iOS 27.0"), "27");
        assert!(!runs_on_xcode26_runtime("Android"), "android");
    }
}
