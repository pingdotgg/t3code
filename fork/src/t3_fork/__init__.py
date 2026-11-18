"""Keep this T3 Code fork on the upstream redesign and install it as its own pacman package."""

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

NAME = "t3-fork"
TOOL = Path(__file__).resolve().parents[2]
REPO = TOOL.parent
CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / NAME
BRANCH = "main"
# Maria's redesign stack (PRs #28839 to #28845); its top branch carries all six parts and is
# rebased onto upstream main as it moves. Point this at "main" once the stack has landed.
UPSTREAM_BRANCH = "maria/redesign/6-workspace-panes"
UPSTREAM = f"upstream/{UPSTREAM_BRANCH}"
# Marks the upstream commit `main` sits on, since the redesign branch is force-pushed.
BASE = "fork-base"
THEMES = REPO / "themes"
USER_THEMES = Path.home() / ".t3" / "userdata" / "themes"

PACKAGE = "t3code-fork"
STOCK_PACKAGE = "t3code-nightly-bin"
PKGBUILD_DIR = TOOL / "pkg"
LEGACY_HOOK = Path(f"/etc/pacman.d/hooks/{NAME}.hook")


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


def installed(package: str) -> str | None:
    result = subprocess.run(["pacman", "-Q", package], text=True, capture_output=True, check=False)
    return result.stdout.split()[1] if result.returncode == 0 else None


def fetch_upstream() -> None:
    run("git", "fetch", "upstream", UPSTREAM_BRANCH, "--quiet")


def base_commit() -> str:
    result = subprocess.run(
        ["git", "-C", str(REPO), "rev-parse", "--verify", "--quiet", BASE],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(
            f"{NAME}: no `{BASE}` branch marking where {BRANCH} sits on {UPSTREAM}.\n"
            f"  Fetch it with `git fetch origin {BASE}:{BASE}`, or create it at that upstream commit."
        )
    return result.stdout.strip()


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


def catch_up_with_origin() -> None:
    """Take PRs merged on GitHub into the local branch, so the force push below cannot drop them."""
    run("git", "fetch", "origin", BRANCH, "--quiet")
    remote = f"origin/{BRANCH}"
    if git("merge-base", BRANCH, remote) == git("rev-parse", remote):
        return
    if subprocess.run(["git", "-C", str(REPO), "merge-base", "--is-ancestor", BRANCH, remote]).returncode == 0:
        run("git", "merge", "--ff-only", "--quiet", remote)
        return
    raise SystemExit(
        f"{NAME}: {BRANCH} and {remote} have diverged; nothing changed.\n"
        f"  Merge {remote} into {BRANCH} by hand, then `{NAME} apply`."
    )


def sync() -> None:
    """Pull in the latest themes, rebase the fork's commits onto the redesign's head, and push."""
    if Path(git("rev-parse", "--git-path", "rebase-merge")).exists() or Path(
        git("rev-parse", "--git-path", "rebase-apply")
    ).exists():
        raise SystemExit(f"{NAME}: {REPO} is mid-rebase; finish or abort it first")
    if git("branch", "--show-current") != BRANCH:
        raise SystemExit(f"{NAME}: {REPO} is not on {BRANCH}; switch back to sync")
    if git("status", "--porcelain", "--untracked-files=no"):
        raise SystemExit(f"{NAME}: {REPO} has uncommitted changes; commit them first")
    fetch_upstream()
    catch_up_with_origin()
    update_themes()
    base = base_commit()
    target = git("rev-parse", UPSTREAM)
    if base != target:
        count = len(git("rev-list", f"{base}..{BRANCH}").splitlines())
        print(f"rebasing {count} fork commit(s) from {base[:10]} onto {UPSTREAM} {target[:10]}")
        result = subprocess.run(["git", "-C", str(REPO), "rebase", "--onto", target, base], check=False)
        if result.returncode != 0:
            subprocess.run(["git", "-C", str(REPO), "rebase", "--abort"], check=False)
            raise SystemExit(
                f"{NAME}: the fork's commits conflict with {UPSTREAM}; nothing changed.\n"
                f"  Resolve by hand: cd {REPO} && git rebase --onto {target} {base}\n"
                f"  then `git branch -f {BASE} {target}` and `{NAME} apply`."
            )
        run("git", "branch", "--force", BASE, target)
    run("git", "push", "--quiet", "--force-with-lease", "origin", BRANCH, BASE)


def fork_version() -> str:
    """A nightly-shaped version, so the build brands and stores its data like the stock nightly."""
    desktop = json.loads((REPO / "apps" / "desktop" / "package.json").read_text())["version"]
    count = git("rev-list", "--count", BRANCH)
    return f"{desktop}-nightly.{date.today():%Y%m%d}.{count}"


def run_fork_tests() -> None:
    changed = git("diff", "--name-only", f"{base_commit()}..{BRANCH}").splitlines()
    tests = [p for p in changed if ".test." in p and (REPO / p).exists()]
    if tests:
        run("vp", "test", "run", *tests)


def build() -> Path:
    """Sync, test the fork's own changes, build the AppImage, and wrap it in a pacman package."""
    sync()
    run("vp", "i")
    run_fork_tests()
    version = fork_version()
    release = CACHE / "release"
    shutil.rmtree(release, ignore_errors=True)
    run(
        "node", "scripts/build-desktop-artifact.ts",
        "--platform", "linux", "--target", "AppImage", "--arch", "x64",
        "--build-version", version, "--output-dir", release,
        # The package only runs here, so this machine's glibc is the ceiling, not upstream's.
        env={"T3CODE_GLIBC_BUILD_CEILING": os.confstr("CS_GNU_LIBC_VERSION").split()[1]},
    )
    appimage = next(release.glob("*.AppImage"), None)
    if appimage is None:
        raise SystemExit(f"{NAME}: the desktop build left no AppImage in {release}")

    pkg = CACHE / "pkg"
    shutil.rmtree(pkg, ignore_errors=True)
    pkg.mkdir(parents=True)
    shutil.copy(PKGBUILD_DIR / "PKGBUILD", pkg / "PKGBUILD")
    shutil.copy(REPO / "LICENSE", pkg / "LICENSE")
    shutil.move(appimage, pkg / "t3code.AppImage")
    env = {"T3_FORK_PKGVER": version.replace("-", "_"), "PKGDEST": str(pkg)}
    run("makepkg", "--force", "--cleanbuild", cwd=pkg, env=env)
    package = Path(run("makepkg", "--packagelist", cwd=pkg, capture=True, env=env).splitlines()[0])
    print(f"built {package} (fork {git('rev-parse', '--short', BRANCH)})")
    install_themes()
    return package


def install(package: Path) -> None:
    """Swap the stock nightly (and the old web-swap hook) for the fork's package."""
    if LEGACY_HOOK.exists():
        run("sudo", "rm", LEGACY_HOOK)
    if installed(STOCK_PACKAGE):
        run("sudo", "pacman", "-R", "--noconfirm", STOCK_PACKAGE)
    run("sudo", "pacman", "-U", "--noconfirm", package)
    print("fork installed. Restart T3 Code to load it.")


def status() -> None:
    fetch_upstream()
    base = base_commit()
    target = git("rev-parse", UPSTREAM)
    commits = len(git("rev-list", f"{base}..{BRANCH}").splitlines())
    state = "up to date" if base == target else "upstream moved, run sync"
    print(f"upstream       : {UPSTREAM} at {target[:10]}")
    print(f"fork {BRANCH:<10}: {commits} commit(s) on {base[:10]} ({state})")
    print(f"installed      : {installed(PACKAGE) or 'no'}")
    if stock := installed(STOCK_PACKAGE):
        print(f"stock nightly  : {stock} (replaced by `{NAME} apply`)")
    for line in git("submodule", "status", "themes").splitlines() if (REPO / ".gitmodules").exists() else []:
        sha, path = line.split()[:2]
        print(f"theme          : {path.removeprefix('themes/')} at {sha.lstrip('+-')[:7]}")


def main() -> None:
    parser = argparse.ArgumentParser(prog=NAME, description=__doc__)
    commands = parser.add_subparsers(dest="command")
    commands.add_parser("status", help="show the upstream redesign, the fork, and what is installed")
    commands.add_parser("sync", help="rebase the fork onto the redesign's latest head and push")
    commands.add_parser("build", help="sync, then build the fork's pacman package")
    commands.add_parser("apply", help="build and install the fork's package (asks for sudo)")
    args = parser.parse_args()
    match args.command:
        case "sync":
            sync()
        case "build":
            build()
        case "apply":
            install(build())
        case _:
            status()
