# Docker

The Docker image runs T3 Code, its web client, and the Codex, Claude Code, Cursor, and OpenCode
CLIs in one isolated environment. It can only work with directories mounted into the container;
tools and credentials installed on the host are not automatically available inside it.

## Start the container

Set the workspace path to the directory the agents should be able to edit, then start the Compose
service from the T3 Code repository:

```bash
T3_WORKSPACE_PATH=/absolute/path/to/code docker compose up --build
```

In PowerShell:

```powershell
$env:T3_WORKSPACE_PATH = "C:\path\to\code"
docker compose up --build
```

The first build installs T3 Code and the supported provider CLIs. Later starts reuse the `t3-home`
volume, which contains T3 Code data, provider logins, Git configuration, and other files in the
container user's home directory. The container has the stable hostname `t3-code` by default, so
remote clients do not display a generated container ID as the environment name.

## Pair the browser

The startup log prints a one-time pairing URL. Because T3 Code detects the container's internal
address, replace only that URL's origin with `http://localhost:3773` and keep the
`/pair#token=...` portion unchanged.

For example:

```text
Printed: http://172.18.0.2:3773/pair#token=...
Open:    http://localhost:3773/pair#token=...
```

If the link expired or was already used, create another one:

```bash
docker compose exec t3 t3 pair
```

Then add `/workspace` as a project in T3 Code.

## Sign in to a provider

Provider authentication happens inside the container and remains in the `t3-home` volume:

```bash
docker compose exec t3 codex login --device-auth
docker compose exec t3 claude auth login
docker compose exec t3 cursor-agent login
docker compose exec t3 opencode auth login
```

These are subscription login sessions, not API keys baked into the image. Do not copy provider
credential files into the repository, pass them as Docker build arguments, or commit an exported
`t3-home` volume. Build arguments and image layers are not secret storage.

Grok is not installed by the default image. To use it, install its Linux CLI in a derived image and
select that executable in T3 Code's provider settings.

## Configuration

The Compose setup supports these environment variables:

- `T3_WORKSPACE_PATH`: host directory mounted at `/workspace`; defaults to the T3 Code repository.
- `T3_IMAGE`: image name used by Compose; defaults to `t3-code:local`.
- `T3_HOSTNAME`: stable environment name reported by the container; defaults to `t3-code`.
- `T3_PORT`: published host port; defaults to `3773`.
- `T3_BIND_ADDRESS`: host interface used for the published port; defaults to `127.0.0.1`.
- `T3CODE_INSTALL_CURSOR`: set to `0` to omit Cursor Agent; defaults to `1`.
- `T3CODE_INSTALL_PROVIDERS`: set to `0` for a server-only image; defaults to `1`.
- `T3CODE_PROVIDER_PACKAGES`: space-separated npm packages installed in the image. Provide pinned
  versions for reproducible builds.

Runtime-only settings, including the public T3 Connect configuration, can be added to the Compose
service's `environment` section. Keep private values in a local ignored environment file or Docker
secret and pass them only at runtime.

To make the server reachable from another device on a trusted network, set
`T3_BIND_ADDRESS=0.0.0.0` before starting it. Pairing is still required. Prefer an HTTPS endpoint
for access from `https://app.t3.codes`; browsers block connections from that hosted app to a plain
HTTP backend.

The container runs as UID/GID `1000:1000`. On Linux, the mounted workspace must be readable and
writable by that user. The image does not mount the Docker socket; add it only if an agent
explicitly needs Docker access, since doing so grants broad control over the host.

To remove the container while retaining state, run `docker compose down`. Adding `--volumes` also
deletes the persistent T3 and provider state.
