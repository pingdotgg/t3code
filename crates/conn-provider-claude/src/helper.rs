//! The `claude` driver of the SDK host (`conn_provider_support::sdk_host`).

pub use conn_provider_support::sdk_host::{
    Helper, HelperCommand, HostDriver, QueryEnd, QueryEvent, QueryHandle,
};

/// The SDK host driver this crate uses. Its commands keep T3's key order: the SDK passes
/// prompts, permission answers and MCP configs to the CLI verbatim.
pub const DRIVER: HostDriver = HostDriver {
    name: "claude",
    encode: crate::ordered::to_string,
};

/// The SDK host for one Claude provider instance.
pub fn claude_host(command: HelperCommand, instance_id: &str) -> Helper {
    Helper::new(command, instance_id, DRIVER)
}
