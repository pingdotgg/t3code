#!/usr/bin/env python3
"""Build the APK's offline ARM64 runtime from checksum-pinned upstream inputs."""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "scripts/android-runtime.lock.json"
MODULE = ROOT / "apps/mobile/modules/t3-runtime/android/src/main"
APT = "https://packages.termux.dev/apt/termux-main/"
PREFIX = "data/data/com.termux/files/usr/"
CACHE = Path(os.environ.get("T3MOBILE_BUILD_CACHE", ROOT / ".runtime-cache"))


def fetch(url):
    try:
        with urllib.request.urlopen(url, timeout=120) as response:
            return response.read()
    except Exception as error:
        raise RuntimeError(f"Cannot download {url}: {error}") from error


def update_lock():
    paragraphs = fetch(APT + "dists/stable/main/binary-aarch64/Packages").decode().split("\n\n")
    packages = {}
    for paragraph in paragraphs:
        fields = dict(line.split(": ", 1) for line in paragraph.splitlines() if ": " in line and not line.startswith(" "))
        if "Package" in fields:
            packages[fields["Package"]] = fields
    selected = {}

    def add(name):
        if name in selected:
            return
        fields = packages[name]
        selected[name] = {"name": name, "version": fields["Version"], "url": APT + fields["Filename"], "sha256": fields["SHA256"], "homepage": fields.get("Homepage", "")}
        for dependency in fields.get("Depends", "").split(","):
            if not dependency.strip():
                continue
            alternatives = [re.split(r"[\s(]", part.strip())[0] for part in dependency.split("|")]
            match = next((part for part in alternatives if part in selected), None)
            if match is None:
                match = next((part for part in alternatives if part in packages), None)
            if not match:
                raise RuntimeError(f"Unresolved dependency {dependency} of {name}")
            add(match)

    for name in ("nodejs-lts", "npm", "bash", "coreutils", "git", "curl", "findutils", "grep", "sed", "tar", "gzip", "ca-certificates", "termux-exec"):
        add(name)
    codex = json.loads(fetch("https://registry.npmjs.org/@mmmbuto/codex-cli-termux/0.155.0"))
    revision = json.loads(fetch("https://api.github.com/repos/termux/termux-packages/commits/master"))["sha"]
    license_urls = {
        "Node-LICENSE": "https://raw.githubusercontent.com/nodejs/node/v24.18.0/LICENSE",
        "GPL-2.0": "https://raw.githubusercontent.com/spdx/license-list-data/main/text/GPL-2.0-only.txt",
        "GPL-3.0": "https://raw.githubusercontent.com/spdx/license-list-data/main/text/GPL-3.0-only.txt",
        "LGPL-2.0": "https://raw.githubusercontent.com/spdx/license-list-data/main/text/LGPL-2.0-only.txt",
        "Termux-exec-MIT": "https://raw.githubusercontent.com/termux/termux-exec-package/v2.5.0/licenses/termux__termux-exec-package__MIT.md",
        "LGPL-2.1": "https://raw.githubusercontent.com/spdx/license-list-data/main/text/LGPL-2.1-only.txt",
        "LGPL-3.0": "https://raw.githubusercontent.com/spdx/license-list-data/main/text/LGPL-3.0-only.txt",
        "Termux-exec-Apache-2.0": "https://raw.githubusercontent.com/termux/termux-exec-package/v2.5.0/licenses/termux__termux-exec-package__Apache-2.0.md",
        "Termux-core-MIT": "https://raw.githubusercontent.com/termux/termux-core-package/v0.4.0/LICENSE",
    }
    licenses = [{"name": name, "url": url, "sha256": hashlib.sha256(fetch(url)).hexdigest()} for name, url in license_urls.items()]
    LOCK.write_text(json.dumps({"architecture": "aarch64", "termuxSourceRevision": revision, "licenses": licenses,
        "packages": sorted(selected.values(), key=lambda p: p["name"]),
        "codex": {"version": codex["version"], "url": codex["dist"]["tarball"], "integrity": codex["dist"]["integrity"], "source": "https://github.com/DioNanos/codex-termux/tree/v0.155.0"}}, indent=2) + "\n")


def pinned_bytes(item):
    CACHE.mkdir(parents=True, exist_ok=True)
    key = item.get("sha256") or hashlib.sha256(item["integrity"].encode()).hexdigest()
    path = CACHE / key
    data = path.read_bytes() if path.exists() else fetch(item["url"])
    if "sha256" in item:
        valid = hashlib.sha256(data).hexdigest() == item["sha256"]
    else:
        valid = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode() == item["integrity"]
    if not valid:
        raise RuntimeError(f"Checksum mismatch for {item['url']}")
    if not path.exists():
        path.write_bytes(data)
    return data


def prepare():
    lock = json.loads(LOCK.read_text())
    files = {}
    links = {}

    def put(name, content, mode=0o644):
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts:
            raise RuntimeError(f"Unsafe archive path {name}")
        files[str(path)] = (content, mode)
        links.pop(str(path), None)

    for package in lock["packages"]:
        data = pinned_bytes(package)
        # dpkg-deb reads the ar/deb container; Python handles tar paths explicitly.
        deb = CACHE / "package.deb"
        deb.write_bytes(data)
        tar = subprocess.check_output(["dpkg-deb", "--fsys-tarfile", str(deb)])
        with tarfile.open(fileobj=io.BytesIO(tar)) as archive:
            for member in archive:
                name = member.name.removeprefix("./")
                if not name.startswith(PREFIX):
                    continue
                relative = "usr/" + name[len(PREFIX):]
                if member.isfile():
                    put(relative, archive.extractfile(member).read(), member.mode)
                elif member.issym():
                    target = member.linkname
                    if target.startswith("/" + PREFIX):
                        target = os.path.relpath("usr/" + target[len(PREFIX) + 1:], os.path.dirname(relative))
                    if target.startswith("/"):
                        raise RuntimeError(f"Unsupported absolute symlink {relative}: {target}")
                    resolved = os.path.normpath(os.path.join(os.path.dirname(relative), target))
                    if resolved.startswith("../"):
                        raise RuntimeError(f"Escaping symlink {relative}")
                    links[relative] = target
                elif member.islnk():
                    target = member.linkname.removeprefix("./")
                    if not target.startswith(PREFIX):
                        raise RuntimeError(f"Unsupported hardlink {relative}")
                    links[relative] = os.path.relpath("usr/" + target[len(PREFIX):], os.path.dirname(relative))
        print(f"Bundled {package['name']} {package['version']}", flush=True)

    codex_files = {}
    with tarfile.open(fileobj=io.BytesIO(pinned_bytes(lock["codex"])), mode="r:gz") as archive:
        for member in archive:
            if member.isfile():
                codex_files[member.name] = archive.extractfile(member).read()
    binaries = [(name, value) for name, value in codex_files.items() if value.startswith(b"\x7fELF") and name.endswith("/codex.bin")]
    if len(binaries) != 1:
        raise RuntimeError(f"Expected one Android Codex binary, found {[name for name, _ in binaries]}")
    for name, value in codex_files.items():
        if name.startswith("package/bin/") and value.startswith(b"\x7fELF"):
            put("usr/libexec/codex/" + name.removeprefix("package/bin/"), value, 0o755)
    put("usr/bin/codex", b'#!/bin/sh\nexport LD_LIBRARY_PATH="$PREFIX/libexec/codex:$PREFIX/lib"\nexport CODEX_SELF_EXE="$PREFIX/libexec/codex/codex.bin"\nexec "$CODEX_SELF_EXE" "$@"\n', 0o755)
    put("usr/libexec/node", files.pop("usr/bin/node")[0], 0o755)
    put("usr/bin/node", b'#!/bin/sh\nexport LD_LIBRARY_PATH="$PREFIX/lib"\nexec "$PREFIX/libexec/node" "$@"\n', 0o755)
    for name, value in codex_files.items():
        if "LICENSE" in name.upper() or "NOTICE" in name.upper():
            put("licenses/codex/" + name.removeprefix("package/"), value)

    # Use the linker intercept variant for scripts and child commands on API 29+.
    candidates = [path for path in files if "termux-exec" in path and "linker" in path and path.endswith(".so")]
    if not candidates:
        raise RuntimeError("The pinned termux-exec package has no linker execution library")
    put("usr/lib/t3mobile-exec-library", candidates[0].encode())
    if "usr/bin/sh" not in files and "usr/bin/sh" not in links:
        links["usr/bin/sh"] = "bash"

    for tree, target in [(ROOT / "apps/runtime/src", "bundle/apps/runtime/src"), (ROOT / "packages/protocol/src", "bundle/packages/protocol/src"), (ROOT / "node_modules/ws", "bundle/node_modules/ws")]:
        if not tree.exists():
            raise RuntimeError(f"Missing {tree}; run npm ci first")
        for path in sorted(tree.rglob("*")):
            if path.is_file():
                put(target + "/" + path.relative_to(tree).as_posix(), path.read_bytes())
    put("bundle/apps/runtime/package.json", (ROOT / "apps/runtime/package.json").read_bytes())
    notices = {"termux": {"source": "https://github.com/termux/termux-packages/tree/" + lock["termuxSourceRevision"], "packages": lock["packages"]}, "codex": lock["codex"]}
    put("licenses/upstream-inputs.json", json.dumps(notices, indent=2).encode())
    for item in lock["licenses"]:
        put("licenses/" + item["name"] + ".txt", pinned_bytes(item))
    def relocatable(data):
        if b"/data/data/com.termux/files/usr" not in data or b"\0" in data:
            return False
        try:
            data.decode("utf8")
            return True
        except UnicodeDecodeError:
            return False

    records = [{"path": name, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "executable": bool(mode & 0o111), "relocate": relocatable(data)} for name, (data, mode) in sorted(files.items())]
    manifest = {"files": records, "links": links, "codexVersion": lock["codex"]["version"]}
    version = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
    manifest["version"] = version
    assets = MODULE / "assets/t3-runtime"
    assets.mkdir(parents=True, exist_ok=True)
    (assets / "manifest.json").write_text(json.dumps(manifest))
    with zipfile.ZipFile(assets / "runtime.zip", "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, (data, _) in sorted(files.items()):
            archive.writestr(name, data)
    print(f"Prepared offline runtime {version[:12]} ({(assets / 'runtime.zip').stat().st_size // 1024 // 1024} MiB)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--update-lock", action="store_true")
    options = parser.parse_args()
    if options.update_lock:
        update_lock()
    prepare()
