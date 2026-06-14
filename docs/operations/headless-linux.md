# Headless Linux packages

The `morecode-headless` Debian and RPM packages install the more Code server as a systemd service.
They support `x86_64`/`amd64` and `arm64`/`aarch64` Linux hosts. Build each package on a native host
of the target architecture because the server includes native dependencies.

## Install

Install Node.js 22.16 or newer and Git, then install the package for your distribution:

```bash
sudo apt install ./morecode-headless_VERSION_ARCH.deb
```

```bash
sudo dnf install ./morecode-headless-VERSION-RELEASE.ARCH.rpm
```

The package creates a dedicated `morecode` system user and starts `morecode.service`. Its files are:

- configuration: `/etc/morecode/morecode.env` (preserved across package upgrades)
- persistent server state: `/var/lib/morecode/state`
- default coding workspace: `/var/lib/morecode/workspace`
- application runtime: `/opt/morecode`

The package installs the CLI as `morecode`.

The server binds to `127.0.0.1:3773` by default. This works with SSH port forwarding and avoids
accidentally exposing the backend broadly:

```bash
ssh -L 3773:127.0.0.1:3773 user@server
```

To use a trusted LAN or private network, edit `/etc/morecode/morecode.env`, set
`MORECODE_T3CODE_HOST` to the trusted interface address, then restart the service:

```bash
sudo systemctl restart morecode
```

Read the one-time pairing URL and token from the service journal:

```bash
sudo journalctl -u morecode -b
```

## Provider authentication

Provider credentials belong to the `morecode` service account. Run provider login commands as that
account, using its home directory:

```bash
sudo -u morecode -H codex login
sudo -u morecode -H claude auth login
```

Install provider CLIs in a system-wide location included in the service `PATH`, such as
`/usr/local/bin`.

Run installed more Code administration commands as the service account too:

```bash
sudo -u morecode -H morecode auth --help
sudo -u morecode -H morecode project --help
```

## Build packages

Build both formats on a Linux host with `dpkg-deb` and `rpmbuild` installed:

```bash
vp run dist:linux
```

The build produces packages in `./release`. Use `vp run dist:linux:deb` or `vp run dist:linux:rpm`
to build one format.
