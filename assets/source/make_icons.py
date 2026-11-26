#!/usr/bin/env python3
"""Render Hyakki's app icons from the Ryoku mark, in the frames T3 Code's icons used."""
import os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
MARK = os.path.join(HERE, "mark.svg")
OUT = os.path.dirname(HERE)

mark_src = open(MARK).read()
group = re.search(r"<g\b[^>]*>.*?</g>", mark_src, re.S).group(0)
group = group.replace('fill="#ebe2d6"', 'fill="url(#ink)"').replace('fill="#ce5e32"', 'fill="url(#tip)"')

VARIANTS = {
    "prod": dict(top="#2b2b2b", bottom="#0b0b0b", glow="#ffffff", glow_opacity=0.10, extra=""),
    "nightly": dict(top="#3a3f86", bottom="#0f1230", glow="#b9a7ff", glow_opacity=0.16, extra="nightly"),
    "dev": dict(top="#3b7bea", bottom="#163f99", glow="#ffffff", glow_opacity=0.12, extra="dev"),
}


def decorations(kind):
    if kind == "nightly":
        stars = [(170, 210, 3.2), (300, 120, 2.2), (820, 170, 3.0), (900, 330, 2.0), (720, 90, 1.8),
                 (130, 420, 1.8), (610, 160, 1.6), (880, 560, 1.6), (240, 300, 1.4)]
        dots = "".join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="#ffffff" opacity="0.75"/>' for x, y, r in stars)
        cloud = ('<g filter="url(#blur)" opacity="0.55">'
                 '<ellipse cx="230" cy="900" rx="330" ry="120" fill="#8b6cf0"/>'
                 '<ellipse cx="430" cy="960" rx="300" ry="110" fill="#6b4fd6"/>'
                 '<ellipse cx="860" cy="140" rx="200" ry="70" fill="#7d64e8" opacity="0.6"/></g>')
        return dots + cloud
    if kind == "dev":
        lines = []
        for i in range(1, 16):
            p = i * 64
            w = 1.6 if i % 4 == 0 else 0.8
            lines.append(f'<line x1="{p}" y1="0" x2="{p}" y2="1024" stroke="#ffffff" stroke-width="{w}" opacity="0.13"/>')
            lines.append(f'<line x1="0" y1="{p}" x2="1024" y2="{p}" stroke="#ffffff" stroke-width="{w}" opacity="0.13"/>')
        ticks = ('<g stroke="#ffffff" stroke-width="3" opacity="0.35" fill="none">'
                 '<path d="M150 870 H874 M150 850 V890 M874 850 V890"/>'
                 '<path d="M110 160 V820 M90 160 H130 M90 820 H130"/>'
                 '<circle cx="512" cy="512" r="330" stroke-dasharray="10 14"/></g>')
        return "".join(lines) + ticks
    return ""


def icon_svg(kind, frame):
    v = VARIANTS[kind]
    # frame: (tile x/y offset, tile size, corner radius) inside a 1024 canvas
    off, size, radius = frame
    mark_w = size * 0.66
    scale = mark_w / 556
    mark_h = 482 * scale
    mx = off + (size - mark_w) / 2
    my = off + (size - mark_h) / 2 + size * 0.01
    shadow_tile = ""
    if off > 0:
        shadow_tile = (f'<rect x="{off}" y="{off + 12}" width="{size}" height="{size}" rx="{radius}" '
                       f'fill="#000000" opacity="0.35" filter="url(#tileshadow)"/>')
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs>
  <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="{v['top']}"/><stop offset="1" stop-color="{v['bottom']}"/>
  </linearGradient>
  <radialGradient id="glow" cx="0.5" cy="0.0" r="0.85">
    <stop offset="0" stop-color="{v['glow']}" stop-opacity="{v['glow_opacity']}"/>
    <stop offset="1" stop-color="{v['glow']}" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffffff" stop-opacity="0.28"/>
    <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.04"/>
    <stop offset="1" stop-color="#ffffff" stop-opacity="0.10"/>
  </linearGradient>
  <linearGradient id="ink" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fbf6ee"/><stop offset="0.55" stop-color="#ebe2d6"/><stop offset="1" stop-color="#c9bfb1"/>
  </linearGradient>
  <linearGradient id="tip" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#f08a55"/><stop offset="1" stop-color="#c2532a"/>
  </linearGradient>
  <filter id="markshadow" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000000" flood-opacity="0.45"/>
  </filter>
  <filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="40"/></filter>
  <filter id="tileshadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14"/></filter>
  <clipPath id="clip"><rect x="{off}" y="{off}" width="{size}" height="{size}" rx="{radius}"/></clipPath>
</defs>
{shadow_tile}
<g clip-path="url(#clip)">
  <rect x="{off}" y="{off}" width="{size}" height="{size}" fill="url(#tile)"/>
  <g transform="translate({off} {off}) scale({size / 1024})">{decorations(v['extra'])}</g>
  <rect x="{off}" y="{off}" width="{size}" height="{size}" fill="url(#glow)"/>
</g>
<rect x="{off + 2}" y="{off + 2}" width="{size - 4}" height="{size - 4}" rx="{radius - 2}" fill="none" stroke="url(#edge)" stroke-width="4"/>
<g filter="url(#markshadow)"><svg x="{mx}" y="{my}" width="{mark_w}" height="{mark_h}" viewBox="0 0 556 482">{group}</svg></g>
</svg>
'''


FULL = (0, 1024, 229)
MACOS = (100, 824, 185)


def render(svg_text, path, size):
    tmp = path + ".svg"
    open(tmp, "w").write(svg_text)
    subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), tmp, "-o", path], check=True)
    os.remove(tmp)


def ico(svg_text, path, sizes=(16, 24, 32, 48, 64, 128, 256)):
    parts = []
    for s in sizes:
        p = f"{path}.{s}.png"
        render(svg_text, p, s)
        parts.append(p)
    subprocess.run(["magick", *parts, path], check=True)
    for p in parts:
        os.remove(p)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    names = {"prod": ("black", "hyakki"), "nightly": ("nightly", "nightly"), "dev": ("blueprint", "blueprint")}
    for kind, (big, web) in names.items():
        d = os.path.join(OUT, kind)
        os.makedirs(d, exist_ok=True)
        full, mac = icon_svg(kind, FULL), icon_svg(kind, MACOS)
        render(full, f"{d}/{big}-ios-1024.png", 1024)
        render(full, f"{d}/{big}-universal-1024.png", 1024)
        render(mac, f"{d}/{big}-macos-1024.png", 1024)
        for s, n in ((180, "web-apple-touch-180"), (192, "web-icon-192x192"), (512, "web-icon-512x512"),
                     (16, "web-favicon-16x16"), (32, "web-favicon-32x32")):
            render(full, f"{d}/{web}-{n}.png", s)
        ico(full, f"{d}/{web}-web-favicon.ico")
        ico(full, f"{d}/{web}-windows.ico")
        if kind == "prod":
            open(f"{d}/logo.svg", "w").write(full)
    print("ok")


def composer_mark():
    # 128-unit canvas scaled 8.5x by Icon Composer; the mark spans 66% of the 1024pt icon
    w = 1024 * 0.66 / 8.5
    h = w * 482 / 556
    x, y = 64 - w / 2, 64 - h / 2 + 1
    flat = re.search(r"<g\b[^>]*>.*?</g>", mark_src, re.S).group(0)
    return (f'<svg width="128" height="128" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">'
            f'<svg x="{x:.3f}" y="{y:.3f}" width="{w:.3f}" height="{h:.3f}" viewBox="0 0 556 482">{flat}</svg></svg>\n')


def composer_background(kind):
    v = VARIANTS[kind]
    return (f'<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">'
            f'<defs><linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{v["top"]}"/>'
            f'<stop offset="1" stop-color="{v["bottom"]}"/></linearGradient>'
            f'<filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="40"/></filter></defs>'
            f'<rect width="128" height="128" fill="url(#tile)"/><g transform="scale(0.125)">{decorations(v["extra"])}</g></svg>\n')


def plain_tile(kind, with_mark, mark_frac):
    v = VARIANTS[kind]
    mark = ""
    if with_mark:
        w = 1024 * mark_frac
        h = w * 482 / 556
        mark = (f'<g filter="url(#markshadow)"><svg x="{(1024 - w) / 2}" y="{(1024 - h) / 2 + 10}" width="{w}" '
                f'height="{h}" viewBox="0 0 556 482">{group}</svg></g>')
    return icon_svg(kind, FULL).split("<g clip-path")[0].replace(
        f'<clipPath id="clip"><rect x="0" y="0" width="1024" height="1024" rx="229"/></clipPath>', "") + (
        f'<rect width="1024" height="1024" fill="url(#tile)"/>{decorations(v["extra"])}'
        f'<rect width="1024" height="1024" fill="url(#glow)"/>{mark}</svg>\n')


def mark_only(frac, flat_white=False):
    w = 1024 * frac
    h = w * 482 / 556
    body = group
    defs = icon_svg("prod", FULL).split("</defs>")[0].split("<svg", 1)[1].split(">", 1)[1]
    if flat_white:
        body = re.sub(r'fill="url\(#(ink|tip)\)"', 'fill="#ffffff"', group)
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><svg x="{(1024 - w) / 2}" '
                f'y="{(1024 - h) / 2}" width="{w}" height="{h}" viewBox="0 0 556 482">{body}</svg></svg>\n')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">{defs}</defs><g filter="url(#markshadow)">'
            f'<svg x="{(1024 - w) / 2}" y="{(1024 - h) / 2}" width="{w}" height="{h}" viewBox="0 0 556 482">{body}</svg></g></svg>\n')


def android(mobile_assets):
    render(plain_tile("dev", False, 0), f"{mobile_assets}/android-icon-background-dev.png", 432)
    render(plain_tile("nightly", False, 0), f"{mobile_assets}/android-icon-background-nightly.png", 432)
    render(mark_only(0.50), f"{mobile_assets}/android-icon-foreground.png", 432)
    render(mark_only(0.60, flat_white=True), f"{mobile_assets}/android-icon-mark.png", 432)
    render(mark_only(0.66, flat_white=True), f"{mobile_assets}/android-notification-icon.png", 96)
    for kind, name in (("prod", "prod"), ("nightly", "nightly"), ("dev", "dev")):
        render(plain_tile(kind, True, 0.50), f"{mobile_assets}/android-splash-icon-{name}.png", 1152)
