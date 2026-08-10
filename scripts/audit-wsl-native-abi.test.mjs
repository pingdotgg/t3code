import assert from "node:assert/strict";
import test from "node:test";

import {
  assertVersionWithinLimit,
  compareNumericVersion,
  maxNumericVersion,
  parseElfHeader,
  parseNeededLibraries,
  parseRequiredSymbolVersions,
} from "./audit-wsl-native-abi.mjs";

test("compares dotted ABI versions numerically", () => {
  assert.equal(compareNumericVersion("2.35", "2.34"), 1);
  assert.equal(compareNumericVersion("3.4.30", "3.4.30"), 0);
  assert.equal(compareNumericVersion("1.3.9", "1.3.13"), -1);
  assert.equal(maxNumericVersion(["2.17", "2.35", "2.34"]), "2.35");
});

test("parses only required symbol versions from the version-needs section", () => {
  const sample = `
Version definition section '.gnu.version_d' contains 2 entries:
  0x001c: Rev: 1  Flags: none  Index: 2  Cnt: 1  Name: GLIBCXX_9.9.9
Version needs section '.gnu.version_r' contains 3 entries:
  0x0010: Version: 1  File: libstdc++.so.6  Cnt: 2
  0x0020:   Name: GLIBCXX_3.4.30  Flags: none  Version: 7
  0x0030:   Name: CXXABI_1.3.13  Flags: none  Version: 6
  0x0040: Version: 1  File: libc.so.6  Cnt: 1
  0x0050:   Name: GLIBC_2.35  Flags: none  Version: 5
`;
  assert.deepEqual(parseRequiredSymbolVersions(sample), {
    GLIBC: ["2.35"],
    GLIBCXX: ["3.4.30"],
    CXXABI: ["1.3.13"],
  });
});

test("parses ELF identity and DT_NEEDED libraries", () => {
  assert.deepEqual(
    parseElfHeader("  Class:                             ELF64\n  Machine:                           Advanced Micro Devices X86-64\n"),
    { elfClass: "ELF64", machine: "Advanced Micro Devices X86-64" },
  );
  assert.deepEqual(
    parseNeededLibraries(" 0x0000000000000001 (NEEDED) Shared library: [libc.so.6]\n 0x1 (NEEDED) Shared library: [libstdc++.so.6]\n"),
    ["libc.so.6", "libstdc++.so.6"],
  );
});

test("fails when an artifact exceeds the declared ABI ceiling", () => {
  assert.doesNotThrow(() => assertVersionWithinLimit("GLIBC", "2.35", "2.35", "pty"));
  assert.throws(
    () => assertVersionWithinLimit("GLIBC", "2.36", "2.35", "pty"),
    /exceeding the declared WSL baseline ceiling/,
  );
});
