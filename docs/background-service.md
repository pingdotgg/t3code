# Background service

`t3 service install` installs the exact packaged CLI that ran the command as a per-user service and starts it immediately. Re-running install repairs the definition and replaces the runtime, so run it again from the newly installed packaged CLI after an upgrade.

```sh
t3 service install --base-dir ~/.t3 --cwd ~/code --host 127.0.0.1 --port 13773
t3 service status
t3 service disable
t3 service enable
t3 service restart
t3 service stop
t3 service start
t3 service uninstall
```

On macOS this creates a per-base-directory LaunchAgent. It starts when that user's GUI session logs in, survives terminal logout, restarts after crashes, and returns after reboot only after the user logs in. macOS may require approval in **System Settings > General > Login Items & Extensions**.

Linux and Windows are currently reported as unsupported and no supervisor state is changed. Linux support is intentionally deferred until systemd user-manager and linger behavior can be production-tested across supported distributions.

The instance-specific definition path and rotating server log are shown by `t3 service status`. The log is the normal bounded `userdata/logs/server.log`; launchd stdout and stderr are discarded instead of appending a second unbounded log. Each service instance writes health discovery state inside its private runtime directory, so a foreground server using the same base directory cannot satisfy or lose the service health record. Status reports launchd loaded state, process state/PID, and HTTP responsiveness rather than treating a definition file as proof of availability. Uninstall stops and disables that base-directory instance and removes only that instance's definition and runtime artifacts.

## T3 Connect and direct Tailscale HTTPS

Connect onboarding offers background installation after linking. A service failure does not undo the successful link. The service itself does not require Clerk or a relay.

For direct Tailnet access, bind T3 to a fixed loopback port, then let `t3 pair` provision and validate the persistent HTTPS mapping:

```sh
t3 service install --host 127.0.0.1 --port 13773
t3 pair --base-dir ~/.t3 --tailscale --label "Mobile device"
tailscale serve status
```

Scan the printed QR code in the RN app or open the same canonical URL in a browser. Tailscale Serve persists independently across T3 restarts. Use the exact per-port removal command printed by `t3 pair`; avoid `tailscale serve reset`, which removes unrelated mappings too.

The service definition contains its startup paths and selected non-secret configuration. Pairing/session credentials still grant workstation access: use Tailnet ACLs, revoke unused T3 sessions, protect the workstation account, and do not expose the port directly to an untrusted network.
