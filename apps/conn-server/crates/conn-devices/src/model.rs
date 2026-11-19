//! The values the Device panel and the tools read: devices, sessions, host summaries and the
//! published `DeviceServiceState`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

pub const LOCAL_HOST_ID: &str = "local";
pub const LOCAL_HOST_LABEL: &str = "This machine";
/// `DEVICE_HUB_ROUTE_PREFIX`: the Device panel derives its stream URLs from it.
pub const HUB_BASE_PATH: &str = "/api/device-hub";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub host_id: String,
    pub id: String,
    pub platform: String,
    pub name: String,
    pub version: String,
    pub booted: bool,
    pub physical: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub thread_id: String,
    pub host_id: String,
    pub device_id: String,
    pub platform: String,
    pub opened_at: String,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct HostStatus {
    pub status: String,
    pub detail: Option<String>,
    /// T3 sends `detail: null` when the status it set named a detail without a value.
    pub detail_null: bool,
    pub android_incomplete: bool,
    pub incomplete_platforms: Vec<String>,
}

impl HostStatus {
    pub fn new(status: &str, detail: Option<String>) -> Self {
        Self {
            status: status.to_owned(),
            detail,
            ..Self::default()
        }
    }

    fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("status".into(), json!(self.status));
        if let Some(detail) = &self.detail {
            out.insert("detail".into(), json!(detail));
        } else if self.detail_null {
            out.insert("detail".into(), Value::Null);
        }
        if self.android_incomplete {
            out.insert("androidDiscoveryIncomplete".into(), json!(true));
        }
        if !self.incomplete_platforms.is_empty() {
            out.insert(
                "incompletePlatforms".into(),
                json!(self.incomplete_platforms),
            );
        }
        Value::Object(out)
    }
}

/// `DevicePlatformAvailability`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Availability {
    pub platform: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `DeviceHostSummary` for a `local` or `ssh` host.
#[derive(Clone, Debug, PartialEq)]
pub struct HostSummary {
    pub id: String,
    pub label: String,
    pub kind: &'static str,
    pub platforms: Vec<Availability>,
    pub tools: Option<Value>,
    pub tool_inspection_error: Option<String>,
    pub hub_installed: bool,
    pub agent_device_installed: bool,
}

impl HostSummary {
    pub fn empty(id: &str, label: &str, kind: &'static str) -> Self {
        Self {
            id: id.to_owned(),
            label: label.to_owned(),
            kind,
            platforms: Vec::new(),
            tools: None,
            tool_inspection_error: None,
            hub_installed: false,
            agent_device_installed: false,
        }
    }

    pub fn available(&self, platform: &str) -> bool {
        self.platforms
            .iter()
            .any(|p| p.platform == platform && p.available)
    }

    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("id".into(), json!(self.id));
        out.insert("label".into(), json!(self.label));
        out.insert("platforms".into(), json!(self.platforms));
        if let Some(tools) = &self.tools {
            out.insert("tools".into(), tools.clone());
        }
        if let Some(error) = &self.tool_inspection_error {
            out.insert("toolInspectionError".into(), json!(error));
        }
        out.insert("hubInstalled".into(), json!(self.hub_installed));
        out.insert(
            "agentDeviceInstalled".into(),
            json!(self.agent_device_installed),
        );
        out.insert("kind".into(), json!(self.kind));
        Value::Object(out)
    }
}

/// What `subscribeDeviceState` and the device methods publish.
#[derive(Clone, Debug, Default)]
pub struct State {
    pub hosts: Vec<HostSummary>,
    pub host_status: String,
    /// `None`: no key. `Some(None)`: `null`, as T3 sends once it set the local host's detail.
    pub host_status_detail: Option<Option<String>>,
    pub host_statuses: BTreeMap<String, HostStatus>,
    pub devices: Vec<Device>,
    pub sessions: Vec<Session>,
    /// `None` until the first boot, as T3 leaves the key out until then.
    pub booting: Option<Vec<(Device, String)>>,
    pub onboarding_completed: bool,
    pub agent_access_enabled: bool,
    pub supports_tool_update: bool,
    pub revision: i64,
}

impl State {
    /// The wire form (`DeviceServiceStateWire`): Expo and Simlock hosts travel apart, and this
    /// server has none.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("supportsHostRetry".into(), json!(true));
        out.insert(
            "supportsToolUpdate".into(),
            json!(self.supports_tool_update),
        );
        out.insert("supportsToolInspection".into(), json!(true));
        out.insert(
            "hosts".into(),
            Value::Array(self.hosts.iter().map(HostSummary::to_json).collect()),
        );
        out.insert("hostStatus".into(), json!(self.host_status));
        if let Some(detail) = &self.host_status_detail {
            out.insert("hostStatusDetail".into(), json!(detail));
        }
        out.insert(
            "hostStatuses".into(),
            Value::Object(
                self.host_statuses
                    .iter()
                    .map(|(id, status)| (id.clone(), status.to_json()))
                    .collect(),
            ),
        );
        out.insert("devices".into(), json!(self.devices));
        out.insert("sessions".into(), json!(self.sessions));
        if let Some(booting) = &self.booting {
            out.insert(
                "bootingDevices".into(),
                Value::Array(
                    booting
                        .iter()
                        .map(|(device, thread)| {
                            let mut value = json!(device);
                            value["threadId"] = json!(thread);
                            value
                        })
                        .collect(),
                ),
            );
        }
        out.insert(
            "onboardingCompleted".into(),
            json!(self.onboarding_completed),
        );
        out.insert(
            "agentAccessEnabled".into(),
            json!(self.agent_access_enabled),
        );
        out.insert("hubBasePath".into(), json!(HUB_BASE_PATH));
        out.insert("revision".into(), json!(self.revision));
        out.insert("easHosts".into(), json!([]));
        out.insert("simlockHosts".into(), json!([]));
        Value::Object(out)
    }
}
