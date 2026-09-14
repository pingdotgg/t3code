"""Stage an untrusted preview ZIP without letting it replace packaging code."""

import shutil
import stat
import sys
import zipfile
from pathlib import Path

ROOTS = ("server/dist", "desktop/dist-electron")
REQUIRED_FILES = {
    "server/dist/bin.mjs",
    "server/dist/client/index.html",
    "desktop/dist-electron/main.cjs",
}
# The current bundle is about 32 MiB compressed. Bound extraction on the
# trusted runner even when the PR replaces the uploader entirely.
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024
MAX_ENTRIES = 50_000


def stage_bundle(archive: Path, destination: Path):
    if archive.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("Preview archive is too large")
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if len(entries) > MAX_ENTRIES:
            raise ValueError("Preview archive has too many entries")
        if sum(entry.file_size for entry in entries) > MAX_EXPANDED_BYTES:
            raise ValueError("Expanded preview bundle is too large")
        seen = set()
        files = set()
        for entry in entries:
            name = entry.filename.removesuffix("/")
            parts = name.split("/")
            # Reject ambiguous paths before normalization, including names
            # that would alias on the macOS signing runner.
            if (
                entry.orig_filename != entry.filename
                or any(part in ("", ".", "..") for part in parts)
                or any(char in name for char in "\\:")
                or not name.isascii()
                or any(ord(char) < 32 or ord(char) == 127 for char in name)
            ):
                raise ValueError(f"Unsafe preview path: {entry.filename!r}")
            allowed = any(name.startswith(root + "/") for root in ROOTS)
            if entry.is_dir():
                allowed |= any(root == name or root.startswith(name + "/") for root in ROOTS)
            if not allowed:
                raise ValueError(f"Unexpected preview path: {name!r}")
            kind = stat.S_IFMT(entry.external_attr >> 16)
            if kind not in (0, stat.S_IFDIR if entry.is_dir() else stat.S_IFREG):
                raise ValueError(f"Non-regular preview entry: {name!r}")
            if name.casefold() in seen:
                raise ValueError(f"Duplicate preview path: {name!r}")
            seen.add(name.casefold())
            if not entry.is_dir():
                files.add(name)
        if not REQUIRED_FILES <= files:
            raise ValueError("Preview bundle is missing required entry points")
        # Validate all names before writing anything. This is a fresh directory
        # outside the checkout; neither pre-existing links nor trusted files
        # can be followed or overwritten. ZIP permissions are never restored.
        destination.mkdir(parents=True, exist_ok=False)
        for entry in entries:
            target = destination / entry.filename
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(entry) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)


if __name__ == "__main__":
    stage_bundle(Path(sys.argv[1]), Path(sys.argv[2]))
