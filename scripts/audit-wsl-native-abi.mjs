#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_NAMESPACES = ["GLIBC", "GLIBCXX", "CXXABI"];

export function compareNumericVersion(left, right) {
  const a = String(left)
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  const b = String(right)
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

export function maxNumericVersion(versions) {
  if (versions.length === 0) return "none";
  return [...versions].sort(compareNumericVersion).at(-1);
}

export function parseRequiredSymbolVersions(readelfVersionInfo) {
  const marker = "Version needs section";
  const start = readelfVersionInfo.indexOf(marker);
  const needsText = start >= 0 ? readelfVersionInfo.slice(start) : "";
  const result = Object.fromEntries(VERSION_NAMESPACES.map((namespace) => [namespace, []]));
  const pattern = /\b(GLIBCXX|GLIBC|CXXABI)_([0-9]+(?:\.[0-9]+)*)\b/g;
  for (const match of needsText.matchAll(pattern)) {
    result[match[1]].push(match[2]);
  }
  for (const namespace of VERSION_NAMESPACES) {
    result[namespace] = [...new Set(result[namespace])].sort(compareNumericVersion);
  }
  return result;
}

export function parseProvidedSymbolVersions(readelfVersionInfo) {
  const result = Object.fromEntries(VERSION_NAMESPACES.map((namespace) => [namespace, []]));
  const pattern = /\b(GLIBCXX|GLIBC|CXXABI)_([0-9]+(?:\.[0-9]+)*)\b/g;
  for (const match of readelfVersionInfo.matchAll(pattern)) {
    result[match[1]].push(match[2]);
  }
  for (const namespace of VERSION_NAMESPACES) {
    result[namespace] = [...new Set(result[namespace])].sort(compareNumericVersion);
  }
  return result;
}

export function parseNeededLibraries(readelfDynamic) {
  return [...readelfDynamic.matchAll(/Shared library: \[([^\]]+)\]/g)].map((match) => match[1]);
}

export function parseElfHeader(readelfHeader) {
  const classMatch = readelfHeader.match(/^\s*Class:\s*(.+)$/m);
  const machineMatch = readelfHeader.match(/^\s*Machine:\s*(.+)$/m);
  return {
    elfClass: classMatch?.[1]?.trim() ?? "unknown",
    machine: machineMatch?.[1]?.trim() ?? "unknown",
  };
}

export function assertVersionWithinLimit(namespace, required, limit, artifactName) {
  if (required === "none") return;
  if (compareNumericVersion(required, limit) > 0) {
    throw new Error(
      `${artifactName} requires ${namespace}_${required}, exceeding the declared WSL baseline ceiling ${namespace}_${limit}.`,
    );
  }
}

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stdout = error?.stdout?.toString?.() ?? "";
    const stderr = error?.stderr?.toString?.() ?? "";
    throw new Error(`Command failed: ${command} ${args.join(" ")}\n${stdout}${stderr}`.trim(), {
      cause: error,
    });
  }
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function resolveWslNativeArtifacts(serverRoot, arch, nodePtyPath, nodeRuntimePath) {
  const serverRequire = createRequire(path.join(path.resolve(serverRoot), "package.json"));
  const fffNodeEntry = serverRequire.resolve("@ff-labs/fff-node");
  const fffRequire = createRequire(fffNodeEntry);
  const fffPath = fffRequire.resolve(`@ff-labs/fff-bin-linux-${arch}-gnu`);
  const ffiEntry = fffRequire.resolve("ffi-rs");
  const ffiRequire = createRequire(ffiEntry);
  const ffiPath = ffiRequire.resolve(`@yuuang/ffi-rs-linux-${arch}-gnu`);
  return [
    { name: "node-runtime", path: path.resolve(nodeRuntimePath) },
    { name: "node-pty", path: path.resolve(nodePtyPath) },
    { name: "fff", path: fffPath },
    { name: "ffi-rs", path: ffiPath },
  ];
}

function expectedMachineForArch(arch) {
  if (arch === "x64") return /X86-64|Advanced Micro Devices X86-64/i;
  if (arch === "arm64") return /AArch64/i;
  throw new Error(`Unsupported WSL ABI architecture: ${arch}`);
}

function auditArtifact(artifact, { arch, limits }) {
  if (!existsSync(artifact.path)) {
    throw new Error(`WSL native artifact not found: ${artifact.name} (${artifact.path})`);
  }

  const headerText = run("readelf", ["-h", artifact.path]);
  const dynamicText = run("readelf", ["-d", artifact.path]);
  const versionText = run("readelf", ["--version-info", artifact.path]);
  const neededLibraries = parseNeededLibraries(dynamicText);
  // `ldd` returns non-zero for a valid fully-static ELF. Only invoke it when
  // DT_NEEDED entries exist; static native helpers are compatible by
  // construction with respect to runtime shared-library resolution.
  const lddText = neededLibraries.length > 0 ? run("ldd", [artifact.path]) : "";
  const header = parseElfHeader(headerText);
  const expectedMachine = expectedMachineForArch(arch);
  if (header.elfClass !== "ELF64") {
    throw new Error(`${artifact.name} must be ELF64 for WSL ${arch}; found ${header.elfClass}.`);
  }
  if (!expectedMachine.test(header.machine)) {
    throw new Error(`${artifact.name} has the wrong ELF machine for WSL ${arch}: ${header.machine}.`);
  }
  if (/\bnot found\b/i.test(lddText)) {
    throw new Error(`${artifact.name} has unresolved dynamic dependencies:\n${lddText}`);
  }

  const required = parseRequiredSymbolVersions(versionText);
  const maxRequired = {
    GLIBC: maxNumericVersion(required.GLIBC),
    GLIBCXX: maxNumericVersion(required.GLIBCXX),
    CXXABI: maxNumericVersion(required.CXXABI),
  };

  assertVersionWithinLimit("GLIBC", maxRequired.GLIBC, limits.GLIBC, artifact.name);
  assertVersionWithinLimit("GLIBCXX", maxRequired.GLIBCXX, limits.GLIBCXX, artifact.name);
  assertVersionWithinLimit("CXXABI", maxRequired.CXXABI, limits.CXXABI, artifact.name);

  return {
    name: artifact.name,
    path: path.basename(artifact.path),
    sha256: sha256File(artifact.path),
    elfClass: header.elfClass,
    machine: header.machine,
    neededLibraries,
    requiredVersions: required,
    maxRequired,
  };
}

function parseArgs(argv) {
  const options = { artifacts: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--baseline") options.baseline = value;
    else if (arg === "--arch") options.arch = value;
    else if (arg === "--max-glibc") options.maxGlibc = value;
    else if (arg === "--libstdcxx") options.libstdcxx = value;
    else if (arg === "--server-root") options.serverRoot = value;
    else if (arg === "--node-pty") options.nodePty = value;
    else if (arg === "--node-runtime") options.nodeRuntime = value;
    else if (arg === "--output") options.output = value;
    else throw new Error(`Unknown argument: ${arg}`);
    index += 1;
  }
  for (const key of ["baseline", "arch", "maxGlibc", "libstdcxx", "serverRoot", "nodePty", "nodeRuntime", "output"]) {
    if (!options[key]) throw new Error(`Missing required argument --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  return options;
}

export function buildAbiReport(options) {
  const libstdcxxVersionText = run("readelf", ["--version-info", path.resolve(options.libstdcxx)]);
  const provided = parseProvidedSymbolVersions(libstdcxxVersionText);
  const limits = {
    GLIBC: options.maxGlibc,
    GLIBCXX: maxNumericVersion(provided.GLIBCXX),
    CXXABI: maxNumericVersion(provided.CXXABI),
  };
  if (limits.GLIBCXX === "none" || limits.CXXABI === "none") {
    throw new Error(`Could not derive GLIBCXX/CXXABI ceilings from ${options.libstdcxx}.`);
  }

  const glibcRuntime = run("getconf", ["GNU_LIBC_VERSION"]).trim();
  const glibcMatch = glibcRuntime.match(/glibc\s+([0-9]+(?:\.[0-9]+)+)/i);
  if (!glibcMatch) throw new Error(`Could not parse baseline glibc version from: ${glibcRuntime}`);
  if (compareNumericVersion(glibcMatch[1], options.maxGlibc) > 0) {
    throw new Error(
      `ABI audit host glibc ${glibcMatch[1]} is newer than declared WSL baseline ${options.maxGlibc}; run this audit on the compatibility-floor image.`,
    );
  }

  const nodeRuntimeVersion = run(path.resolve(options.nodeRuntime), ["-p", "process.versions.node"]).trim();
  if (!/^\d+(?:\.\d+){2}(?:[-+].+)?$/.test(nodeRuntimeVersion)) {
    throw new Error(`Could not read bundled Node runtime version from ${options.nodeRuntime}: ${nodeRuntimeVersion}`);
  }

  const artifacts = resolveWslNativeArtifacts(
    options.serverRoot,
    options.arch,
    options.nodePty,
    options.nodeRuntime,
  ).map((artifact) => auditArtifact(artifact, { arch: options.arch, limits }));

  return {
    schemaVersion: 2,
    nodeRuntime: {
      version: nodeRuntimeVersion,
    },
    baseline: {
      id: options.baseline,
      arch: options.arch,
      glibcRuntime: glibcMatch[1],
      limits: {
        glibc: limits.GLIBC,
        glibcxx: limits.GLIBCXX,
        cxxabi: limits.CXXABI,
      },
      libstdcxx: path.basename(path.resolve(options.libstdcxx)),
    },
    artifacts,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = buildAbiReport(options);
  writeFileSync(path.resolve(options.output), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `[wsl-abi] PASS ${report.baseline.id}/${report.baseline.arch}: GLIBC<=${report.baseline.limits.glibc}, GLIBCXX<=${report.baseline.limits.glibcxx}, CXXABI<=${report.baseline.limits.cxxabi}`,
  );
  for (const artifact of report.artifacts) {
    console.log(
      `[wsl-abi] ${artifact.name}: ${artifact.machine}; max GLIBC=${artifact.maxRequired.GLIBC}, GLIBCXX=${artifact.maxRequired.GLIBCXX}, CXXABI=${artifact.maxRequired.CXXABI}; sha256=${artifact.sha256}`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
