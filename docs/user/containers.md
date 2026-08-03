# Run T3 Code with Docker Compose

The Compose setup runs the T3 Code server and its provider CLIs inside one
Linux container. It includes Codex, Claude Code, Cursor Agent, Grok, OpenCode,
Git, and the GitHub CLI.

The container has two Docker-managed volumes:

- a `t3-workspace` volume mounted at `/workspace`
- a named `t3-home` volume mounted at `/home/t3` for T3 Code state, provider
  configuration, sessions, and credentials

It does not mount any host directory, including the host workspace, home,
provider configuration, credentials, SSH agent, Docker socket, or Git
configuration. Code enters through an explicit clone or import and leaves
through an explicit export.

The service runs as a non-root user with all Linux capabilities dropped and
privilege escalation disabled. Its image filesystem is read-only. Only the
two isolated volumes and temporary in-memory filesystems are writable.

## Build and start

```bash
docker compose build
docker compose up -d
docker compose logs -f t3code
```

The log prints the one-time owner pairing URL. By default, Compose publishes
T3 Code only on `127.0.0.1:3773`. Set `T3CODE_BIND_ADDRESS=0.0.0.0` only when
the host firewall or a trusted private network protects the port.

## Put code in the workspace

The normal path is to authenticate source control inside the container and
clone directly into its workspace:

```bash
docker compose exec t3code bash
gh auth login
cd /workspace
git clone https://github.com/owner/project.git
```

To import an existing host directory without creating a persistent mount,
stream a snapshot into a new container-owned directory:

```bash
tar -C /path/to/project -cf - . \
  | docker compose exec -T t3code sh -c \
    'mkdir -p /workspace/project && tar -C /workspace/project -xf -'
```

Export completed work explicitly:

```bash
mkdir -p ./exported-project
docker compose exec -T t3code tar -C /workspace/project -cf - . \
  | tar -C ./exported-project -xf -
```

These are point-in-time transfers. Later host changes are not visible inside
the container, and container changes are not visible on the host until the
next export.

## Authenticate providers

Open the pairing URL, then use the first-run provider setup or open
**Settings** → **Providers**. Choose **Sign in** for a provider and follow the
provider CLI's instructions. The dialog starts in a selectable transcript view
so you can copy links and codes normally. Choose **Interactive terminal** when
the provider asks for keyboard input, then return to **View transcript** when
you want to select or copy output. Switching views does not interrupt the login
command.

The command runs inside the container, so credentials are written directly to
the isolated `t3-home` volume.

If the browser disconnects or the app closes, the login keeps running for up
to 30 minutes. Reopen the provider row and choose **Continue** to reconnect to
the same session. T3 Code does not persist the terminal transcript after the
server restarts.

Manual CLI authentication remains available as a fallback:

```bash
docker compose run --rm t3code codex login --device-auth
docker compose run --rm t3code claude
docker compose run --rm t3code cursor-agent agent login
docker compose run --rm t3code grok login --device-auth
docker compose run --rm t3code opencode auth login
```

Both in-app and manual commands write credentials into the persistent `t3-home` volume. Normal
token refreshes also write there, so rebuilding or replacing the container
does not require another login.

Codex and Grok have device-code flows suited to a headless container. Claude
Code prints a browser URL and can accept the returned code in the terminal.
Cursor Agent also starts a browser login. OpenCode prompts for the provider and
credential to store.

Do not bake credentials into the image or commit them in `.env`. For
unattended installations, pass the provider's supported API-key or token
environment variable at runtime through a private Compose override or a
secrets manager. Remember that an environment variable inherited by an agent
may also be visible to commands run from the mounted repository.

## Git and private repositories

The image includes Git, OpenSSH, and `gh`, but it does not mount host Git or SSH
credentials by default.

- For GitHub HTTPS access, run `docker compose run --rm t3code gh auth login`.
  The login persists in `t3-home`.
- For SSH, generate a dedicated key inside the container home and register its
  public key with the source-control provider. Do not copy or mount a host
  private key.
- Set Git author details inside the persistent container home with
  `git config --global user.name` and `git config --global user.email`.

The Docker socket is intentionally unsupported in this Compose definition. It
would give the supposedly isolated environment root-equivalent control over
the host.

## Update

Rebuild the image to update T3 Code or the preinstalled provider CLIs:

```bash
docker compose build --pull --no-cache
docker compose up -d
```

The `t3-home` and `t3-workspace` volumes are not removed. To pin provider
versions, set `CODEX_VERSION`, `CLAUDE_CODE_VERSION`, `OPENCODE_VERSION`, or
`GROK_VERSION` in `.env` before building.

`docker compose down --volumes` permanently deletes both the isolated
workspace and authentication/state volume. Export or back them up first.
