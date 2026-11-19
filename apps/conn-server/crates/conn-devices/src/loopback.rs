//! `isLocalSshDeviceHost`: an SSH host that leads back to this machine is the local host, so
//! it is not listed twice.

use std::net::IpAddr;
use std::time::Duration;

use crate::ssh::{SshConfig, run_ssh};

fn local_addresses() -> Vec<IpAddr> {
    nix::ifaddrs::getifaddrs()
        .map(|addresses| {
            addresses
                .filter_map(|a| a.address)
                .filter_map(|a| {
                    a.as_sockaddr_in()
                        .map(|v4| IpAddr::V4(v4.ip()))
                        .or_else(|| a.as_sockaddr_in6().map(|v6| IpAddr::V6(v6.ip())))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn unmapped(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(address, IpAddr::V4),
        v4 => v4,
    }
}

/// Reads `ssh -G`: port 22, no proxy, and a host name whose every address is this machine's.
pub(crate) async fn is_local_ssh_host(config: &SshConfig) -> bool {
    let mut pre = vec!["-G".to_owned()];
    if let Some(file) = &config.identity_file {
        pre.extend(["-i".to_owned(), file.clone()]);
    }
    let Ok((stdout, _)) = run_ssh(config, &pre, &[], None, Some(5_000)).await else {
        return false;
    };
    let mut values = std::collections::HashMap::new();
    for line in stdout.lines() {
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        values.insert(key.to_owned(), value.trim().to_owned());
    }
    if values.get("port").map(String::as_str) != Some("22")
        || ["proxycommand", "proxyjump"]
            .iter()
            .any(|key| values.get(*key).is_some_and(|v| v != "none"))
    {
        return false;
    }
    let Some(hostname) = values
        .get("hostname")
        .map(|h| h.trim_start_matches('[').trim_end_matches(']').to_owned())
        .filter(|h| !h.is_empty())
    else {
        return false;
    };
    let addresses: Vec<IpAddr> = match hostname.parse::<IpAddr>() {
        Ok(ip) => vec![ip],
        Err(_) => tokio::time::timeout(
            Duration::from_secs(2),
            tokio::net::lookup_host((hostname.as_str(), 0)),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .map(|found| found.map(|a| a.ip()).collect())
        .unwrap_or_default(),
    };
    let local = local_addresses();
    !addresses.is_empty()
        && addresses
            .into_iter()
            .map(unmapped)
            .all(|address| local.contains(&address) || address.is_loopback())
}
