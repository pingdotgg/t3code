import { assert, describe, it } from "vite-plus/test";

import {
  accent,
  accentFor,
  corners,
  cssColor,
  dolomitesGradientPairs,
  effortColor,
  effortLevelColors,
  gradientPair,
  hexString,
  interactionModeTint,
  lavender,
  lichen,
  rgb,
  rgbFromHex,
  runtimeModeTint,
  sceneryWash,
  stableIndex,
} from "./palette.ts";

describe("stableIndex", () => {
  it("matches the macOS FNV-1a values for known seeds", () => {
    // Reference values computed from the same 64-bit FNV-1a the Swift
    // `AlpineTheme.stableIndex` runs (offset basis 0xcbf29ce484222325,
    // prime 0x100000001b3, wrapping multiply).
    assert.equal(stableIndex("", 6), Number(0xcbf2_9ce4_8422_2325n % 6n));
    assert.equal(stableIndex("a", 6), Number(0xaf63_dc4c_8601_ec8cn % 6n));
    assert.equal(stableIndex("foobar", 6), Number(0x85944171f73967e8n % 6n));
  });

  it("is stable across calls and total over the range", () => {
    const seeds = ["thread-1", "thread-2", "Santorini, Greece", "Kyoto, Japan", "🏔"];
    for (const seed of seeds) {
      const first = stableIndex(seed, dolomitesGradientPairs.length);
      assert.equal(stableIndex(seed, dolomitesGradientPairs.length), first);
      assert.isAtLeast(first, 0);
      assert.isBelow(first, dolomitesGradientPairs.length);
    }
  });

  it("degrades to 0 for an empty range instead of dividing by zero", () => {
    assert.equal(stableIndex("anything", 0), 0);
    assert.equal(stableIndex("anything", -3), 0);
  });

  it("handles multi-byte seeds by hashing UTF-8 bytes", () => {
    // A non-ASCII seed must not be hashed as UTF-16 code units, or macOS and
    // Windows would disagree about which photo a thread gets.
    assert.notEqual(stableIndex("é", 997), stableIndex("e", 997));
  });
});

describe("color helpers", () => {
  it("round-trips hex", () => {
    assert.equal(hexString(rgb(1, 1, 1)), "#FFFFFF");
    assert.equal(hexString(rgb(0, 0, 0)), "#000000");
    assert.deepEqual(rgbFromHex("#FFFFFF"), rgb(1, 1, 1));
    assert.deepEqual(rgbFromHex("000000"), rgb(0, 0, 0));
    const parsed = rgbFromHex(hexString(accent));
    assert.isDefined(parsed);
    assert.equal(hexString(parsed!), hexString(accent));
  });

  it("rejects malformed hex", () => {
    assert.isUndefined(rgbFromHex("#FFF"));
    assert.isUndefined(rgbFromHex("#GGGGGG"));
    assert.isUndefined(rgbFromHex(""));
    assert.isUndefined(rgbFromHex("#1234567"));
  });

  it("clamps out-of-gamut channels rather than emitting invalid CSS", () => {
    assert.equal(cssColor(rgb(2, -1, 0.5)), "rgb(255 0 128)");
    assert.equal(cssColor(accent, 0.22), "rgb(145 201 163 / 0.22)");
  });
});

describe("effort ramp", () => {
  it("keeps the macOS slot order", () => {
    assert.equal(effortLevelColors.length, 5);
    assert.deepEqual(effortColor(0), effortLevelColors[0]);
    assert.deepEqual(effortColor(4), lavender);
  });

  it("clamps out-of-range slots to the nearest edge", () => {
    assert.deepEqual(effortColor(-5), effortLevelColors[0]);
    assert.deepEqual(effortColor(99), effortLevelColors[4]);
  });
});

describe("mode tints", () => {
  it("assigns a tint to every runtime mode", () => {
    for (const mode of ["approvalRequired", "autoAcceptEdits", "auto", "fullAccess"] as const) {
      assert.isDefined(runtimeModeTint(mode));
    }
  });

  it("leaves the normal interaction mode unaccented", () => {
    assert.isUndefined(interactionModeTint("normal"));
    assert.deepEqual(interactionModeTint("advisor"), lichen);
  });
});

describe("scenery palettes", () => {
  const palette = {
    accentHex: "#123456",
    // Manifest order is [darkBase, lighterWash].
    washes: [["#102030", "#A0B0C0"]],
  };

  it("prefers a palette accent and falls back to the app accent", () => {
    assert.deepEqual(accentFor(palette), rgbFromHex("#123456"));
    assert.deepEqual(accentFor(undefined), accent);
    assert.deepEqual(accentFor({ accentHex: "nonsense" }), accent);
  });

  it("flips manifest pairs into light-top/dark-bottom gradients", () => {
    const pair = gradientPair("seed", palette);
    assert.deepEqual(pair.top, rgbFromHex("#A0B0C0"));
    assert.deepEqual(pair.bottom, rgbFromHex("#102030"));
  });

  it("ignores malformed wash entries and keeps the Dolomites fallback", () => {
    const broken = { washes: [["#zzzzzz", "#A0B0C0"], ["#102030"]] };
    assert.deepEqual(gradientPair("seed", broken), gradientPair("seed", undefined));
  });

  it("keeps the black/white wash treatment without a palette", () => {
    assert.deepEqual(sceneryWash("seed", undefined, "dark"), rgb(0, 0, 0));
    assert.deepEqual(sceneryWash("seed", undefined, "light"), rgb(1, 1, 1));
    assert.deepEqual(sceneryWash("seed", palette, "dark"), rgbFromHex("#102030"));
    assert.deepEqual(sceneryWash("seed", palette, "light"), rgbFromHex("#A0B0C0"));
  });
});

describe("geometry", () => {
  it("keeps the macOS corner scale", () => {
    assert.deepEqual(corners, {
      compact: 5,
      control: 8,
      card: 10,
      composer: 14,
      hero: 16,
    });
  });
});
