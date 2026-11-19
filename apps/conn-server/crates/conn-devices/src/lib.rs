//! Device hosts for the Device panel and the device tools (`apps/server/src/device` in T3):
//! iOS Simulators and Android Emulators on this machine, or on a Mac over SSH, which is the
//! main path for a server in a Linux container. `README.md` lists what is served and how it is
//! proven.
//!
//! - [`Devices`]: the service behind `device.*`, `subscribeDeviceState` and the hub proxy.
//! - [`tool_api`]: `device_list`, `device_open`, `device_screenshot`, `device_close`.

mod actions;
mod agent;
mod errors;
pub mod generated;
mod host;
pub mod http;
mod hub;
mod local;
mod loopback;
pub mod model;
mod process;
pub mod proxy;
mod service;
mod ssh;
pub mod tool_api;
mod tools;

pub use errors::DeviceError;
pub use generated::{AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION};
pub use hub::png_dimensions;
pub use service::{BoxFuture, Config, Devices, SettingsAccess, agent_device_access};
pub use ssh::SshConfig;

/// Locks a std mutex. A poisoned lock means a thread panicked while it held it: a bug, and with
/// `panic = "abort"` the release build already stopped there.
pub(crate) fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().expect("conn-devices lock poisoned")
}
