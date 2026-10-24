#!/usr/bin/env python3
"""Capture real Linux Electron startup. Run inside an isolated X/DBus session.
See README.md for prerequisites and fixture provenance. No production hooks.
"""

import fcntl
import textwrap
import argparse, hashlib, json, os, pathlib, signal, sqlite3, subprocess, time

p = argparse.ArgumentParser()
p.add_argument("--worktree", required=True)
p.add_argument("--output", required=True)
p.add_argument("--seed", required=True)
p.add_argument(
    "--variant",
    choices=[
        "missing-column",
        "invalid",
        "unavailable",
        "unavailable-parent",
        "healthy",
        "missing-entry",
    ],
    required=True,
)
p.add_argument("--revision", choices=["base", "head"], required=True)
# Git refs the saved bundles were built from; the script cannot verify this.
p.add_argument("--head-source", required=True)
p.add_argument("--base-source", required=True)
p.add_argument(
    "--action", choices=["copy", "click", "escape", "close", "none"], default="copy"
)
p.add_argument("--seconds", type=int, default=33)
p.add_argument("--xclip", default="xclip")
a = p.parse_args()
w = pathlib.Path(a.worktree).resolve()
# Bounds every synchronous helper call; a timeout raises into the finally that
# restores the checkout.
TIMEOUT = 30
out = pathlib.Path(a.output).resolve()


def on_signal(signum, frame):
    if spawning:
        pending.append(signum)
    else:
        raise SystemExit(128 + signum)


# Turn SIGTERM/SIGHUP/SIGINT into SystemExit so finally restores the checkout.
# Signals arriving mid-spawn are deferred until the child is tracked.
spawning = False
pending = []
SIGNALS = [signal.SIGTERM, signal.SIGHUP, signal.SIGINT]
for sig in SIGNALS:
    signal.signal(sig, on_signal)


def source(ref):
    r = subprocess.run(
        ["git", "-C", str(w), "rev-parse", "--verify", "--end-of-options"]
        + [ref + "^{commit}"],
        capture_output=True,
        text=True,
        timeout=TIMEOUT,
    )
    if r.returncode != 0:
        raise SystemExit(f"source ref {ref!r} is not a commit in {w}")
    return {"ref": ref, "commit": r.stdout.strip()}


sources = {"head": source(a.head_source), "base": source(a.base_source)}
bundles = {
    rev: (w / f".t3/evidence-{rev}/main.cjs").read_bytes() for rev in ["head", "base"]
}
entry = w / "apps/server/dist/bin.mjs"
saved_entry = entry.with_suffix(".mjs.evidence-save")
if saved_entry.exists():
    raise SystemExit(f"{saved_entry} exists; restore it before capturing")
if a.variant == "missing-entry" and not entry.exists():
    raise SystemExit(f"{entry} is missing")
if (out.parent / ".stop-captures").exists():
    raise SystemExit("capture stop marker present")
out.mkdir(parents=True, exist_ok=False)
home = out / "home"
(home / "userdata").mkdir(parents=True)
if a.variant in ["invalid", "unavailable", "unavailable-parent"]:
    (home / "userdata/statev2.sqlite").write_bytes(b"not a SQLite database\n")
else:
    src = sqlite3.connect(
        "file:" + str(pathlib.Path(a.seed).resolve()) + "?mode=ro", uri=True
    )
    dst = sqlite3.connect(home / "userdata/statev2.sqlite")
    src.backup(dst)
    src.close()
    if a.variant == "missing-column":
        cols = [r[1] for r in dst.execute("pragma table_info(projection_threads)")]
        if "branch_pull_request_json" in cols:
            dst.execute(
                "alter table projection_threads drop column branch_pull_request_json"
            )
        assert "branch_pull_request_json" not in [
            r[1] for r in dst.execute("pragma table_info(projection_threads)")
        ]
    dst.commit()
    dst.close()
if a.variant == "unavailable-parent":
    (home / "userdata/logs").write_text(
        "capture fixture blocks log directory creation\n"
    )
if a.variant == "unavailable":
    (home / "userdata/logs/server-child.log").mkdir(parents=True)
lock = open(w / ".t3/evidence-capture.lock", "w")
fcntl.flock(lock, fcntl.LOCK_EX)
main = w / "apps/desktop/dist-electron/main.cjs"
original = main.read_bytes()
electron = w / "apps/desktop/node_modules/electron/dist/electron"
helper = out / "clipboard.cjs"
helper.write_text(
    "const {app}=require('electron');const fs=require('fs');app.whenReady().then(()=>{fs.writeFileSync(process.env.CLIP_VERSION,JSON.stringify(process.versions));app.quit();});"
)
env = os.environ.copy()
env.pop("ELECTRON_RUN_AS_NODE", None)
env["T3CODE_HOME"] = str(home)
env["CLIP_VERSION"] = str(out / "versions.json")
env["XDG_DATA_HOME"] = str(w / ".t3/keyring-data")
for key in [
    "VITE_HTTP_URL",
    "VITE_WS_URL",
    "VITE_DEV_SERVER_URL",
    "ELECTRON_RENDERER_URL",
]:
    env.pop(key, None)
procs = []
start = time.monotonic()
events = []
caption_columns = max(
    24,
    int(
        subprocess.check_output(
            ["xdotool", "getdisplaygeometry"], text=True, timeout=TIMEOUT
        ).split()[0]
    )
    // 9,
)


def event(s):
    events.append({"seconds": round(time.monotonic() - start, 3), "event": s})
    (out / "timeline.json").write_text(json.dumps(events, indent=2))
    (out / "caption.txt").write_text(
        textwrap.fill(
            f'{a.revision} {a.variant} | {events[-1]["seconds"]}s {s}',
            width=caption_columns,
        )
    )


def stop(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=6)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)


def spawn(cmd, **kw):
    global spawning
    spawning = True
    try:
        proc = subprocess.Popen(cmd, **kw)
        procs.append(proc)
    finally:
        spawning = False
    if pending:
        raise SystemExit(128 + pending[0])
    return proc


def recorder_alive(rec):
    if rec.poll() is not None:
        event(f"recorder exited early with code {rec.returncode}")
        raise SystemExit(f"ffmpeg exited early ({rec.returncode}); see ffmpeg.log")


def validate_recording(path, minimum):
    # A missing moov atom (truncated mp4) makes ffprobe fail outright.
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration"]
        + ["-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True,
        text=True,
        timeout=TIMEOUT,
    )
    try:
        duration = float(r.stdout.strip())
    except ValueError:
        duration = None
    if r.returncode != 0 or duration is None or duration < minimum:
        event(f"recording invalid: duration={duration}")
        raise SystemExit(
            f"{path} is missing or truncated (duration={duration}, "
            f"expected >= {minimum}s): {r.stderr.strip()}"
        )
    return duration


def windows():
    r = subprocess.run(
        ["xdotool", "search", "--name", "T3 Code's backend"],
        capture_output=True,
        text=True,
        timeout=TIMEOUT,
    )
    return r.stdout.split()


try:
    main.write_bytes(bundles[a.revision])
    if a.variant == "missing-entry":
        entry.rename(saved_entry)
    manifest = {
        "revision": a.revision,
        "source": sources[a.revision],
        "headSource": sources["head"],
        "baseSource": sources["base"],
        "bundleSha256": {
            rev: hashlib.sha256(b).hexdigest() for rev, b in bundles.items()
        },
        "variant": a.variant,
        "display": os.environ.get("DISPLAY"),
        "gtkTheme": os.environ.get("GTK_THEME"),
        "mainSha256": hashlib.sha256(main.read_bytes()).hexdigest(),
        "artifacts": {
            str(f.relative_to(w)): hashlib.sha256(f.read_bytes()).hexdigest()
            for f in (w / "apps/desktop/dist-electron").glob("*.cjs")
        },
        "command": [
            str(electron),
            str(w / "apps/desktop/dist-electron/boot.cjs"),
            "--no-sandbox",
            "--disable-gpu",
        ],
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    event("recording starts; whole X display; captions are capture instrumentation")
    geo = (
        subprocess.check_output(
            ["xdotool", "getdisplaygeometry"], text=True, timeout=TIMEOUT
        )
        .strip()
        .split()
    )
    size = "x".join(geo)
    manifest["screen"] = size
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    log = open(out / "app.log", "w")
    hl = open(out / "helper.log", "w")
    ff = open(out / "ffmpeg.log", "w")
    clip = spawn(
        [str(electron), str(helper), "--no-sandbox", "--disable-gpu"],
        env=env,
        stdout=hl,
        stderr=hl,
    )
    owner = spawn(
        [a.xclip, "-selection", "clipboard", "-in", "-quiet"],
        stdin=subprocess.PIPE,
        stdout=hl,
        stderr=hl,
    )
    owner.stdin.write(b"ISSUE10517-SENTINEL")
    owner.stdin.close()
    rec = spawn(
        [
            "ffmpeg",
            "-y",
            "-f",
            "x11grab",
            "-framerate",
            "10",
            "-video_size",
            size,
            "-i",
            os.environ["DISPLAY"],
            "-vf",
            f"drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:textfile={out}/caption.txt:reload=1:fontcolor=white:fontsize=16:box=1:boxcolor=black:x=8:y=h-text_h-10",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "24",
            "-pix_fmt",
            "yuv420p",
            str(out / "recording.mp4"),
        ],
        stdout=ff,
        stderr=ff,
    )
    app = spawn(manifest["command"], env=env, stdout=log, stderr=log)
    (out / "pids.json").write_text(
        json.dumps(
            {
                "app": app.pid,
                "versionHelper": clip.pid,
                "clipboardOwner": owner.pid,
                "recorder": rec.pid,
            }
        )
    )
    event("native application launched")
    deadline = time.monotonic() + a.seconds
    seen_retries = 0
    seen_windows = []
    while time.monotonic() < deadline:
        recorder_alive(rec)
        content = (out / "app.log").read_text(errors="replace")
        count = content.count("restart scheduled")
        ids_now = windows()
        if count != seen_retries:
            event("restart schedule count=" + str(count))
            seen_retries = count
        if ids_now != seen_windows:
            event("native dialog window change=" + str(ids_now))
            seen_windows = ids_now
        time.sleep(0.2)
    ids = windows()
    event("dialog windows=" + str(ids))
    (out / "windows.txt").write_text(
        subprocess.run(
            ["xdotool", "search", "--name", "."],
            capture_output=True,
            text=True,
            timeout=TIMEOUT,
        ).stdout
    )
    if ids:
        (out / "geometry.txt").write_text(
            subprocess.check_output(
                ["xdotool", "getwindowgeometry", "--shell", ids[-1]],
                text=True,
                timeout=TIMEOUT,
            )
        )
    subprocess.run(
        ["import", "-window", "root", str(out / "before-action.png")],
        check=True,
        timeout=TIMEOUT,
    )
    if ids and a.action != "none":
        wid = ids[-1]
        subprocess.run(["xdotool", "windowfocus", wid], timeout=TIMEOUT)
        event("action " + a.action)
        if a.action == "click":
            geometry = dict(
                line.split("=", 1)
                for line in subprocess.check_output(
                    ["xdotool", "getwindowgeometry", "--shell", wid],
                    text=True,
                    timeout=TIMEOUT,
                ).splitlines()
            )
            subprocess.run(
                [
                    "xdotool",
                    "mousemove",
                    "--window",
                    wid,
                    str(int(geometry["WIDTH"]) // 4),
                    str(int(geometry["HEIGHT"]) - 18),
                    "click",
                    "1",
                ],
                timeout=TIMEOUT,
            )
        elif a.action == "close":
            subprocess.run(["xdotool", "key", "Tab", "Return"], timeout=TIMEOUT)
        else:
            subprocess.run(
                ["xdotool", "key", "Return" if a.action == "copy" else "Escape"],
                timeout=TIMEOUT,
            )
        time.sleep(2)
        text = subprocess.check_output(
            [a.xclip, "-selection", "clipboard", "-out"], text=True, timeout=4
        )
        (out / "clipboard.txt").write_text(text)
        event("same-X-session clipboard readback: " + text.replace("\n", " | "))
        time.sleep(3)
        event("post-action windows=" + str(windows()))
        time.sleep(8)
    else:
        event("no dialog action target; matched observation")
        time.sleep(5)
    subprocess.run(
        ["import", "-window", "root", str(out / "after-action.png")],
        check=True,
        timeout=TIMEOUT,
    )
    event(
        "final restart schedules="
        + str((out / "app.log").read_text(errors="replace").count("restart scheduled"))
        + "; dialog windows="
        + str(windows())
    )
    time.sleep(2)
    recorder_alive(rec)
    event("recording stops")
    rec.send_signal(signal.SIGINT)
    # ffmpeg exits 255 after a clean SIGINT shutdown.
    if rec.wait(timeout=15) not in (0, 255):
        event(f"recorder exited with code {rec.returncode}")
        raise SystemExit(f"ffmpeg exited with {rec.returncode}; see ffmpeg.log")
    duration = validate_recording(out / "recording.mp4", a.seconds)
    manifest["recordingSeconds"] = duration
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    event("capture completed")
finally:
    for sig in SIGNALS:
        signal.signal(sig, signal.SIG_IGN)
    try:
        for proc in reversed(procs):
            stop(proc)
    finally:
        try:
            main.write_bytes(original)
        finally:
            try:
                if saved_entry.exists():
                    saved_entry.rename(entry)
            finally:
                (out / "cleanup.json").write_text(
                    json.dumps({str(proc.pid): proc.poll() for proc in procs})
                )
