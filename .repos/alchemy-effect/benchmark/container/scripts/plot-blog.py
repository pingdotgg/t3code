# Generates the blog plots for the MicroVM vs Container cold-start post from a
# benchmark samples CSV (see test/bench.test.ts). Usage:
#   uv run --with matplotlib --with scipy scripts/plot-blog.py data/samples-<run>.csv <outdir>
import csv
import sys
from collections import defaultdict

import matplotlib
import numpy as np
from scipy.stats import gaussian_kde

matplotlib.use("Agg")
import matplotlib.pyplot as plt

samples_csv, outdir = sys.argv[1], sys.argv[2]

rows = []
with open(samples_csv) as f:
    for r in csv.DictReader(f):
        if r["ok"] == "true" and r["readyMs"]:
            rows.append((r["env"], r["variant"], int(r["readyMs"]) / 1000.0))

by_key = defaultdict(list)
for env, variant, s in rows:
    by_key[(env, variant)].append(s)

# Colors readable on both light and dark backgrounds.
FG = "#8b8b94"
CF = "#f6821f"  # Cloudflare orange
CF2 = "#fbb673"
VM = "#4f8ff7"  # MicroVM blue
VM2 = "#8fb8fa"
VM3 = "#2fbf9b"

plt.rcParams.update(
    {
        "figure.facecolor": "none",
        "axes.facecolor": "none",
        "savefig.facecolor": "none",
        "text.color": FG,
        "axes.edgecolor": FG,
        "axes.labelcolor": FG,
        "xtick.color": FG,
        "ytick.color": FG,
        "grid.color": FG,
        "grid.alpha": 0.15,
        "font.size": 12,
        "font.family": "sans-serif",
    }
)


def style(ax):
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.grid(True, axis="x", linewidth=0.6)
    ax.set_axisbelow(True)


# ---------------------------------------------------------------- strip plot
series = [
    ("Cloudflare container — Effect image", ("container", "effectful"), CF),
    ("Cloudflare container — plain Bun image", ("container", "bun"), CF2),
    ("AWS MicroVM — Effect image (Bun)", ("lambda\u2192microvm", "effectful-bun"), VM),
    ("AWS MicroVM — plain Bun image", ("lambda\u2192microvm", "bun"), VM2),
    ("AWS MicroVM — from a Cloudflare Worker", ("worker\u2192microvm", "effectful-bun"), VM3),
]

import random


def strip_plot(rows, fname, xmax=None, logx=False):
    fig, ax = plt.subplots(figsize=(9.5, 0.75 + 0.78 * len(rows)))
    random.seed(7)
    for i, (label, key, color) in enumerate(reversed(rows)):
        xs = by_key[key]
        ys = [i + random.uniform(-0.16, 0.16) for _ in xs]
        ax.scatter(xs, ys, s=26, color=color, alpha=0.75, linewidths=0)
    ax.set_yticks(range(len(rows)))
    ax.set_yticklabels([label for label, _, _ in reversed(rows)])
    ax.set_xlabel("time to usable service (seconds) — every boot in the run")
    if logx:
        ax.set_xscale("log")
        ax.set_xticks([1, 2, 3, 5, 10, 20, 40, 60])
        ax.set_xticklabels(["1s", "2s", "3s", "5s", "10s", "20s", "40s", "60s"])
    elif xmax:
        ax.set_xlim(0, xmax)
    style(ax)
    fig.tight_layout()
    fig.savefig(f"{outdir}/{fname}", dpi=200)
    plt.close(fig)


all_max = max(max(by_key[k]) for _, k, _ in series)
strip_plot(series, "every-boot.png", xmax=all_max * 1.04)

# ------------------------------------------------------- opencode strip plot
# Solid hues = opencode, lighter tints of the same hue = hello world.
VM_L = "#8fb8fa"
VM3_L = "#93e2cc"
oc_series = [
    ("Cloudflare container — opencode (via Worker)", ("container", "opencode"), CF),
    ("AWS MicroVM — opencode (via Lambda)", ("lambda\u2192microvm", "opencode"), VM),
    ("AWS MicroVM — opencode (via Worker)", ("worker\u2192microvm", "opencode"), VM3),
    ("Cloudflare container — hello world (via Worker)", ("container", "bun"), CF2),
    ("AWS MicroVM — hello world (via Lambda)", ("lambda\u2192microvm", "bun"), VM_L),
    ("AWS MicroVM — hello world (via Worker)", ("worker\u2192microvm", "bun"), VM3_L),
]
strip_plot(oc_series, "opencode.png", logx=True)

# --------------------------------------------------- opencode density (KDE)
# Density in log-space: the MicroVM variants show as tall narrow spikes
# (consistency), the container as a wide hump at ~10s. NB: the container's
# 20-60s tail is nearly invisible at this scale — the strip plot and the
# table's max column carry that part of the story.
fig, ax = plt.subplots(figsize=(9.5, 4.8))
grid = np.logspace(np.log10(0.3), np.log10(70), 500)
for label, key, color in oc_series:
    xs = np.log10(np.array(by_key[key]))
    density = gaussian_kde(xs, bw_method=0.25)(np.log10(grid))
    ax.plot(grid, density, color=color, linewidth=2.2, label=label)
    ax.fill_between(grid, density, color=color, alpha=0.15)
ax.set_xscale("log")
ax.set_xticks([1, 2, 3, 5, 10, 20, 40, 60])
ax.set_xticklabels(["1s", "2s", "3s", "5s", "10s", "20s", "40s", "60s"])
ax.set_xlabel("time to usable service (seconds)")
ax.set_ylabel("density")
ax.legend(frameon=False, fontsize=10.5)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
ax.grid(True, linewidth=0.6)
ax.set_axisbelow(True)
fig.tight_layout()
fig.savefig(f"{outdir}/opencode-density.png", dpi=200)
plt.close(fig)

# ----------------------------------------------------------------------- CDF
fig, ax = plt.subplots(figsize=(9.5, 4.8))
for label, key, color in series:
    xs = sorted(by_key[key])
    ys = [(i + 1) / len(xs) * 100 for i in range(len(xs))]
    ax.plot(xs, ys, color=color, linewidth=2.2, label=label)
ax.set_xlabel("time to usable service (seconds)")
ax.set_ylabel("% of boots at or below")
ax.set_xscale("log")
ax.set_xticks([1, 2, 3, 5, 10, 20])
ax.set_xticklabels(["1s", "2s", "3s", "5s", "10s", "20s"])
ax.set_ylim(0, 102)
ax.legend(frameon=False, loc="lower right", fontsize=10.5)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
ax.grid(True, linewidth=0.6)
ax.set_axisbelow(True)
fig.tight_layout()
fig.savefig(f"{outdir}/cdf.png", dpi=200)
plt.close(fig)


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p / 100 * len(xs)))]


for label, key, _ in series + oc_series:
    xs = by_key[key]
    print(
        f"{label:45s} n={len(xs):3d} p50={pct(xs,50):.1f}s p95={pct(xs,95):.1f}s max={max(xs):.1f}s"
    )
