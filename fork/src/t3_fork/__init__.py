"""Keep this T3 Code fork on the installed nightly and swap its web UI into the stock AUR app."""

import argparse
import getpass
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

NAME = "t3-fork"
TOOL = Path(__file__).resolve().parents[2]
REPO = TOOL.parent
CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / NAME
PATCHED_ASAR = CACHE / "app.asar"
BRANCH = "main"
TAG_GLOB = "v*-nightly.*"
WEB_ONLY = ("apps/web/", "fork/", "themes/", ".gitmodules")
THEMES = REPO / "themes"
USER_THEMES = Path.home() / ".t3" / "userdata" / "themes"

PACKAGE = "t3code-nightly-bin"
APP_ASAR = Path("/opt") / PACKAGE / "resources" / "app.asar"
CLIENT_PATH = ("apps", "server", "dist", "client")
MARKER = f".{NAME}.json"
HOOK_PATH = Path(f"/etc/pacman.d/hooks/{NAME}.hook")
INTEGRITY_BLOCK = 4 * 1024 * 1024


def run(*args: str | Path, cwd: Path = REPO, capture: bool = False, env=None) -> str:
    printable = " ".join(str(arg) for arg in args)
    if not capture:
        print(f"\033[2m$ {printable}\033[0m", flush=True)
    result = subprocess.run(
        [str(arg) for arg in args],
        cwd=cwd,
        text=True,
        capture_output=capture,
        check=False,
        env=None if env is None else {**os.environ, **env},
    )
    if result.returncode != 0:
        if capture:
            sys.stderr.write(result.stderr)
        raise SystemExit(f"{NAME}: command failed ({result.returncode}): {printable}")
    return result.stdout.strip() if capture else ""


def git(*args: str | Path) -> str:
    return run("git", *args, capture=True)


def installed_version() -> str | None:
    """The stock nightly's version as upstream spells it, e.g. 0.1.11-nightly.20261117.4838."""
    result = subprocess.run(["yay", "-Q", PACKAGE], text=True, capture_output=True, check=False)
    if result.returncode != 0:
        return None
    return result.stdout.split()[1].rsplit("-", 1)[0].replace("_nightly.", "-nightly.")


def fetch_upstream() -> None:
    run("git", "fetch", "upstream", "--tags", "--quiet")


def latest_tag() -> str:
    return git("tag", "--list", TAG_GLOB, "--sort=-creatordate").splitlines()[0]


def installed_tag() -> str:
    version = installed_version()
    if version is None:
        raise SystemExit(f"{NAME}: {PACKAGE} is not installed")
    tag = f"v{version}"
    if not git("tag", "--list", tag):
        fetch_upstream()
    if not git("tag", "--list", tag):
        raise SystemExit(f"{NAME}: upstream has no tag {tag} yet")
    return tag


def base_tag() -> str:
    return git("describe", "--tags", "--abbrev=0", "--match", TAG_GLOB, BRANCH)


def update_themes() -> None:
    """Move each theme submodule to its repo's latest main and commit the bump."""
    if not (REPO / ".gitmodules").exists():
        return
    run("git", "submodule", "update", "--init", "--remote", "--quiet", "themes")
    if git("status", "--porcelain", "themes"):
        run("git", "add", "themes")
        heads = git("submodule", "status", "themes").replace("+", "").split("\n")
        names = ", ".join(f"{line.split()[1].removeprefix('themes/')} {line.split()[0][:7]}" for line in heads)
        run("git", "commit", "--quiet", "-m", f"chore(fork): themes at latest ({names})")


def install_themes() -> None:
    """Copy every theme's built dist/ into T3 Code's themes folder."""
    built = sorted(p for p in THEMES.glob("*/dist/*") if p.suffix in (".json", ".webp"))
    USER_THEMES.mkdir(parents=True, exist_ok=True)
    for path in built:
        shutil.copy(path, USER_THEMES / path.name)
    if built:
        print(f"installed {', '.join(p.stem for p in built if p.suffix == '.json')} to {USER_THEMES}")


def sync(tag: str) -> None:
    """Pull in the latest themes, rebase the fork's commits onto `tag`, and push."""
    if Path(git("rev-parse", "--git-path", "rebase-merge")).exists() or Path(
        git("rev-parse", "--git-path", "rebase-apply")
    ).exists():
        raise SystemExit(f"{NAME}: {REPO} is mid-rebase; finish or abort it first")
    if git("branch", "--show-current") != BRANCH:
        raise SystemExit(f"{NAME}: {REPO} is not on {BRANCH}; switch back to sync")
    if git("status", "--porcelain", "--untracked-files=no"):
        raise SystemExit(f"{NAME}: {REPO} has uncommitted changes; commit or stash them first")
    update_themes()
    base = base_tag()
    if base != tag:
        count = len(git("rev-list", f"{base}..{BRANCH}").splitlines())
        print(f"rebasing {count} fork commit(s) from {base} onto {tag}")
        result = subprocess.run(["git", "-C", str(REPO), "rebase", "--onto", tag, base], check=False)
        if result.returncode != 0:
            subprocess.run(["git", "-C", str(REPO), "rebase", "--abort"], check=False)
            raise SystemExit(
                f"{NAME}: the fork's commits conflict with {tag}; nothing changed, stock UI kept.\n"
                f"  Resolve by hand: cd {REPO} && git rebase --onto {tag} {base}\n"
                f"  then `{NAME} apply`."
            )
    run("git", "push", "--quiet", "--force-with-lease", "origin", BRANCH)


def check_web_only(tag: str) -> list[str]:
    changed = git("diff", "--name-only", f"{tag}..{BRANCH}").splitlines()
    outside = [path for path in changed if not path.startswith(WEB_ONLY)]
    if outside:
        raise SystemExit(
            f"{NAME}: the fork changes files outside apps/web, which the web-only swap can't ship:\n  "
            + "\n  ".join(outside)
        )
    return changed


def build_web(version: str, changed: list[str]) -> Path:
    """Build only the web client, the way the desktop release build does."""
    web = REPO / "apps" / "web"
    run("pnpm", "install", "--frozen-lockfile")
    tests = [p.removeprefix("apps/web/") for p in changed if p.startswith("apps/web/") and ".test." in p]
    if tests:
        run("pnpm", "exec", "vp", "test", "run", "--project", "unit", *tests, cwd=web)
    shutil.rmtree(web / "dist", ignore_errors=True)
    run(
        "pnpm", "--filter", "@t3tools/web", "build",
        env={"APP_VERSION": version, "T3CODE_WEB_SOURCEMAP": "false"},
    )
    run("node", "scripts/apply-web-brand-assets.ts", "nightly", "apps/web/dist")
    return web / "dist"


def read_asar(path: Path) -> tuple[dict, int]:
    """Return the asar header and the byte offset where file data starts."""
    with path.open("rb") as file:
        _, header_size, _, json_size = struct.unpack("<4I", file.read(16))
        return json.loads(file.read(json_size)), 8 + header_size


def integrity(data: bytes) -> dict:
    blocks = [
        hashlib.sha256(data[i : i + INTEGRITY_BLOCK]).hexdigest()
        for i in range(0, max(len(data), 1), INTEGRITY_BLOCK)
    ]
    return {
        "algorithm": "SHA256",
        "hash": hashlib.sha256(data).hexdigest(),
        "blockSize": INTEGRITY_BLOCK,
        "blocks": blocks,
    }


def write_asar(source: Path, client_dir: Path, marker: dict, out: Path) -> None:
    """Copy the asar with its bundled web client replaced by client_dir (source maps left out)."""
    header, data_start = read_asar(source)
    chunks: list[tuple[int, int] | bytes] = []
    size = 0

    def add(entry: dict, chunk: tuple[int, int] | bytes, length: int) -> None:
        nonlocal size
        entry["offset"] = str(size)
        chunks.append(chunk)
        size += length

    def relocate(node: dict) -> None:
        for entry in node["files"].values():
            if "files" in entry:
                relocate(entry)
            elif "offset" in entry:
                add(entry, (data_start + int(entry["offset"]), entry["size"]), entry["size"])

    parent = header
    for part in CLIENT_PATH[:-1]:
        parent = parent["files"][part]
    parent["files"][CLIENT_PATH[-1]] = {"files": {}}
    relocate(header)

    client = parent["files"][CLIENT_PATH[-1]]
    files = sorted(p for p in client_dir.rglob("*") if p.is_file() and p.suffix != ".map")
    new_files = [(p.relative_to(client_dir).parts, p.read_bytes()) for p in files]
    new_files.append(((MARKER,), json.dumps(marker).encode()))
    for parts, data in new_files:
        node = client
        for part in parts[:-1]:
            node = node["files"].setdefault(part, {"files": {}})
        entry = {"size": len(data), "integrity": integrity(data)}
        node["files"][parts[-1]] = entry
        add(entry, data, len(data))

    encoded = json.dumps(header, separators=(",", ":")).encode()
    padded = encoded + b"\0" * (-len(encoded) % 4)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    with source.open("rb") as src, tmp.open("wb") as dst:
        dst.write(struct.pack("<4I", 4, len(padded) + 8, len(padded) + 4, len(encoded)))
        dst.write(padded)
        for chunk in chunks:
            if isinstance(chunk, bytes):
                dst.write(chunk)
            else:
                src.seek(chunk[0])
                dst.write(src.read(chunk[1]))
    tmp.replace(out)


def read_marker(path: Path) -> dict | None:
    try:
        header, data_start = read_asar(path)
        node = header
        for part in (*CLIENT_PATH, MARKER):
            node = node["files"][part]
        with path.open("rb") as file:
            file.seek(data_start + int(node["offset"]))
            return json.loads(file.read(node["size"]))
    except (OSError, KeyError, ValueError):
        return None


def build() -> None:
    """Sync the fork onto the installed nightly, build its web client, write the patched asar."""
    tag = installed_tag()
    version = tag.removeprefix("v")
    sync(tag)
    changed = check_web_only(tag)
    client = build_web(version, changed)
    commit = git("rev-parse", "--short", BRANCH)
    write_asar(APP_ASAR, client, {"version": version, "commit": commit}, PATCHED_ASAR)
    print(f"wrote {PATCHED_ASAR} ({version}, fork {commit})")
    install_themes()


def install_patched() -> None:
    run("sudo", "install", "-m644", PATCHED_ASAR, APP_ASAR)
    print("fork UI applied. Restart T3 Code to load it.")


def hook_text() -> str:
    user = getpass.getuser()
    home = Path.home()
    uv = shutil.which("uv") or "/usr/bin/uv"
    path = f"{home}/.local/share/mise/shims:{home}/.local/bin:/usr/local/bin:/usr/bin:/bin"
    build_cmd = (
        f"/usr/bin/runuser -u {user} -- /usr/bin/env HOME={home} PATH={path} "
        f"{uv} run --project {TOOL} {NAME} build"
    )
    script = (
        f"{build_cmd} && /usr/bin/install -m644 {PATCHED_ASAR} {APP_ASAR} "
        f"&& echo '{NAME}: applied; restart T3 Code' "
        f"|| echo '{NAME}: not applied, stock UI kept; see above, then run {NAME} apply'"
    )
    return (
        f"# Written by `{NAME} setup`. Re-applies the fork in {REPO} after each T3 Code nightly upgrade.\n"
        "[Trigger]\n"
        "Operation = Install\n"
        "Operation = Upgrade\n"
        "Type = Package\n"
        f"Target = {PACKAGE}\n\n"
        "[Action]\n"
        f"Description = Applying {NAME} to T3 Code...\n"
        "When = PostTransaction\n"
        f'Exec = /bin/sh -c "{script}"\n'
    )


def setup() -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".hook", delete=False) as file:
        file.write(hook_text())
    run("sudo", "install", "-Dm644", file.name, HOOK_PATH)
    os.unlink(file.name)
    print(f"installed {HOOK_PATH}")
    if installed_version() is None:
        run("yay", "-S", PACKAGE)
    else:
        build()
        install_patched()


def status() -> None:
    fetch_upstream()
    marker = read_marker(APP_ASAR)
    base = base_tag()
    print(f"latest nightly : {latest_tag().removeprefix('v')}")
    print(f"installed      : {installed_version() or f'{PACKAGE} not installed'}")
    print(f"fork {BRANCH:<10}: {len(git('rev-list', f'{base}..{BRANCH}').splitlines())} commit(s) on {base}")
    print(f"applied        : {f'fork {marker['commit']} on {marker['version']}' if marker else 'no'}")
    print(f"pacman hook    : {'installed' if HOOK_PATH.exists() else f'missing, run {NAME} setup'}")
    for line in git("submodule", "status", "themes").splitlines() if (REPO / ".gitmodules").exists() else []:
        sha, path = line.split()[:2]
        print(f"theme          : {path.removeprefix('themes/')} at {sha.lstrip('+-')[:7]}")


def main() -> None:
    parser = argparse.ArgumentParser(prog=NAME, description=__doc__)
    commands = parser.add_subparsers(dest="command")
    commands.add_parser("status", help="show the installed nightly, the fork, and what is applied")
    sync_parser = commands.add_parser("sync", help="rebase the fork onto the installed nightly and push")
    sync_parser.add_argument("--latest", action="store_true", help="use the newest nightly tag instead")
    commands.add_parser("build", help="sync, then build the patched app.asar for the installed nightly")
    commands.add_parser("apply", help="build and install the patched app.asar (asks for sudo)")
    commands.add_parser("setup", help="install the pacman hook and apply the fork")
    args = parser.parse_args()
    match args.command:
        case "sync":
            fetch_upstream()
            sync(latest_tag() if args.latest else installed_tag())
        case "build":
            build()
        case "apply":
            build()
            install_patched()
        case "setup":
            setup()
        case _:
            status()
