#!/usr/bin/env python3
# post.py <row>: burn captions into out/<build>/<row> videos -> media/<row>-<build>.mp4
import json, subprocess, sys, os
EV = "/tmp/ev-22930"; row = sys.argv[1]
font = "/tmp/ev-22930/font.ttf"
for b in ("before", "after"):
    d = f"{EV}/out/{b}"
    vp = f"{d}/{row}.video-path"
    if not os.path.exists(vp): print("no video", b, row); continue
    src = open(vp).read().strip()
    ev = json.load(open(f"{d}/{row}.events.json"))["events"]
    os.makedirs(f"{d}/cap", exist_ok=True)
    filters = []
    for i, e in enumerate(ev):
        start = e["t"]; end = ev[i + 1]["t"] if i + 1 < len(ev) else 9999
        s = e.get("scope") or ""
        txt = f"{b.upper()} {row} | {e['label']}\nscrollTop={e.get('scrollTop')} {s[12:]}"
        tf = f"{d}/cap/{row}-{i}.txt"; open(tf, "w").write(txt)
        filters.append(f"drawtext=fontfile={font}:textfile={tf}:x=8:y=h-58:fontsize=14:fontcolor=white:box=1:boxcolor=black@0.75:boxborderw=6:enable='between(t,{start},{end})'")
    filters.append(f"drawtext=fontfile={font}:text='t=%{{eif\\:t\\:d}}s':x=w-80:y=8:fontsize=16:fontcolor=yellow:box=1:boxcolor=black@0.75:boxborderw=4")
    out = f"{EV}/media/{row}-{b}.mp4"
    r = subprocess.run(["/usr/bin/ffmpeg", "-y", "-loglevel", "error", "-i", src, "-vf", ",".join(filters), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "28", "-preset", "veryfast", out])
    print(out, r.returncode)
    subprocess.run(["cp", f"{d}/{row}.events.json", f"{EV}/media/{row}-{b}.events.json"])
