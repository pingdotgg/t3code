//! The four device tools agents call over `/mcp` (`toolkits/device/handlers.ts`). The caller is
//! a thread with device access; `conn-mcp` checks that and renders the answers.

use serde_json::{Value, json};

use crate::{
    agent,
    errors::DeviceError,
    hub,
    model::{Device, LOCAL_HOST_ID, Session},
    service::Devices,
};

const SUPPORT_OFF: &str = "Device support is off. Ask the user to enable it in the Device panel before installing or starting device tools.";
const NO_AGENT_ACCESS: &str = "Agent device access requires enabled device support, agent access, and an available simulator platform on this host.";

/// `requireDeviceAccess`: the text a thread without device access gets.
pub const ACCESS_OFF: &str = "Agent device access is turned off for this environment. Ask the user to turn on the Device hub and Agent device access in Settings > Integrations > Devices; it applies when the agent session next starts, such as in a new thread.";

fn hosts(state: &Value) -> Vec<(String, String)> {
    state["hosts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|h| {
            (
                h["id"].as_str().unwrap_or_default().to_owned(),
                h["label"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect()
}

fn utf16_prefix(text: &str, units: usize) -> String {
    let encoded: Vec<u16> = text.encode_utf16().take(units).collect();
    String::from_utf16_lossy(&encoded)
}

/// `resolveHostId`: an id, or a label that names one host.
pub fn resolve_host_id(
    state: &Value,
    host_id: Option<&str>,
) -> Result<Option<String>, DeviceError> {
    let Some(selector) = host_id.filter(|h| !h.is_empty()) else {
        return Ok(None);
    };
    let all = hosts(state);
    if let Some((id, _)) = all.iter().find(|(id, _)| id == selector) {
        return Ok(Some(id.clone()));
    }
    let labelled: Vec<&(String, String)> = all
        .iter()
        .filter(|(_, label)| label.to_lowercase() == selector.to_lowercase())
        .collect();
    if let [only] = labelled.as_slice() {
        return Ok(Some(only.0.clone()));
    }
    let candidates: Vec<&(String, String)> = if labelled.len() > 1 {
        labelled.clone()
    } else {
        all.iter().collect()
    };
    let mut listed: Vec<String> = candidates
        .iter()
        .take(10)
        .map(|(id, label)| format!("{} ({id})", utf16_prefix(label, 64)))
        .collect();
    if candidates.len() > 10 {
        listed.push(format!("{} more", candidates.len() - 10));
    }
    let listed = listed.join(", ");
    let selector = utf16_prefix(selector, 128);
    Err(DeviceError::tool(if labelled.len() > 1 {
        format!("Several device hosts are named {selector}; pass one id: {listed}.")
    } else {
        format!(
            "No device host {selector}. Known hosts: {}.",
            if listed.is_empty() { "none" } else { &listed }
        )
    }))
}

fn label_of(state: &Value, id: &str) -> Option<String> {
    hosts(state)
        .into_iter()
        .find(|(h, _)| h == id)
        .map(|(_, l)| l)
}

fn host_name(id: &str, label: Option<&str>) -> String {
    match label {
        None => format!("hostId {id}"),
        Some(label) => format!("'{label}' (hostId {id})"),
    }
}

fn named(state: &Value, id: &str) -> String {
    host_name(id, label_of(state, id).as_deref())
}

fn failed_detail(state: &Value, host_id: &str) -> Option<String> {
    let status = &state["hostStatuses"][host_id];
    (status["status"] == "failed")
        .then(|| status["detail"].as_str().map(str::to_owned))
        .flatten()
        .filter(|d| !d.is_empty())
}

/// `locate`: the one host an id is on, among `matches` (host ids, in order).
fn locate(
    state: &Value,
    device_id: &str,
    host_id: Option<&str>,
    matches: &[String],
) -> Result<Option<usize>, DeviceError> {
    let on_host: Vec<usize> = matches
        .iter()
        .enumerate()
        .filter(|(_, h)| host_id.is_none_or(|id| *h == id))
        .map(|(i, _)| i)
        .collect();
    let mut ids: Vec<&String> = Vec::new();
    for &i in &on_host {
        if let Some(h) = matches.get(i)
            && !ids.contains(&h)
        {
            ids.push(h);
        }
    }
    if ids.len() == 1 {
        return Ok(on_host.last().copied());
    }
    if ids.len() > 1 {
        let list: Vec<String> = ids.iter().map(|h| named(state, h)).collect();
        return Err(DeviceError::tool(format!(
            "Device {device_id} is on more than one host: {}. Pass hostId.",
            list.join(", ")
        )));
    }
    let mut elsewhere: Vec<&String> = Vec::new();
    for h in matches {
        if !elsewhere.contains(&h) {
            elsewhere.push(h);
        }
    }
    match host_id {
        Some(id) if !elsewhere.is_empty() => {
            let list: Vec<String> = elsewhere.iter().map(|h| named(state, h)).collect();
            Err(DeviceError::tool(format!(
                "Device {device_id} is not on {}. It is on {}; pass that hostId.",
                named(state, id),
                list.join(", ")
            )))
        }
        _ => Ok(None),
    }
}

fn devices_of(state: &Value) -> Vec<Device> {
    serde_json::from_value(state["devices"].clone()).unwrap_or_default()
}

fn sessions_of(state: &Value) -> Vec<Session> {
    serde_json::from_value(state["sessions"].clone()).unwrap_or_default()
}

fn pick(
    state: &Value,
    device_id: Option<&str>,
    platform: Option<&str>,
    host_id: Option<&str>,
) -> Result<Device, DeviceError> {
    let devices = devices_of(state);
    if let Some(device_id) = device_id {
        let found: Vec<&Device> = devices.iter().filter(|d| d.id == device_id).collect();
        let host_ids: Vec<String> = found.iter().map(|d| d.host_id.clone()).collect();
        if let Some(i) = locate(state, device_id, host_id, &host_ids)? {
            return found
                .get(i)
                .map(|d| (*d).clone())
                .ok_or_else(|| DeviceError::tool("No device."));
        }
        let mut parts = vec![format!(
            "No device {device_id} on {}.",
            host_id.map_or_else(|| "any host".to_owned(), |id| named(state, id))
        )];
        let targets: Vec<String> = match host_id {
            Some(id) => vec![id.to_owned()],
            None => hosts(state).into_iter().map(|(id, _)| id).collect(),
        };
        for id in targets {
            if let Some(detail) = failed_detail(state, &id) {
                parts.push(format!("{} failed to start: {detail}", named(state, &id)));
            }
        }
        parts.push("Call device_list for current ids.".into());
        return Err(DeviceError::tool(parts.join(" ")));
    }
    let host = host_id.unwrap_or(LOCAL_HOST_ID);
    let candidates: Vec<&Device> = devices
        .iter()
        .filter(|d| d.host_id == host && platform.is_none_or(|p| d.platform == p))
        .collect();
    if candidates.is_empty() {
        return Err(DeviceError::tool(
            match (failed_detail(state, host), platform) {
                (Some(detail), _) => detail,
                (None, None) => {
                    "No simulators or emulators were found. Call device_list to see why.".into()
                }
                (None, Some(p)) => format!(
                    "No {p} devices were found on host {host}. Call device_list to see why."
                ),
            },
        ));
    }
    let both = candidates.iter().any(|d| d.platform == "ios")
        && candidates.iter().any(|d| d.platform == "android");
    if platform.is_none() && both {
        return Err(DeviceError::tool(
            "Both iOS and Android devices are available; pass platform or deviceId.",
        ));
    }
    Ok(candidates
        .iter()
        .find(|d| d.booted)
        .or(candidates.first())
        .map(|d| (*d).clone())
        .unwrap_or_else(unreachable_device))
}

fn unreachable_device() -> Device {
    Device {
        host_id: String::new(),
        id: String::new(),
        platform: String::new(),
        name: String::new(),
        version: String::new(),
        booted: false,
        physical: false,
    }
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

/// `device_list`.
pub async fn device_list(
    devices: &Devices,
    thread_id: &str,
    args: &Value,
) -> Result<Value, DeviceError> {
    let state = devices.list().await;
    if state["hostStatus"] == "disabled" {
        return Err(DeviceError::tool(SUPPORT_OFF));
    }
    let host_id = resolve_host_id(&state, str_arg(args, "hostId"))?;
    let open: Vec<Value> = sessions_of(&state)
        .iter()
        .filter(|s| s.thread_id == thread_id)
        .map(|s| json!({ "hostId": s.host_id, "deviceId": s.device_id }))
        .collect();
    let keep = |id: &str| host_id.as_deref().is_none_or(|h| h == id);
    let statuses: serde_json::Map<String, Value> = state["hostStatuses"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(id, _)| keep(id))
        .map(|(id, v)| (id.clone(), v.clone()))
        .collect();
    let host_list: Vec<Value> = state["hosts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|h| keep(h["id"].as_str().unwrap_or_default()))
        .cloned()
        .collect();
    let device_list: Vec<Value> = state["devices"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|d| keep(d["hostId"].as_str().unwrap_or_default()))
        .cloned()
        .collect();
    Ok(
        json!({ "hostStatuses": statuses, "hosts": host_list, "devices": device_list, "open": open }),
    )
}

/// `device_open`.
pub async fn device_open(
    devices: &Devices,
    thread_id: &str,
    args: &Value,
) -> Result<Value, DeviceError> {
    let state = devices.list().await;
    if state["hostStatus"] == "disabled" {
        return Err(DeviceError::tool(SUPPORT_OFF));
    }
    let host_id = resolve_host_id(&state, str_arg(args, "hostId"))?;
    let target = pick(
        &state,
        str_arg(args, "deviceId"),
        str_arg(args, "platform"),
        host_id.as_deref(),
    )?;
    if devices
        .agent_readiness_if_supported(Some(&target.host_id))
        .await?
        .is_none()
    {
        return Err(DeviceError::tool(NO_AGENT_ACCESS));
    }
    let session = devices
        .open(&json!({
            "threadId": thread_id,
            "hostId": target.host_id,
            "deviceId": target.id,
            "platform": target.platform,
        }))
        .await?;
    let device = devices_of(&devices.state())
        .into_iter()
        .find(|d| d.host_id == session.host_id && d.id == session.device_id)
        .unwrap_or(target);
    let (agent_id, agent_session, flags) = devices
        .agent_target(thread_id, &session.host_id, &session.device_id)
        .await?;
    let mut target_args = agent::target_args(&device, &agent_id);
    target_args.extend(flags);
    let Some(command) = devices
        .agent_launcher(
            thread_id,
            &session.host_id,
            &session.device_id,
            target_args.clone(),
        )
        .await?
    else {
        return Err(DeviceError::tool(
            "The device was closed while device_open was preparing it. Call device_open again only if you still need it.",
        ));
    };
    Ok(json!({
        "device": device,
        "agentDevice": { "command": command, "targetArgs": target_args, "session": agent_session },
        "quickStart": agent::quick_start(&device, &command),
    }))
}

/// `device_screenshot`: the metadata and the PNG, base64.
pub async fn device_screenshot(
    devices: &Devices,
    thread_id: &str,
    args: &Value,
) -> Result<(Value, String), DeviceError> {
    let state = devices.state();
    let host_id = match str_arg(args, "hostId") {
        Some(id) => resolve_host_id(&state, Some(id))?,
        None => None,
    };
    let sessions: Vec<Session> = devices.sessions_for_thread(thread_id);
    let target = match str_arg(args, "deviceId") {
        None => sessions
            .iter()
            .rev()
            .find(|s| host_id.as_deref().is_none_or(|h| s.host_id == h))
            .cloned(),
        Some(device_id) => {
            let matches: Vec<&Session> = sessions
                .iter()
                .filter(|s| s.device_id == device_id)
                .collect();
            let ids: Vec<String> = matches.iter().map(|s| s.host_id.clone()).collect();
            locate(&state, device_id, host_id.as_deref(), &ids)?
                .and_then(|i| matches.get(i).map(|s| (*s).clone()))
        }
    };
    let Some(target) = target else {
        return Err(DeviceError::tool(match str_arg(args, "deviceId") {
            None => "No device is open in this thread. Call device_open first.".to_owned(),
            Some(id) => format!("Device {id} is not open in this thread. Call device_open first."),
        }));
    };
    let (device, png) = devices
        .screenshot(Some(&target.host_id), &target.device_id)
        .await?;
    let (width, height) = hub::png_dimensions(&png);
    Ok((
        json!({
            "device": device,
            "screenshot": { "mimeType": "image/png", "width": width, "height": height },
        }),
        conn_support::base64::encode(&png),
    ))
}

/// The text `device_screenshot` fails with.
pub fn screenshot_failure_text(error: &DeviceError) -> String {
    match error {
        DeviceError::Operation {
            reason: "hub_rejected",
            ..
        } => format!(
            "{} Call device_list to check the device state, and device_open if it needs to be reopened.",
            error.message()
        ),
        other => other.message(),
    }
}

/// `device_close`.
pub async fn device_close(
    devices: &Devices,
    thread_id: &str,
    args: &Value,
) -> Result<Value, DeviceError> {
    let state = devices.state();
    let input_host = match str_arg(args, "hostId") {
        Some(id) => resolve_host_id(&state, Some(id))?,
        None => None,
    };
    let device_id = str_arg(args, "deviceId");
    let open_host = match device_id {
        Some(device_id) => {
            let sessions = devices.sessions_for_thread(thread_id);
            let matches: Vec<&Session> = sessions
                .iter()
                .filter(|s| s.device_id == device_id)
                .collect();
            let ids: Vec<String> = matches.iter().map(|s| s.host_id.clone()).collect();
            locate(&state, device_id, input_host.as_deref(), &ids)?
                .and_then(|i| matches.get(i).map(|s| s.host_id.clone()))
        }
        None => None,
    };
    let host_id = open_host.or(input_host);
    let mut input = json!({ "threadId": thread_id });
    if let Some(host) = host_id {
        input["hostId"] = json!(host);
    }
    if let Some(device) = device_id {
        input["deviceId"] = json!(device);
    }
    if let Some(shutdown) = args.get("shutdown").and_then(Value::as_bool) {
        input["shutdown"] = json!(shutdown);
    }
    devices.close(&input).await?;
    Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> Value {
        json!({
            "hosts": [{"id":"local","label":"This machine"},{"id":"mac","label":"Studio"}],
            "hostStatuses": {"mac": {"status":"failed","detail":"No SSH."}},
            "devices": [
                {"hostId":"local","id":"a","platform":"ios","name":"A","version":"iOS 26","booted":false,"physical":false},
                {"hostId":"mac","id":"a","platform":"ios","name":"A","version":"iOS 26","booted":true,"physical":false},
            ],
        })
    }

    #[test]
    fn resolves_hosts_by_id_or_label() {
        let s = state();
        assert_eq!(
            resolve_host_id(&s, Some("studio"))
                .ok()
                .flatten()
                .as_deref(),
            Some("mac"),
            "label"
        );
        let error = resolve_host_id(&s, Some("nope")).err().map(|e| e.message());
        assert_eq!(
            error.as_deref(),
            Some("No device host nope. Known hosts: This machine (local), Studio (mac)."),
            "unknown"
        );
    }

    #[test]
    fn picks_like_t3() {
        let s = state();
        let ambiguous = pick(&s, Some("a"), None, None).err().map(|e| e.message());
        assert_eq!(
            ambiguous.as_deref(),
            Some(
                "Device a is on more than one host: 'This machine' (hostId local), 'Studio' (hostId mac). Pass hostId."
            ),
            "ambiguous"
        );
        let missing = pick(&s, Some("b"), None, Some("mac"))
            .err()
            .map(|e| e.message());
        assert_eq!(
            missing.as_deref(),
            Some(
                "No device b on 'Studio' (hostId mac). 'Studio' (hostId mac) failed to start: No SSH. Call device_list for current ids."
            ),
            "missing"
        );
        assert_eq!(
            pick(&s, None, None, None)
                .ok()
                .map(|d| d.host_id)
                .as_deref(),
            Some("local"),
            "default"
        );
    }
}
