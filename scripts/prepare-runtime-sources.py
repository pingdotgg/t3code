#!/usr/bin/env python3
"""Package copyleft upstream sources and the exact Termux build recipes for APK distribution."""
import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("runtime_assets", ROOT / "scripts/prepare-android-runtime.py")
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


def field(recipe, name):
    match = re.search(r"^" + re.escape(name) + r"=(.+)$", recipe, re.M)
    if not match:
        raise RuntimeError(f"Missing {name} in source recipe")
    return match[1].strip().strip('\"\'')


def source_inputs(lock):
    revision = lock["termuxSourceRevision"]
    url = f"https://codeload.github.com/termux/termux-packages/tar.gz/{revision}"
    data = assets.fetch(url)
    inputs = [{"name": "termux-build-recipes.tar.gz", "url": url, "sha256": hashlib.sha256(data).hexdigest()}]
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        prefix = archive.getmembers()[0].name.split("/")[0]
        handled = set()
        for package in lock["packages"]:
            name = package["name"]
            path = f"{prefix}/packages/{name}/build.sh"
            if path not in archive.getnames():
                parents = [m.name for m in archive if m.name.endswith(f"/{name}.subpackage.sh")]
                if len(parents) != 1:
                    raise RuntimeError(f"No unambiguous parent recipe for {name}")
                path = str(Path(parents[0]).parent / "build.sh")
                name = Path(path).parent.name
            if name in handled:
                continue
            handled.add(name)
            recipe = archive.extractfile(path).read().decode()
            if "GPL" not in field(recipe, "TERMUX_PKG_LICENSE"):
                continue
            version = field(recipe, "TERMUX_PKG_VERSION")
            revision_number = re.search(r"^TERMUX_PKG_REVISION=(.+)$", recipe, re.M)
            packaged_version = version + ("-" + revision_number[1].strip() if revision_number else "")
            if package["version"] not in {packaged_version, packaged_version + "-0"}:
                raise RuntimeError(f"Source/binary version mismatch: {name} {packaged_version} != {package['version']}")
            url = field(recipe, "TERMUX_PKG_SRCURL")
            replacements = {
                "${TERMUX_PKG_VERSION%.*}": version.rsplit(".", 1)[0],
                "${TERMUX_PKG_VERSION:2}": version[2:],
                "${TERMUX_PKG_VERSION:0:4}": version[:4],
                "${TERMUX_PKG_VERSION}": version,
                "$TERMUX_PKG_VERSION": version,
                "${_MAIN_VERSION}": version.split("-p", 1)[0],
            }
            for token, value in replacements.items():
                url = url.replace(token, value)
            url = url.replace("http://", "https://", 1)
            if name == "psmisc":
                url = f"https://downloads.sourceforge.net/project/psmisc/psmisc/psmisc-{version}.tar.xz"
            if "$" in url or not url.startswith("https://"):
                raise RuntimeError(f"Unsupported source URL expression for {name}: {url}")
            inputs.append({"name": name + "-source" + Path(url).suffix, "url": url, "sha256": field(recipe, "TERMUX_PKG_SHA256")})
            if name in ("bash", "readline"):
                main, patch = version.rsplit(".", 1)
                hashes = dict(re.findall(r"PATCH_CHECKSUMS\[(\d+)\]=([a-f0-9]{64})", recipe))
                for number in range(1, int(patch) + 1):
                    index = f"{number:03d}"
                    patch_name = f"{name}{main.replace('.', '')}-{index}"
                    inputs.append({"name": patch_name + ".patch", "url": f"https://mirrors.kernel.org/gnu/{name}/{name}-{main}-patches/{patch_name}", "sha256": hashes[index]})
    return inputs


def prepare(update):
    lock = json.loads(assets.LOCK.read_text())
    if update:
        lock["sourceInputs"] = source_inputs(lock)
        assets.LOCK.write_text(json.dumps(lock, indent=2) + "\n")
    if not lock.get("sourceInputs"):
        raise RuntimeError("Run this script with --update-lock when updating runtime packages")
    output = ROOT / "artifacts/t3mobile-runtime-sources.tar.gz"
    output.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(output, "w:gz") as archive:
        def put(name, data):
            member = tarfile.TarInfo(name)
            member.size = len(data)
            member.mode = 0o644
            archive.addfile(member, io.BytesIO(data))
        put("android-runtime.lock.json", assets.LOCK.read_bytes())
        put("README.txt", b"Matching sources for the bundled GPL/LGPL packages. termux-build-recipes.tar.gz contains the build scripts, Termux patches and toolchain configuration. Other archives are upstream sources; numbered patch files are additional GNU upstream patches. Exact URLs, versions and checksums are in android-runtime.lock.json. T3 Mobile source and APK packaging scripts: https://github.com/screen-gd/t3mobile/tree/feat/mobile-termux-codex\n")
        for item in lock["sourceInputs"]:
            put(item["name"], assets.pinned_bytes(item))
            print("Packaged source " + item["name"], flush=True)
    print(f"Prepared {output.name} ({output.stat().st_size // 1024 // 1024} MiB)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--update-lock", action="store_true")
    prepare(parser.parse_args().update_lock)
