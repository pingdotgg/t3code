import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import semver from "semver";
import { compareVersions, parseVersion, rangeFloor } from "../dist/semver.js";

const format = (version) => version && version.join(".");

NodeTest.test("compareVersions orders plain versions numerically", () => {
  // Each row sorts strictly before the next.
  const ascending = [
    "0.0.0",
    "0.0.1",
    "1.0.0",
    "1.0.9",
    "1.0.10",
    "1.0.20260927",
    "1.0.9007199254740991",
    "1.1.0",
    "1.2.0",
    "1.10.0",
    "2.0.0",
    "10.0.0",
    "9007199254740991.0.0",
  ];
  for (let i = 0; i < ascending.length; i++)
    for (let j = 0; j < ascending.length; j++) {
      const result = compareVersions(parseVersion(ascending[i]), parseVersion(ascending[j]));
      NodeAssert.equal(result, Math.sign(i - j), `${ascending[i]} vs ${ascending[j]}`);
    }
});

NodeTest.test("parseVersion accepts plain X.Y.Z and nothing else", () => {
  for (const version of ["0.0.0", "1.0.0", "1.2.3", "1.0.9007199254740991"])
    NodeAssert.equal(format(parseVersion(version)), version);
  for (const version of [
    "1.0",
    "01.0.0",
    "1.0.0-0",
    "0.0.0-0",
    "1.2.0-rc.1",
    "1.1.0+build.1",
    "1.0.9007199254740992",
    "1.0.99999999999999999999",
    "v1.0.0",
    "^1.0.0",
    " 1.0.0",
    "",
  ])
    NodeAssert.equal(parseVersion(version), null, version);
});

NodeTest.test("rangeFloor bounds the range shapes packs write and refuses the rest", () => {
  for (const [range, floor] of [
    ["1.1.0", "1.1.0"],
    [">=1.1.0", "1.1.0"],
    [">=1.1.0 <2.0.0", "1.1.0"],
    [">=1.1.0 <1.1.1", "1.1.0"],
    ["^1.1.0", "1.1.0"],
    ["~1.1.0", "1.1.0"],
    ["^0.2.3", "0.2.3"],
    ["0.0.0", "0.0.0"],
    [">=1.0.20260927", "1.0.20260927"],
    ["^1.0.9007199254740991", "1.0.9007199254740991"],
  ])
    NodeAssert.equal(format(rangeFloor(range)), floor, range);
  for (const range of [
    // Prereleases and build metadata.
    "0.0.0-0",
    ">=1.1.0-rc.1",
    "^1.1.0-rc.1",
    "1.1.0+build.1",
    ">=1.1.0-9007199254740992",
    // Other operators and spellings.
    "=1.1.0",
    "v1.1.0",
    ">1.1.0",
    "<=1.4.0",
    "<2.0.0",
    "<2.0.0 >=1.1.0",
    ">= 1.1.0",
    "~>1.1.0",
    " ^1.1.0",
    // x-ranges, partials, unions, hyphens.
    "*",
    "1.1.x",
    "1.X",
    "^1.1",
    "~1",
    "1",
    "^1.1.0 || ^1.2.0",
    "1.1.0 - 2.0.0",
    // Components past Number.MAX_SAFE_INTEGER, and empty ranges.
    "^1.0.9007199254740992",
    "~1.0.99999999999999999999",
    ">=1.0.0 <1.0.99999999999999999999",
    ">=1.1.0 <1.1.0",
    ">=1.1.0 <1.0.0",
    "01.1.0",
    ">=",
    "latest",
    "",
  ])
    NodeAssert.equal(rangeFloor(range), null, range);
});

// The corpus the sdk-capture-actions review used against node-semver, with the
// same seed. Accepted shapes must match node-semver exactly; everything else
// must be refused rather than floored above semver.minVersion.
let seed = 0x9272026;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};
const pick = (items) => items[Math.floor(random() * items.length)];
const nums = [
  "0",
  "1",
  "2",
  "9",
  "10",
  "99",
  "100",
  "999999",
  "1000000",
  "20260927",
  "9007199254740990",
  "9007199254740991",
];
const ids = (
  "0 1 2 9 10 99 100 alpha beta rc A Z a z a1 1a - x-y 9007199254740990 9007199254740991 " +
  "9007199254740992 9007199254740993 9007199254740994 99999999999999999998 " +
  "99999999999999999999 100000000000000000000"
)
  .split(" ")
  .concat("1" + "0".repeat(180), "1" + "0".repeat(179) + "1");
const pres = [""].concat(
  ...["-", "-rc."].flatMap((prefix) => ids.map((x) => prefix + x)),
  ...[".a", ".z", ".0", ".1"].map((suffix) => ids.map((x) => "-" + x + suffix)),
  "-alpha.1 -alpha.beta -beta.2 -beta.11 -rc.1 -0.0 -0.1 -0.alpha".split(" "),
);
const builds = ["", "+build.1", "+0", "+001", "+a.b-c"];

NodeTest.test("parseVersion and compareVersions agree with node-semver", () => {
  const versions = new Set();
  for (const a of nums) for (const b of nums) for (const c of nums) versions.add(`${a}.${b}.${c}`);
  for (const base of ["0.0.0", "0.0.1", "0.1.0", "1.0.0", "1.1.0", "1.2.0", "2.0.0"])
    for (const pre of pres) for (const build of builds) versions.add(base + pre + build);
  for (let i = 0; i < 10000; i++)
    versions.add(`${pick(nums)}.${pick(nums)}.${pick(nums)}${pick(pres)}${pick(builds)}`);
  const plain = [];
  for (const text of versions) {
    const parsed = semver.parse(text);
    const isPlain = parsed !== null && parsed.version === text && !parsed.prerelease.length;
    NodeAssert.equal(parseVersion(text) !== null, isPlain, text);
    if (isPlain) plain.push(text);
  }
  NodeAssert.ok(plain.length >= nums.length ** 3);
  const parsed = plain.map((text) => [text, parseVersion(text), new semver.SemVer(text)]);
  for (const [a, x, xs] of parsed)
    for (const [b, y, ys] of parsed)
      if (compareVersions(x, y) !== xs.compare(ys)) NodeAssert.fail(`${a} vs ${b}`);
});

NodeTest.test("rangeFloor is semver.minVersion or refuses", () => {
  const ranges = new Set(["", "*", "x", "X", "||", "* || >=1.1.0", "1.1.0 - 2.0.0", ">= 1.1.0"]);
  for (const range of ["~>1.1.0", "nope", "01.1.0", ">=", "^1.1.0 || nope"]) ranges.add(range);
  const bounds = [];
  const ops = ["", "=", "v", ">=", ">", "^", "~", "<=", "<", ">=v", ">v", "^v", "~v", "<=v", "<v"];
  const bases = ["0.0.0", "0.0.1", "0.1.0", "0.2.3", "1.0.0", "1.0.20260927", "1.1.0", "1.2.0"];
  bases.push("2.0.0", "10.0.0");
  const smallPres = ["", "-0", "-0.0", "-1", "-alpha", "-alpha.1", "-rc.1", "-9007199254740992"];
  smallPres.push("-9007199254740993", "-9007199254740992.z", "-9007199254740993.a");
  for (const base of bases)
    for (const pre of smallPres)
      for (const build of ["", "+build.1"])
        for (const op of ops) {
          ranges.add(op + base + pre + build);
          if (!build) bounds.push(op + base + pre);
        }
  const parts = ["0", "1", "2", "x", "X", "*"];
  for (const a of ["0", "1", "2", "10", "x", "X", "*"]) {
    const partials = [a];
    for (const b of parts) {
      partials.push(`${a}.${b}`);
      for (const c of parts) partials.push(`${a}.${b}.${c}`);
    }
    for (const partial of partials)
      for (const op of ops) {
        ranges.add(op + partial);
        bounds.push(op + partial);
      }
  }
  const edge = [">=0.0.0-0", ">=0.0.0-alpha", "0.0.0-rc.1", "^0.0.0-0", "<0.0.0", "<=0.0.0-rc.1"];
  edge.push("<0.0.0-0", "^1.1.0", "1.1.x", ">=1.1.0-rc.1", ">=1.0.0", "<2.0.0", ">1.1");
  edge.push(">=1.1.0", "*", "<1.0.0", ">=2.0.0");
  for (const a of edge)
    for (const b of bounds) {
      ranges.add(`${a} ${b}`);
      ranges.add(`${b} ${a}`);
      ranges.add(`${a} || ${b}`);
    }
  for (let i = 0; i < 100000; i++) {
    const [a, b, c] = [pick(bounds), pick(bounds), pick(bounds)];
    ranges.add(
      i % 3 === 0 ? `${a} ${b} || ${c}` : i % 3 === 1 ? `${a} || ${b} ${c}` : `${a} ${b} ${c}`,
    );
  }
  // Every accepted shape over the plain corpus versions, including empty ones.
  const plain = nums.flatMap((a) => ["0", "1", "20260927", a].map((b) => `${a}.${b}.${a}`));
  for (const version of plain) {
    for (const op of ["", "^", "~", ">="]) ranges.add(op + version);
    for (const ceiling of plain) ranges.add(`>=${version} <${ceiling}`);
  }
  // node-semver throws where a range's desugared bound passes
  // Number.MAX_SAFE_INTEGER (`^9007199254740991.0.0`); the host refuses those.
  const minVersion = (range) => {
    try {
      return semver.minVersion(range);
    } catch {
      return undefined;
    }
  };
  const accepted = /^(?:(?:\^|~|>=)?\d+\.\d+\.\d+|>=\d+\.\d+\.\d+ <\d+\.\d+\.\d+)$/;
  let floored = 0;
  for (const range of ranges) {
    const floor = format(rangeFloor(range));
    // Refusing is always safe, but an accepted, non-empty shape must not be refused.
    if (floor === null && !accepted.test(range)) continue;
    const minimum = minVersion(range);
    if (minimum === undefined) continue;
    if (floor === null) {
      NodeAssert.equal(minimum, null, range);
      continue;
    }
    floored++;
    NodeAssert.equal(floor, minimum?.version, range);
  }
  NodeAssert.ok(floored > 1000, `only ${floored} ranges floored`);
});
