"""Choose a stable, contextual detail crop for PNG and GIF evidence."""

import argparse
import json
import math
from pathlib import Path
import re
import shutil
import tempfile

from prepare_proof_media import (
    ProofMediaError, atomic_write_json, publish_packet, run, safe_stem,
    sha256, tool_version, validate_packet_paths,
)


def parse_region(value):
    try:
        region = tuple(float(part) for part in value.split(","))
        if len(region) != 4 or not all(math.isfinite(part) for part in region):
            raise ValueError()
        x, y, width, height = region
        if min(x, y) < 0 or min(width, height) <= 0 or x + width > 1 or y + height > 1:
            raise ValueError()
        return region
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            "region must be normalized x,y,width,height inside the image"
        ) from exc


def frame_metadata(magick, source):
    result = run([magick, "identify", "-format", "%m|%w|%h|%T\n", str(source)], capture=True)
    return [tuple(line.split("|")) for line in result.stdout.splitlines()]


def gif_loop(source, magick="magick"):
    # Read decoded iteration semantics, including files with multiple application
    # extensions. Searching raw bytes can mistake a comment for a loop setting.
    metadata = json.loads(run([magick, str(source) + "[0]", "json:"], capture=True).stdout)
    iterations = metadata[0]["image"].get("iterations", 1)
    return None if iterations == 1 else max(0, iterations - 1)


def difference_box(magick, anchor, frames, threshold):
    # Flatten transparency as it appears on a light review page. Semantic
    # regions remain the authoritative choice for transparency/layout claims.
    # Per-channel minima and maxima bound every frame's distance from the
    # anchor. Reduce them in one process instead of decoding the MIFF per frame.
    def extreme_difference(operation):
        return [
            "(", anchor, "-background", "white", "-alpha", "remove",
            "(", *map(str, frames), "-background", "white", "-alpha", "remove",
            "-evaluate-sequence", operation, ")", "-compose", "difference", "-composite", ")",
        ]

    result = run([
        magick, *extreme_difference("min"), *extreme_difference("max"),
        "-evaluate-sequence", "max", "-separate", "-evaluate-sequence", "max",
        # A black border gives trim a known background even when every source
        # pixel changed. Remove its one-pixel offset from the resulting bounds.
        "-threshold", "{}%".format(threshold), "-bordercolor", "black", "-border", "1",
        "-format", "%[fx:mean]|%@", "info:",
    ], capture=True).stdout.strip()
    mean, geometry = result.split("|", 1)
    if float(mean) == 0:
        return None
    match = re.fullmatch(r"(\d+)x(\d+)\+(\d+)\+(\d+)", geometry)
    if match is None:
        raise ProofMediaError("Could not determine changed image bounds")
    width, height, x, y = map(int, match.groups())
    x, y = x - 1, y - 1
    return x, y, x + width, y + height


def contextual_box(boxes, width, height, padding):
    if not boxes:
        return 0, 0, width, height
    left = min(box[0] for box in boxes)
    top = min(box[1] for box in boxes)
    right = max(box[2] for box in boxes)
    bottom = max(box[3] for box in boxes)
    margin = max(24, math.ceil(max(right - left, bottom - top) * padding))
    crop_width = min(width, max(320, right - left + 2 * margin))
    crop_height = min(height, max(180, bottom - top + 2 * margin))
    x = min(max(0, (left + right - crop_width) // 2), width - crop_width)
    y = min(max(0, (top + bottom - crop_height) // 2), height - crop_height)
    return x, y, crop_width, crop_height


def build_detail(args):
    magick = shutil.which("magick")
    if magick is None:
        raise ProofMediaError("Required executable is unavailable: magick")
    if not math.isfinite(args.padding) or not 0 <= args.padding <= 2:
        raise ProofMediaError("--padding must be between 0 and 2")
    if not math.isfinite(args.difference_threshold) or not 0 <= args.difference_threshold < 100:
        raise ProofMediaError("--difference-threshold must be between 0 and less than 100")
    if args.max_width < 1:
        raise ProofMediaError("--max-width must be positive")
    inputs = {"after": Path(args.source).resolve()}
    if args.before:
        inputs["before"] = Path(args.before).resolve()
    for source in inputs.values():
        if not source.is_file():
            raise ProofMediaError("Source does not exist: {}".format(source))
    hashes = {name: sha256(path) for name, path in inputs.items()}
    formats = {}
    for name, path in inputs.items():
        metadata = frame_metadata(magick, path)
        if not metadata or metadata[0][0] not in ("PNG", "GIF"):
            raise ProofMediaError("Detail crops accept PNG screenshots and GIF animations")
        formats[name] = metadata[0][0].lower()
    loops = {name: gif_loop(path, magick) for name, path in inputs.items() if formats[name] == "gif"}
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = safe_stem(args.stem or inputs["after"].stem)
    outputs = {
        name: output_dir / "{}-{}-detail.{}".format(stem, name, formats[name])
        for name in inputs
    }
    receipt_path = output_dir / "{}-detail-receipt.json".format(stem)
    destinations = list(outputs.values()) + [receipt_path]
    validate_packet_paths(list(inputs.values()), destinations)
    if not args.overwrite and any(path.exists() for path in destinations):
        raise ProofMediaError("Output exists; choose another directory/stem or pass --overwrite")
    with tempfile.TemporaryDirectory(prefix="prepare-proof-detail-", dir=output_dir) as temporary:
        work = Path(temporary)
        frames = {}
        metadata = {}
        for name, source in inputs.items():
            frames[name] = work / (name + ".miff")
            run([magick, str(source), "-coalesce", "-auto-orient", "+repage", str(frames[name])])
            metadata[name] = frame_metadata(magick, frames[name])
        dimensions = {(int(row[1]), int(row[2])) for rows in metadata.values() for row in rows}
        if len(dimensions) != 1:
            raise ProofMediaError("Captures must have matching oriented canvas sizes; recapture at the same viewport")
        width, height = dimensions.pop()
        boxes = [
            (math.floor(x * width), math.floor(y * height),
             math.ceil((x + w) * width), math.ceil((y + h) * height))
            for x, y, w, h in args.region
        ]
        method = "semantic-regions" if boxes else "detected-changes"
        if not boxes:
            anchor = "{}[0]".format(frames.get("before", frames["after"]))
            box = difference_box(magick, anchor, frames.values(), args.difference_threshold)
            if box:
                boxes.append(box)
            if not boxes:
                method = "full-context-no-detected-change"
        crop = contextual_box(boxes, width, height, args.padding)
        x, y, crop_width, crop_height = crop
        staged = []
        artifacts = {}
        for name, destination in outputs.items():
            target = work / destination.name
            loop_options = []
            if name in loops:
                repeats = loops[name]
                iterations = 1 if repeats is None else (0 if repeats == 0 else repeats + 1)
                loop_options = ["-loop", str(iterations)]
            run([
                magick, str(frames[name]), "-crop", "{}x{}+{}+{}".format(crop_width, crop_height, x, y),
                "+repage", "-resize", "{}x>".format(args.max_width), *loop_options, str(target),
            ])
            rendered = frame_metadata(magick, target)
            if len(rendered) != len(metadata[name]) or [r[3] for r in rendered] != [r[3] for r in metadata[name]]:
                raise ProofMediaError("Detail rendering changed frame count or timing")
            if name in loops and len(rendered) == 1 and loops[name] is not None and gif_loop(target, magick) is None:
                # ImageMagick omits loop extensions for a single-frame GIF even
                # with -loop. Restore that metadata after its global color table.
                data = target.read_bytes()
                offset = 13 + (3 * (2 ** ((data[10] & 7) + 1)) if data[10] & 128 else 0)
                extension = b"\x21\xff\x0bNETSCAPE2.0\x03\x01" + loops[name].to_bytes(2, "little") + b"\x00"
                target.write_bytes(b"GIF89a" + data[6:offset] + extension + data[offset:])
            if name in loops and loops[name] != gif_loop(target, magick):
                raise ProofMediaError("Detail rendering changed GIF looping")
            artifacts[name] = {
                "path": str(destination), "sha256": sha256(target),
                "width": int(rendered[0][1]), "height": int(rendered[0][2]),
                "frames": len(rendered), "delays_centiseconds": [int(row[3]) for row in rendered],
            }
            staged.append((target, destination))
        if any(sha256(path) != hashes[name] for name, path in inputs.items()):
            raise ProofMediaError("Source changed during detail rendering")
        receipt = {
            "version": 1, "kind": "proof-detail-crop", "method": method,
            "reason": args.reason,
            "source_dimensions": {"width": width, "height": height},
            "crop": {"x": x, "y": y, "width": crop_width, "height": crop_height},
            "regions": args.region, "padding": args.padding,
            "difference_threshold_percent": args.difference_threshold, "max_width": args.max_width,
            "sources": {name: {"path": str(path), "sha256": hashes[name]} for name, path in inputs.items()},
            "artifacts": artifacts, "tools": {"magick": tool_version(magick)},
        }
        staged_receipt = work / receipt_path.name
        atomic_write_json(staged_receipt, receipt)
        publish_packet(staged + [(staged_receipt, receipt_path)], receipt_path)
    print(receipt_path)
