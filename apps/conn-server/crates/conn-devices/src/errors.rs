//! The contract's device errors (`packages/contracts/src/device.ts`): the tagged value a client
//! decodes, and the message its getter shows, which the device tools send as text.

use serde_json::{Map, Value, json};

/// One `DeviceError` (or `DeviceToolUnavailableError`) as it goes on the wire.
#[derive(Clone, Debug, PartialEq)]
pub enum DeviceError {
    HostUnavailable {
        host_id: String,
        host_label: Option<String>,
        reason: String,
    },
    PlatformUnavailable {
        host_id: String,
        platform: String,
        reason: String,
    },
    NotFound {
        host_id: String,
        device_id: String,
    },
    Boot {
        host_id: String,
        device_id: String,
        /// `disk_space`, `timeout` or `launch_failed`.
        reason: &'static str,
        diagnostics: Option<String>,
    },
    Operation {
        operation: String,
        /// `command_failed`, `request_failed`, `invalid_payload`, `settings_failed`,
        /// `hub_rejected` or `package_manager_missing`.
        reason: &'static str,
        exit_code: Option<i64>,
        cause: String,
    },
    ActionUnavailable {
        operation: String,
        platform: String,
        /// `unsupported` or `helper_missing`.
        reason: &'static str,
    },
    /// Only the device tools fail with this one.
    ToolUnavailable {
        reason: String,
    },
}

impl DeviceError {
    pub fn host(host_id: &str, host_label: Option<&str>, reason: impl Into<String>) -> Self {
        Self::HostUnavailable {
            host_id: host_id.to_owned(),
            host_label: host_label.map(str::to_owned),
            reason: reason.into(),
        }
    }

    pub fn operation(operation: &str, reason: &'static str, cause: impl Into<String>) -> Self {
        Self::Operation {
            operation: operation.to_owned(),
            reason,
            exit_code: None,
            cause: cause.into(),
        }
    }

    pub fn command_failed(operation: &str, exit_code: i64, cause: impl Into<String>) -> Self {
        Self::Operation {
            operation: operation.to_owned(),
            reason: "command_failed",
            exit_code: Some(exit_code),
            cause: cause.into(),
        }
    }

    pub fn tool(reason: impl Into<String>) -> Self {
        Self::ToolUnavailable {
            reason: reason.into(),
        }
    }

    pub fn tag(&self) -> &'static str {
        match self {
            Self::HostUnavailable { .. } => "DeviceHostUnavailableError",
            Self::PlatformUnavailable { .. } => "DevicePlatformUnavailableError",
            Self::NotFound { .. } => "DeviceNotFoundError",
            Self::Boot { .. } => "DeviceBootError",
            Self::Operation { .. } => "DeviceOperationError",
            Self::ActionUnavailable { .. } => "DeviceActionUnavailableError",
            Self::ToolUnavailable { .. } => "DeviceToolUnavailableError",
        }
    }

    /// The encoded error. A `Schema.Defect` cause goes as its text: clients decode any value.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("_tag".into(), json!(self.tag()));
        match self {
            Self::HostUnavailable {
                host_id,
                host_label,
                reason,
            } => {
                out.insert("hostId".into(), json!(host_id));
                if let Some(label) = host_label {
                    out.insert("hostLabel".into(), json!(label));
                }
                out.insert("reason".into(), json!(reason));
            }
            Self::PlatformUnavailable {
                host_id,
                platform,
                reason,
            } => {
                out.insert("hostId".into(), json!(host_id));
                out.insert("platform".into(), json!(platform));
                out.insert("reason".into(), json!(reason));
            }
            Self::NotFound { host_id, device_id } => {
                out.insert("hostId".into(), json!(host_id));
                out.insert("deviceId".into(), json!(device_id));
            }
            Self::Boot {
                host_id,
                device_id,
                reason,
                diagnostics,
            } => {
                out.insert("hostId".into(), json!(host_id));
                out.insert("deviceId".into(), json!(device_id));
                out.insert("reason".into(), json!(reason));
                if let Some(text) = diagnostics {
                    out.insert("diagnostics".into(), json!(text));
                }
                out.insert(
                    "cause".into(),
                    json!(diagnostics.clone().unwrap_or_default()),
                );
            }
            Self::Operation {
                operation,
                reason,
                exit_code,
                cause,
            } => {
                out.insert("operation".into(), json!(operation));
                out.insert("reason".into(), json!(reason));
                if let Some(code) = exit_code {
                    out.insert("exitCode".into(), json!(code));
                }
                out.insert("cause".into(), json!(cause));
            }
            Self::ActionUnavailable {
                operation,
                platform,
                reason,
            } => {
                out.insert("operation".into(), json!(operation));
                out.insert("platform".into(), json!(platform));
                out.insert("reason".into(), json!(reason));
            }
            Self::ToolUnavailable { reason } => {
                out.insert("reason".into(), json!(reason));
            }
        }
        Value::Object(out)
    }

    /// The `message` getter of the contract class.
    pub fn message(&self) -> String {
        match self {
            Self::HostUnavailable {
                host_id,
                host_label,
                reason,
            } => format!(
                "{} is unavailable: {reason}",
                host_label
                    .clone()
                    .unwrap_or_else(|| format!("Device host {host_id}"))
            ),
            Self::PlatformUnavailable {
                host_id,
                platform,
                reason,
            } => format!("{platform} devices are unavailable on host {host_id}: {reason}"),
            Self::NotFound { host_id, device_id } => {
                format!("Device {device_id} was not found on host {host_id}.")
            }
            Self::Boot {
                device_id,
                reason,
                diagnostics,
                ..
            } => {
                let explanation = match *reason {
                    "disk_space" => "There is not enough free disk space on its device host.",
                    "timeout" => "The device did not become ready in time.",
                    _ => "The simulator or emulator could not start.",
                };
                let summary = format!("Device {device_id} failed to boot: {explanation}");
                match diagnostics {
                    Some(text) if !text.is_empty() => format!("{summary}\n\n{text}"),
                    _ => format!(
                        "{summary} The device host sent no details. Try again or open another device; if it keeps failing, check the device on that host."
                    ),
                }
            }
            Self::Operation {
                operation,
                reason,
                exit_code,
                ..
            } => {
                let explanation = match *reason {
                    "command_failed" => format!(
                        "The device command failed{}.",
                        exit_code
                            .map(|code| format!(" (exit code {code})"))
                            .unwrap_or_default()
                    ),
                    "request_failed" => {
                        "Could not communicate with device support. Try refreshing devices.".into()
                    }
                    "invalid_payload" => "The device request could not be encoded.".into(),
                    "settings_failed" => "Could not read or save device settings.".into(),
                    "hub_rejected" => "The device hub could not complete the request.".into(),
                    _ => "Device support needs npm, which is not on the Conn Server's PATH. Install npm (it comes with Node.js from nodejs.org), restart Conn, then retry.".into(),
                };
                format!("Device {operation} failed: {explanation}")
            }
            Self::ActionUnavailable {
                operation,
                platform,
                reason,
            } => {
                if *reason == "helper_missing" {
                    format!(
                        "Device {operation} requires a helper missing from this install. Set up device support again."
                    )
                } else {
                    format!("Device {operation} is not supported on {platform}.")
                }
            }
            Self::ToolUnavailable { reason } => reason.clone(),
        }
    }
}

impl std::fmt::Display for DeviceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for DeviceError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_follow_the_contract_getters() {
        assert_eq!(
            DeviceError::host("mac", Some("Studio"), "Unknown host.").message(),
            "Studio is unavailable: Unknown host."
        );
        assert_eq!(
            DeviceError::host("mac", None, "Unknown host.").message(),
            "Device host mac is unavailable: Unknown host."
        );
        assert_eq!(
            DeviceError::command_failed("appearance", 3, "x").message(),
            "Device appearance failed: The device command failed (exit code 3)."
        );
        let json = DeviceError::NotFound {
            host_id: "local".into(),
            device_id: "d".into(),
        }
        .to_json();
        assert_eq!(json["_tag"], "DeviceNotFoundError", "tag");
    }
}
