//! Public-resource SOCKS5 proxy for HTML captures; local addresses never leave this service.
use crate::Error;
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    task::JoinHandle,
};

#[derive(Debug)]
pub(crate) struct Proxy {
    pub port: u16,
    task: JoinHandle<()>,
    fake_hosts: Arc<Mutex<Vec<(String, String)>>>,
}
impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Proxy {
    pub(crate) async fn start() -> Result<Self, Error> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(super::err)?;
        let port = listener.local_addr().map_err(super::err)?.port();
        let slots = Arc::new(Semaphore::new(32));
        let fake_hosts = Arc::new(Mutex::new(Vec::new()));
        let notes = fake_hosts.clone();
        let task = tokio::spawn(async move {
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((client,_)) = accepted else { break; };
                        let Ok(slot) = slots.clone().try_acquire_owned() else { continue; };
                        let notes=notes.clone();
                        tasks.spawn(async move { let _slot=slot; let _=tokio::time::timeout(Duration::from_secs(30), connect(client,notes)).await; });
                    }
                    _ = tasks.join_next(), if !tasks.is_empty() => {}
                }
            }
        });
        Ok(Self {
            port,
            task,
            fake_hosts,
        })
    }
    pub(crate) fn warnings(&self) -> Vec<serde_json::Value> {
        let template = crate::spec::spec()
            .map(|s| s.html.fake_ip_template.clone())
            .unwrap_or_default();
        self.fake_hosts
            .lock()
            .map(|hosts| {
                hosts
                    .iter()
                    .map(|(host, address)| {
                        let text = template
                            .replace("<host>", host)
                            .replace("<address>", address);
                        crate::html::console_message(
                            "Log.entryAdded",
                            &serde_json::json!({"entry":{"level":"warning","text":text}}),
                        )
                        .unwrap_or(serde_json::Value::Null)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

fn local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let n = u32::from(ip);
            [
                (0x0000_0000, 8),
                (0x0a00_0000, 8),
                (0x6440_0000, 10),
                (0x7f00_0000, 8),
                (0xa9fe_0000, 16),
                (0xac10_0000, 12),
                (0xc0a8_0000, 16),
                (0xc612_0000, 15),
                (0xe000_0000, 3),
            ]
            .iter()
            .any(|(base, prefix)| n >> (32 - prefix) == base >> (32 - prefix))
        }
        IpAddr::V6(ip) => {
            let n = u128::from(ip);
            if [
                (0, 96),
                (0x0064_ff9b_0001u128 << 80, 48),
                (0x2001u128 << 112, 32),
                (0xfcu128 << 120, 7),
                (0xfe80u128 << 112, 10),
                (0xffu128 << 120, 8),
            ]
            .iter()
            .any(|(base, prefix)| n >> (128 - prefix) == base >> (128 - prefix))
            {
                return true;
            }
            if let Some(v4) = ip.to_ipv4_mapped() {
                return local(v4.into());
            }
            if n >> 32
                == u128::from(
                    "64:ff9b::"
                        .parse::<Ipv6Addr>()
                        .unwrap_or(Ipv6Addr::UNSPECIFIED),
                ) >> 32
            {
                return local(Ipv4Addr::from(n as u32).into());
            }
            if n >> 112 == 0x2002 {
                return local(Ipv4Addr::from((n >> 80) as u32).into());
            }
            false
        }
    }
}

async fn connect(
    mut client: TcpStream,
    notes: Arc<Mutex<Vec<(String, String)>>>,
) -> Result<(), Error> {
    let version = client.read_u8().await.map_err(super::err)?;
    let methods = client.read_u8().await.map_err(super::err)?;
    let mut offered = vec![0; usize::from(methods)];
    client.read_exact(&mut offered).await.map_err(super::err)?;
    if version != 5 || !offered.contains(&0) {
        client.write_all(&[5, 255]).await.map_err(super::err)?;
        return Ok(());
    }
    client.write_all(&[5, 0]).await.map_err(super::err)?;
    let mut header = [0; 4];
    client.read_exact(&mut header).await.map_err(super::err)?;
    let [version, command, reserved, kind] = header;
    if version != 5 || command != 1 || reserved != 0 {
        return refuse(&mut client, 7).await;
    }
    let host = match kind {
        1 => {
            let mut bytes = [0; 4];
            client.read_exact(&mut bytes).await.map_err(super::err)?;
            Ipv4Addr::from(bytes).to_string()
        }
        4 => {
            let mut bytes = [0; 16];
            client.read_exact(&mut bytes).await.map_err(super::err)?;
            Ipv6Addr::from(bytes).to_string()
        }
        3 => {
            let count = client.read_u8().await.map_err(super::err)?;
            let mut bytes = vec![0; usize::from(count)];
            client.read_exact(&mut bytes).await.map_err(super::err)?;
            String::from_utf8(bytes).map_err(super::err)?
        }
        _ => return refuse(&mut client, 7).await,
    };
    let port = client.read_u16().await.map_err(super::err)?;
    if port == 0 {
        return refuse(&mut client, 7).await;
    }
    let addresses: Vec<_> = match tokio::net::lookup_host((host.as_str(), port)).await {
        Ok(addresses) => addresses.take(64).collect(),
        Err(_) => return refuse(&mut client, 4).await,
    };
    if host.parse::<IpAddr>().is_err()
        && !addresses.is_empty()
        && addresses
            .iter()
            .all(|a| matches!(a.ip(),IpAddr::V4(ip) if u32::from(ip)>>17==0xc6120000>>17))
        && let Ok(mut notes) = notes.lock()
        && notes.len() < 3
        && !notes.iter().any(|n| n.0 == host)
        && let Some(address) = addresses.first()
    {
        notes.push((host.clone(), address.ip().to_string()));
    }
    let own = tokio::task::spawn_blocking(|| {
        nix::ifaddrs::getifaddrs()
            .map(|list| {
                list.filter_map(|entry| {
                    let address = entry.address?;
                    address
                        .as_sockaddr_in()
                        .map(|v| IpAddr::V4(v.ip()))
                        .or_else(|| address.as_sockaddr_in6().map(|v| IpAddr::V6(v.ip())))
                })
                .collect::<Vec<_>>()
            })
            .map_err(super::err)
    })
    .await
    .map_err(super::err)??;
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| local(address.ip()) || own.contains(&address.ip()))
    {
        return refuse(&mut client, 2).await;
    }
    for address in addresses {
        if let Ok(mut upstream) = TcpStream::connect(address).await {
            client
                .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
                .await
                .map_err(super::err)?;
            let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
            return Ok(());
        }
    }
    refuse(&mut client, 4).await
}
async fn refuse(client: &mut TcpStream, code: u8) -> Result<(), Error> {
    client
        .write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(super::err)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn socks_refuses_loopback_resources() {
        let proxy = Proxy::start().await.unwrap();
        let mut socket = TcpStream::connect((Ipv4Addr::LOCALHOST, proxy.port))
            .await
            .unwrap();
        socket.write_all(&[5, 1, 0]).await.unwrap();
        let mut greeting = [0; 2];
        socket.read_exact(&mut greeting).await.unwrap();
        assert_eq!(greeting, [5, 0]);
        socket
            .write_all(&[5, 1, 0, 1, 127, 0, 0, 1, 0, 80])
            .await
            .unwrap();
        let mut reply = [0; 10];
        socket.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply, [5, 2, 0, 1, 0, 0, 0, 0, 0, 0]);
    }
    #[test]
    fn blocks_t3_private_ranges_and_translated_private_addresses() {
        for ip in [
            "0.1.2.3",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.168.1.1",
            "198.18.0.1",
            "224.0.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "64:ff9b::a00:1",
            "2002:a00:1::",
            "fc00::1",
            "fe80::1",
        ] {
            assert!(local(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "8.8.8.8",
            "1.1.1.1",
            "2001:4860:4860::8888",
            "64:ff9b::808:808",
            "2002:808:808::",
        ] {
            assert!(!local(ip.parse().unwrap()), "{ip}");
        }
    }
}
