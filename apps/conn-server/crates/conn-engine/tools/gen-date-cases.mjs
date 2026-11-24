#!/usr/bin/env node
// T3's `DateTime.make` (Effect, on Node's `Date.parse`) on fixed strings, in several zones.
// Writes `src/date-cases.json`; `--check` fails when T3's answers changed. The Rust test
// `time::tests::date_input_matches_t3s` must give the same values. No model, no CLI.
//
// The strings: hand-picked forms (ES date-times, V8's legacy forms, edges of each rule, local
// times at daylight-saving changes) and a seeded random mix of the tokens V8's parser knows.
// Each zone runs in its own Node process, as `TZ` is read once at start.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { packageImporter } from "../../../tools/monorepo.mjs";
import { sealedNodeEnv } from "../../../tools/sealed-env.mjs";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const OUT = NodePath.resolve(HERE, "../src/date-cases.json");
const ZONES = ["UTC", "America/New_York", "Europe/Amsterdam", "Asia/Kolkata", "Australia/Lord_Howe"];

// Child mode: answer for every string in the zone this process runs in.
if (process.argv[2] === "--answer") {
  const DateTime = await packageImporter("apps/server")("effect/DateTime");
  const Option = await packageImporter("apps/server")("effect/Option");
  const inputs = JSON.parse(NodeFS.readFileSync(0, "utf8"));
  const answers = inputs.map((input) => {
    const made = DateTime.make(input);
    return Option.isSome(made) ? made.value.epochMilliseconds : null;
  });
  process.stdout.write(JSON.stringify(answers));
  process.exit(0);
}

const fixed = [
  // ES date-time forms.
  "2020", "2020-01", "2020-01-02", "2020-01-02T03:04", "2020-01-02T03:04:05",
  "2020-01-02T03:04:05.006", "2020-01-02T03:04:05.006Z", "2020-01-02T03:04:05.1234567Z",
  "2020-01-02T03:04:05.1Z", "2020-01-02T03:04:05.12Z", "2020-01-02t03:04:05z",
  "2020-01-02T03:04:05+01:00", "2020-01-02T03:04:05-05:30", "2020-01-02T03:04:05+0100",
  "2020-01-02T03:04:05+01", "2020-01-02T03:04:05+24:00", "2020-01-02T03:04:05+23:59",
  "2020-01-02T24:00:00Z", "2020-01-02T24:00:00.000Z", "2020-01-02T24:00:01Z", "2020-01-02T24:01Z",
  "2020-01-02T23:60:00Z", "2020-01-02T23:59:60Z", "2020-13-01", "2020-00-01", "2020-01-32",
  "2020-02-30", "2020-02-30T00:00:00Z", "2021-02-29", "2020-01-02T", "2020-01-02T3:04Z",
  "+002020-01-02T00:00:00Z", "-002020-01-02T00:00:00Z", "-000000-01-01T00:00:00Z",
  "+010000-01-01T00:30:00.000Z", "9999-12-31T23:30:00-01:00", "+275760-09-13T00:00:00.000Z",
  "+275760-09-13T00:00:00.001Z", "-271821-04-20T00:00:00.000Z", "-271821-04-19T23:59:59.999Z",
  "+275760-09-12", "+275760-09-13", "+275760-09-14", "-271821-04-20", "-271821-04-19",
  "0000-01-01T00:00:00Z", "0001-01-01", "1970-01-01T00:00:00.000Z", "1969-12-31T23:59:59.999Z",
  // V8's legacy forms.
  "2020/01/02", "2020/1/2 10:00", "2020/01/02 10:00:00.5", "1/2/2020", "01/02/2020 10:00 UTC",
  "1/2/20", "1/2/50", "1/2/99", "1/2/100", "2020-1-2", "2020-1-02", "2020-01-2", "2020 01 02",
  "Jan 2 2020", "Jan 2, 2020 10:00:00", "January 2, 2020 3:04 PM", "2 January 2020",
  "Thu, 02 Jan 2020 03:04:05 GMT", "Thu Jan 02 2020 03:04:05 GMT+0100 (CET)", "Jan 2020",
  "Jan 2", "2020 Jan 2", "Feb 30 2020", "Janxyz 2 2020", "Ja 2 2020", "Jan-2-2020", "2-Jan-2020",
  "Jan 2 2020 10:00 am", "Jan 2 2020 10:00 pm", "Jan 2 2020 12:00 am", "Jan 2 2020 12:00 PM",
  "Jan 2 2020 13:00 pm", "Jan 2 2020 10:00 AM GMT", "Jan 2 2020 EST", "Jan 2 2020 PDT",
  "Jan 2 2020 10:00 EST", "Jan 2 2020 10:00 edt", "Jan 2 2020 10:00 cst", "Jan 2 2020 10:00 MDT",
  "Jan 2 2020 10:00 UT", "Jan 2 2020 10:00 UTC+2", "Jan 2 2020 10:00 GMT-8", "Jan 2 2020 10:00 GMT+0530",
  "Jan 2 2020 10:00 GMT+05:30", "Jan 2 2020 10:00 GMT+5:", "Jan 2 2020 10:00 +123456",
  "Jan 2 2020 10:00 +300000:", "Jan 2 2020 10:00 +596523:", "Jan 2 2020 10:00 +1193046:",
  "Jan 2 2020 10:00 +1193047:", "Jan 2 2020 10:00 Z", "Jan 2 2020 10:00 z", "Jan 2 2020 10:00-05",
  "Jan 2 2020 10::", "Jan 2 2020 10:30::", "Jan 2 2020 10:30:15.25", "Jan 2 2020 10:30:15.",
  "Jan 2 2020 10.30", "Jan 2 2020 10:30.5", "Jan 2 2020 10:30 45", "Jan 2 2020 10:30x",
  "12", "0", "-1", "99", "100", "2020", "20200102", "foo 2020", "foo2020", "(c) Jan 2 2020",
  "Jan 2 2020 (note)", "Jan (x(y)z) 2 2020", "Jan 2 2020 )", "Jan 2 2020 +", "Jan 2 2020 -",
  "  2020-01-02  ", "\t2020-01-02", "2020-01-02\n", " Jan 2 2020", "Jan 2　2020",
  "Jan 2 2020", "﻿Jan 2 2020", "2020-01-02\u0000junk", "Jan 2 2020\u0000",
  "Jan 2 2020 é", "é Jan 2 2020", "😀 Jan 2 2020", "Jan 2 2020 😀", "utc 2020", "Z 2020",
  "T 2020", "t", "T", "Z", "", " ", "GMT", "Tuesday", "Tue Jan 2", "Jan 2 2020 Tuesday",
  "Monday, January 2, 2020", "[2020-01-02]", "2020-01-02]", "x]", "Jan 2 2020 10:00 [UTC]",
  "1e3", "0x10", "Infinity", "NaN", "null", "2020.01.02", "2020_01_02", "2020,01,02",
  "Jan 2 2020 10:00 -0130", "Jan 2 2020 10:00 +01:30", "2020/01/02 10:00 -0130",
  "Jan 2 2020 10:00:00 +0000 (Coordinated Universal Time)",
  // Local times without a zone that Effect's zone check lets through as local.
  "Z 2021/03/28 02:30", "Z 2021/03/28 01:59", "Z 2021/03/28 03:00", "Z 2021/10/31 02:30",
  "Z 2021/10/31 01:30", "Z 2021/03/14 02:30", "Z 2021/11/07 01:30", "Z 2021/04/04 01:45",
  "Z 2021/10/03 02:15", "Z 2021/04/04 02:15", "2021-3-28 02:30 -02", "GMT 2021/06/15 12:00",
  "Z 1850/01/01 00:00", "Z 1900/01/01 00:00", "Z 1600/06/01 12:00", "Z 100/06/01 12:00",
  "Z 2400/07/01 12:00", "Z 9999/07/01 12:00", "Z 20000/07/01 12:00", "Z 275760/09/12 12:00",
  "Z 275760/09/13 00:00", "Zebra Jan 2 2020", "Jan 02 2020-12",
];

// Seeded mix of the tokens the parser reads (mulberry32, seed fixed).
let seed = 0x5eed1e55;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(random() * list.length)];
const digits = (n) => Array.from({ length: n }, () => Math.floor(random() * 10)).join("");
const atoms = [
  () => digits(1 + Math.floor(random() * 4)), () => digits(2), () => digits(4), () => digits(6),
  () => digits(10), () => ":", () => "-", () => "+", () => ".", () => "/", () => ",", () => " ",
  () => "T", () => "Z", () => "z", () => "(", () => ")", () => "(x)",
  () => pick(["Jan", "feb", "MAR", "april", "Mayday", "jun", "Jul", "aug", "Sept", "oct", "Nov", "dec"]),
  () => pick(["am", "pm", "AM", "PM", "UT", "UTC", "GMT", "EST", "edt", "CST", "cdt", "MST", "mdt", "PST", "pdt"]),
  () => pick(["Mon", "Tuesday", "x", "foo", "Tz", "utcx", "ja", "]", "[", "é", " ", "\t", "\n"]),
];
const range = (lo, hi, width = 1) => String(lo + Math.floor(random() * (hi - lo + 1))).padStart(width, "0");
const sane = {
  iso: () => `${range(1900, 2100)}-${range(1, 12, 2)}-${range(1, 31, 2)}${pick(["", `T${range(0, 24, 2)}:${range(0, 59, 2)}${pick(["", `:${range(0, 59, 2)}`, `:${range(0, 59, 2)}.${digits(1 + Math.floor(random() * 6))}`])}${pick(["", "Z", `+${range(0, 23, 2)}:${range(0, 59, 2)}`, `-${range(0, 14, 2)}${range(0, 59, 2)}`])}`])}`,
  legacy: () => `${pick(["", "Mon ", "Tuesday, ", "Z ", "(x) "])}${pick([
    `${pick(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])} ${range(1, 31)}${pick(["", ","])} ${range(0, 2100)}`,
    `${range(1, 31)} ${pick(["January", "march", "OCT"])} ${range(0, 2100)}`,
    `${range(1, 12)}/${range(1, 31)}/${range(0, 2100)}`,
    `${range(1000, 2100)}/${range(1, 12)}/${range(1, 31)}`,
    `${range(1000, 2100)}-${range(1, 12)}-${range(1, 31)}`,
  ])}${pick(["", ` ${range(0, 24)}:${range(0, 59, 2)}${pick(["", `:${range(0, 59, 2)}`, `:${range(0, 59, 2)}.${digits(3)}`])}${pick(["", " am", " PM"])}`])}${pick(["", " GMT", " UTC", " EST", " pdt", ` GMT${pick(["+", "-"])}${range(0, 14)}`, ` ${pick(["+", "-"])}${range(0, 14, 2)}${range(0, 59, 2)}`, " Z", " (CET)"])}`,
};
const shapes = [
  sane.iso, sane.iso, sane.legacy, sane.legacy, sane.legacy,
  () => `${digits(4)}-${digits(2)}-${digits(2)}T${digits(2)}:${digits(2)}:${digits(2)}.${digits(3)}${pick(["Z", "", "+01:00", "-0530", "+05"])}`,
  () => `${digits(4)}-${digits(2)}-${digits(2)}`,
  () => `${pick(["Jan", "Feb", "Mar", "Oct"])} ${digits(1 + Math.floor(random() * 2))} ${digits(4)} ${digits(2)}:${digits(2)}${pick(["", " am", " pm", " GMT", " EST", " +0100", " -05"])}`,
  () => `${digits(1 + Math.floor(random() * 2))}/${digits(1 + Math.floor(random() * 2))}/${digits(2 + Math.floor(random() * 3))}`,
  () => Array.from({ length: 1 + Math.floor(random() * 9) }, () => pick(atoms)()).join(""),
];
const fuzz = Array.from({ length: 1500 }, () => pick(shapes)());
const inputs = [...new Set([...fixed, ...fuzz])];

const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-date-cases-"));
let byZone;
try {
  byZone = ZONES.map((zone) => {
    const result = NodeChildProcess.spawnSync(process.execPath, [NodeURL.fileURLToPath(import.meta.url), "--answer"], {
      input: JSON.stringify(inputs),
      env: { ...sealedNodeEnv(scratch), TZ: zone },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(`${zone}: ${result.stderr}`);
    return JSON.parse(result.stdout);
  });
} finally {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
}
const cases = inputs.map((input, i) => [input, ZONES.map((_, z) => byZone[z][i])]);
const text = `${JSON.stringify({ zones: ZONES, cases }, null, 0).replaceAll('],["', '],\n["')}\n`;

if (process.argv.includes("--check")) {
  const current = NodeFS.existsSync(OUT) ? NodeFS.readFileSync(OUT, "utf8") : "";
  if (current !== text) {
    console.error(`${NodePath.relative(process.cwd(), OUT)} is stale; run without --check`);
    process.exit(1);
  }
  console.log(`date cases are current: ${cases.length} strings in ${ZONES.length} zones`);
} else {
  NodeFS.writeFileSync(OUT, text);
  console.log(`wrote ${cases.length} strings in ${ZONES.length} zones`);
}
