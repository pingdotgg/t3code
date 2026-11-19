//! `device.*` and `subscribeDeviceState`: the Device panel, on the device hosts of
//! `conn_devices` (simulators on this machine or on a Mac over SSH). Each payload decodes as
//! its contract type first, so a bad one fails as Effect's decoder fails it.
//!
//! `device.easAccount` and `device.simlockIdentity` answer with the T3 device service's own
//! typed error for a service without Expo or Simlock hosts; the state never offers those hosts
//! (`supportsEasHosts` and `supportsSimlockHosts` are left out).

use conn_contract::rpc::device;
use conn_devices::{DeviceError, Devices, SshConfig};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::Deps;
use crate::table::{CallContext, Failure, MethodTable};

fn fail(error: DeviceError) -> Failure {
    Failure::Fail(error.to_json())
}

fn value<T: Serialize>(payload: &T) -> Value {
    serde_json::to_value(payload).unwrap_or(Value::Null)
}

/// `SshDeviceHostConfig`'s filters, which the generated type does not hold: an id of letters,
/// digits, `_` and `-` that is not `local`, and a target without spaces that does not start
/// with `-`.
fn valid_host(config: &SshConfig) -> bool {
    let id = config.id.trim();
    let id_ok = id.len() <= 128
        && id != "local"
        && id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    let target = config.target.trim();
    let target_ok =
        !target.is_empty() && !target.starts_with('-') && !target.chars().any(char::is_whitespace);
    id_ok && target_ok && !config.label.trim().is_empty() && config.port != Some(0)
}

/// `requiredScopeForDeviceList`: a retry or a tool update operates; a listing reads.
fn list_scope(ctx: &CallContext, input: &Value) -> Result<(), Failure> {
    let operate = input.get("retryHostId").is_some_and(|v| !v.is_null())
        || input.get("updateTool").is_some_and(|v| !v.is_null());
    let scope = if operate {
        "orchestration:operate"
    } else {
        "orchestration:read"
    };
    match &ctx.principal {
        Some(principal) if !principal.has_scope(scope) => Err(Failure::Fail(json!({
            "_tag": "EnvironmentAuthorizationError",
            "message": format!("The authenticated token is missing required scope: {scope}."),
            "requiredScope": crate::auth::legacy_parent(scope),
            "requiredPermission": scope,
        }))),
        _ => Ok(()),
    }
}

pub(crate) fn register(table: &mut MethodTable, deps: &Deps) {
    let Some(devices) = deps.devices.clone() else {
        return;
    };

    let d = devices.clone();
    table.unary("device.list", move |ctx, input: device::list::Payload| {
        let devices = d.clone();
        async move {
            let input = value(&input);
            let update = input["updateTool"].as_str().map(str::to_owned);
            if input["inspectOnly"] == true && update.is_none() {
                return Ok(devices.inspect().await);
            }
            list_scope(&ctx, &input)?;
            if let Some(tool) = update {
                return devices.update_tool(&tool).await.map_err(fail);
            }
            if let Some(host) = input["retryHostId"].as_str() {
                return devices.retry_host(host).await.map_err(fail);
            }
            Ok(devices.list().await)
        }
    });

    let d = devices.clone();
    table.unary(
        "device.configure",
        move |_, input: device::configure::Payload| {
            let devices = d.clone();
            async move { devices.configure(&value(&input)).await.map_err(fail) }
        },
    );

    let d = devices.clone();
    table.unary("device.open", move |_, input: device::open::Payload| {
        let devices = d.clone();
        async move {
            devices
                .open(&value(&input))
                .await
                .map(|session| value(&session))
                .map_err(fail)
        }
    });

    let d = devices.clone();
    table.unary("device.close", move |_, input: device::close::Payload| {
        let devices = d.clone();
        async move {
            devices.close(&value(&input)).await.map_err(fail)?;
            Ok(Value::Null)
        }
    });

    let d = devices.clone();
    table.unary(
        "device.shutdown",
        move |_, input: device::shutdown::Payload| {
            let devices = d.clone();
            async move {
                devices.shutdown(&value(&input)).await.map_err(fail)?;
                Ok(Value::Null)
            }
        },
    );

    let d = devices.clone();
    table.unary("device.detail", move |_, input: device::detail::Payload| {
        let devices = d.clone();
        async move { devices.detail(&value(&input)).await.map_err(fail) }
    });

    let d = devices.clone();
    table.unary("device.action", move |_, input: device::action::Payload| {
        let devices = d.clone();
        async move { devices.action(&value(&input)).await.map_err(fail) }
    });

    let d = devices.clone();
    table.unary(
        "device.testHost",
        move |_, input: device::test_host::Payload| {
            let devices = d.clone();
            async move {
                let config: SshConfig = serde_json::from_value(value(&input))
                    .ok()
                    .filter(valid_host)
                    .ok_or_else(|| Failure::die("invalid SSH device host"))?;
                devices.test_host(config).await.map_err(fail)
            }
        },
    );

    table.unary(
        "device.easAccount",
        |_, _: device::eas_account::Payload| async {
            Err::<Value, _>(Failure::Fail(json!({
                "_tag": "DeviceEasAccountError",
                "reason": "Expo accounts are unavailable in this device service.",
            })))
        },
    );
    table.unary(
        "device.simlockIdentity",
        |_, _: device::simlock_identity::Payload| async {
            Err::<Value, _>(Failure::Fail(json!({
                "_tag": "DeviceSimlockIdentityError",
                "reason": "Simlock hosts are unavailable in this device service.",
            })))
        },
    );

    table.stream("subscribeDeviceState", move |_, _: Value| {
        let devices = devices.clone();
        async move { Ok(state_stream(&devices)) }
    });
}

/// The current state, then each change. A slow client skips states it has not read yet; the
/// newest one always arrives (a watch channel holds only the latest).
fn state_stream(devices: &Devices) -> crate::table::ItemStream {
    let mut changes = devices.subscribe();
    let (tx, rx) = mpsc::channel(1);
    let first = changes.borrow_and_update().clone();
    tokio::spawn(async move {
        if tx.send(Ok(first)).await.is_err() {
            return;
        }
        loop {
            tokio::select! {
                () = tx.closed() => return,
                changed = changes.changed() => {
                    if changed.is_err() {
                        return tx.closed().await;
                    }
                    let next = changes.borrow_and_update().clone();
                    if tx.send(Ok(next)).await.is_err() {
                        return;
                    }
                }
            }
        }
    });
    rx
}

/// The server settings as the device service reads and writes them.
struct EnvironmentSettings(std::sync::Arc<crate::environment::Environment>);

impl conn_devices::SettingsAccess for EnvironmentSettings {
    fn read(&self) -> serde_json::Map<String, Value> {
        self.0.settings.raw()
    }

    fn update(&self, patch: Value) -> conn_devices::BoxFuture<'static, Result<(), String>> {
        let environment = self.0.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                environment
                    .settings
                    .update(patch, None)
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())?
        })
    }

    fn changes(&self) -> tokio::sync::watch::Receiver<u64> {
        self.0.settings.subscribe()
    }
}

/// Starts the device service for this environment. Tools install under the T3 home, the
/// parent of the state folder (`<home>/userdata`).
pub(crate) fn start(environment: std::sync::Arc<crate::environment::Environment>) -> Devices {
    let state_dir = environment.state_dir.clone();
    let base_dir = state_dir
        .parent()
        .map_or_else(|| state_dir.clone(), std::path::Path::to_path_buf);
    Devices::start(conn_devices::Config {
        base_dir,
        cwd: environment.cwd.clone(),
        environment_id: environment.environment_id().to_owned(),
        settings: std::sync::Arc::new(EnvironmentSettings(environment.clone())),
        state_dir,
    })
}
