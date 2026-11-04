---
title: "Fix T3 Connect problems"
description: "Diagnose T3 Code remote connection failures by checking your device, account, host tunnel, server, clock, and the exact T3 Connect error."
updated: 2026-11-04
sources:
  - label: "T3 Connect troubleshooting"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/t3-connect-troubleshooting.md"
  - label: "Remote routes and account links"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md"
  - label: "Background service troubleshooting"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md"
faq:
  - question: "Why does T3 Code say my remote host is offline?"
    answer: "T3 Code cannot reach a host tunnel when the machine sleeps, loses connectivity, stops its server, or cannot open the tunnel. Check Details in Settings → Environments and run t3 connect status on the host."
  - question: "Which port does T3 Connect need?"
    answer: "The T3 Code host's tunnel needs outbound TCP and UDP port 7844 to Cloudflare. A network can allow ordinary web traffic while blocking that port."
  - question: "Why does T3 Connect fail while Tailscale works?"
    answer: "A Tailscale exit node or VPN on the T3 Code host can block outbound port 7844. A direct Tailscale route can still work without the managed tunnel."
  - question: "Can an incorrect clock break T3 Connect?"
    answer: "T3 Connect uses short-lived signed proofs, so a clock a few minutes wrong can cause rejection. Enable automatic date and time on the T3 Code host and receiving device."
---

T3 Code reports remote connection failures through the environment's `Details` view so you can locate the failing part. Open `Settings → Environments`, select the environment, and choose `Details`. Start with the first failed check, then compare it with `t3 connect status` on the host.

## Find which part of the connection failed

A T3 Connect request crosses four stages: your device's internet connection, T3 Connect's account and link checks, the host's tunnel, and the T3 Code server. Fix the first failing stage before changing later settings.

| First failing part                      | Where to investigate                                 |
| --------------------------------------- | ---------------------------------------------------- |
| This device cannot reach T3 Connect     | The receiving device's network, DNS, VPN, or filters |
| Sign-in or environment link             | Account identity, host linking, and credentials      |
| Host tunnel offline                     | Host availability and outbound tunnel connectivity   |
| Tunnel works but server does not answer | The T3 Code process, its port, and listen address    |

The host's status check tests its own T3 Connect address. It cannot prove that your phone's network reaches that address. For a failure limited to one device, inspect `Details` on that device.

## Restore an offline host tunnel

1. Check that the host is awake and online.
2. Check that T3 Code is running there.
3. Run `t3 connect status` on the host.
4. Follow the reported host-side problem.

On Windows, keep the desktop app open with its local environment enabled, or leave `t3 serve` running. Closing the last desktop window stops its local server. On Linux and macOS, use a [background service](/learn/safety/background-service) when the server must outlive a terminal session.

If a long-offline host needs a newer version, start and [update T3 Code](/learn/start/updating) there. When idle tunnel cleanup is enabled, the tunnel can be removed while the environment remains linked. A supporting host recreates it at the same address when it starts or wakes, without another pairing.

## Check outbound port 7844

The host's tunnel connects out to Cloudflare over TCP and UDP port 7844. Both supported tunnel protocols use that port. Ordinary websites can keep working while the tunnel cannot start.

A Tailscale exit node, work VPN, or firewall on the host's route can block this traffic. Check whether outbound TCP and UDP 7844 are allowed. If an exit node causes the block, turn it off for the host or allow the port on the exit node's network.

When the network cannot permit that port, add a direct Tailscale route if both devices share a tailnet. The [remote access guide](/learn/remote/remote-access) explains multiple routes. That direct path bypasses the managed tunnel for your connection.

## Restart a server the tunnel cannot reach

A working tunnel with no server response points at the host process. T3 Code may have stopped, still be starting, or restarted on a different port. A custom `T3CODE_HOST` can also omit `127.0.0.1`, which the tunnel needs to reach.

Restart the host server, then repeat its status check:

```bash
t3 service restart
t3 connect status
```

These commands apply to the background-service setup. For a foreground server, stop it and run `t3 serve` again. Restarting interrupts running agent turns, terminals, and remote clients, so account for active work before proceeding.

## Diagnose a failure on one phone or computer

Check the receiving device's internet connection. A captive Wi-Fi network can appear connected without letting requests through. Test another network, or temporarily disable a VPN, ad blocker, firewall, or DNS filter to isolate the cause.

On iPhone, test with Connectivity Assist turned off in Wi-Fi settings if it interferes with T3 Connect. Use the [mobile app guide](/learn/remote/mobile-apps) to verify the saved environment and route.

If the host's address fails to resolve or establish TLS, run `t3 connect status` there too. A check that fails only on the host points toward its DNS, VPN, or proxy. Compare both sides before changing the account link.

## Repair account, link, and clock errors

Both host and client must use the same T3 Connect account. If the host belongs to another account, run `t3 connect logout`, then `t3 connect` there. Enabling activity publishing alone does not enable remote T3 Connect access.

After a newly applied link or repaired permanent rejection, restart the host server. If the client sign-in expired or its access was rejected, sign out and sign in again on that client. When the account reaches its tunnel limit, deregister an unused environment or link a qualifying paid T3 Chat account for more capacity.

Enable automatic date and time on the host and client. T3 Connect rejects short-lived proofs when either clock is several minutes wrong.

| Reported error                     | Next action                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| `environment_link_limit_exceeded`  | Free an unused environment slot or link an eligible T3 Chat plan, then restart the host |
| `auth_invalid` or `invalid_bearer` | Run `t3 connect login`; revoked credentials may require logout and `t3 connect` again   |
| Expired or invalid link proof      | Correct the clock, update T3 Code, and restart                                          |
| Unrecognized HTTP 403              | Check access, proxies, and firewall rules; retain a Cloudflare Ray ID if shown          |
| HTTP 408, 429, or 5xx              | Allow a few minutes for automatic retries of temporary failures                         |

## Gather evidence for an unresolved failure

Use `Copy diagnostics` in the environment's `Details`. Include that text, host-side `t3 connect status` output, and any trace ID in a [GitHub issue](https://github.com/pingdotgg/t3code/issues).

For an earlier tunnel drop, include the relevant host tunnel log, `relay-client.ndjson`, from the logs directory. Its default location is `~/.t3/userdata/logs`. The tunnel log removes its tunnel token, but keep pairing URLs and authorization codes out of reports.

## Next steps

- Return to [remote and mobile](/learn/remote) or review your [remote access route](/learn/remote/remote-access).
- If threads work but alerts do not, check [mobile notifications](/learn/remote/mobile-notifications).
- Once the environment connects, use the [device guide](/learn/remote/devices) for simulator or emulator streaming problems.
