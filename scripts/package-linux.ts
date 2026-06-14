#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  resolveLinuxPackageArch,
  toDebArch,
  toDebVersion,
  toRpmArch,
  toRpmVersion,
  type LinuxPackageArch,
} from "./lib/linux-package.ts";

type PackageFormat = "deb" | "rpm";

interface ServerPackageJson {
  readonly version: string;
  readonly license: string;
  readonly repository: {
    readonly url: string;
  };
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagingDir = join(repoRoot, "packaging/linux");
const serverDir = join(repoRoot, "apps/server");
const serverDistDir = join(serverDir, "dist");

function run(command: string, args: ReadonlyArray<string>, cwd = repoRoot): void {
  process.stdout.write(`+ ${command} ${args.join(" ")}\n`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readPackageScript(name: string): ReadonlyArray<string> {
  return readFileSync(join(packagingDir, name), "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("#!"));
}

export function writeDebianPackageMetadata(
  root: string,
  serverPackage: ServerPackageJson,
  architecture: LinuxPackageArch,
  conffiles: ReadonlyArray<string>,
): void {
  const debVersion = toDebVersion(serverPackage.version);
  const controlDir = join(root, "DEBIAN");
  mkdirSync(controlDir, { recursive: true });
  writeFileSync(
    join(controlDir, "control"),
    [
      "Package: morecode-headless",
      `Version: ${debVersion.upstream}-${debVersion.revision}`,
      `Architecture: ${toDebArch(architecture)}`,
      "Maintainer: more Code <support@morecode.codes>",
      "Depends: nodejs (>= 22.16), git, systemd",
      "Section: devel",
      "Priority: optional",
      `Homepage: ${serverPackage.repository.url}`,
      "Description: Headless more Code server for coding agents",
      " Run more Code as a persistent systemd service on a Linux server.",
      "",
    ].join("\n"),
  );

  if (conffiles.length > 0) {
    writeFileSync(join(controlDir, "conffiles"), conffiles.map((path) => `${path}\n`).join(""));
  }

  for (const [source, destination] of [
    ["postinstall.sh", "postinst"],
    ["preremove.sh", "prerm"],
    ["postremove.sh", "postrm"],
  ] as const) {
    copyFileSync(join(packagingDir, source), join(controlDir, destination));
    chmodSync(join(controlDir, destination), 0o755);
  }
}

function copyPackagePayload(root: string): void {
  const appDir = join(root, "opt/morecode");
  mkdirSync(dirname(appDir), { recursive: true });
  run("corepack", [
    "pnpm",
    "--filter",
    "t3",
    "deploy",
    "--prod",
    "--legacy",
    "--config.package-import-method=copy",
    appDir,
  ]);
  if (!existsSync(join(appDir, "dist/bin.mjs"))) {
    throw new Error("pnpm deploy did not include the built server runtime.");
  }

  const files: ReadonlyArray<readonly [string, string, number]> = [
    ["morecode", "usr/bin/morecode", 0o755],
    ["morecode.service", "usr/lib/systemd/system/morecode.service", 0o644],
    ["morecode.sysusers", "usr/lib/sysusers.d/morecode.conf", 0o644],
    ["morecode.tmpfiles", "usr/lib/tmpfiles.d/morecode.conf", 0o644],
    ["morecode.env", "etc/morecode/morecode.env", 0o640],
  ];
  for (const [source, destination, mode] of files) {
    const target = join(root, destination);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(packagingDir, source), target);
    chmodSync(target, mode);
  }
  const licenseTarget = join(root, "usr/share/doc/morecode-headless/LICENSE");
  mkdirSync(dirname(licenseTarget), { recursive: true });
  copyFileSync(join(repoRoot, "LICENSE"), licenseTarget);
  chmodSync(licenseTarget, 0o644);

  const copyrightTarget = join(root, "usr/share/doc/morecode-headless/copyright");
  copyFileSync(join(repoRoot, "LICENSE"), copyrightTarget);
  chmodSync(copyrightTarget, 0o644);
}

function buildDeb(
  root: string,
  outputDir: string,
  serverPackage: ServerPackageJson,
  architecture: LinuxPackageArch,
): string {
  writeDebianPackageMetadata(root, serverPackage, architecture, ["/etc/morecode/morecode.env"]);

  const debVersion = toDebVersion(serverPackage.version);
  const output = join(
    outputDir,
    `morecode-headless_${debVersion.upstream}-${debVersion.revision}_${toDebArch(architecture)}.deb`,
  );
  run("dpkg-deb", ["--root-owner-group", "--build", root, output]);
  return output;
}

function buildRpm(
  root: string,
  tempRoot: string,
  outputDir: string,
  serverPackage: ServerPackageJson,
  architecture: LinuxPackageArch,
): string {
  const rpmRoot = join(tempRoot, "rpmbuild");
  const specDir = join(rpmRoot, "SPECS");
  mkdirSync(specDir, { recursive: true });
  const rpmVersion = toRpmVersion(serverPackage.version);
  const specPath = join(specDir, "morecode-headless.spec");
  writeFileSync(
    specPath,
    [
      "Name: morecode-headless",
      `Version: ${rpmVersion.version}`,
      `Release: ${rpmVersion.release}`,
      "Summary: Headless more Code server for coding agents",
      `License: ${serverPackage.license}`,
      `URL: ${serverPackage.repository.url}`,
      `BuildArch: ${toRpmArch(architecture)}`,
      "Requires: nodejs >= 22.16",
      "Requires: git",
      "Requires: systemd",
      "",
      "%description",
      "Run more Code as a persistent systemd service on a Linux server.",
      "",
      "%install",
      `mkdir -p %{buildroot}`,
      `cp -a ${root}/. %{buildroot}/`,
      "",
      "%post",
      ...readPackageScript("postinstall.sh"),
      "",
      "%preun",
      ...readPackageScript("preremove.sh"),
      "",
      "%postun",
      ...readPackageScript("postremove.sh"),
      "",
      "%files",
      "%config(noreplace) /etc/morecode/morecode.env",
      "/opt/morecode",
      "/usr/bin/morecode",
      "/usr/share/doc/morecode-headless/LICENSE",
      "/usr/share/doc/morecode-headless/copyright",
      "/usr/lib/systemd/system/morecode.service",
      "/usr/lib/sysusers.d/morecode.conf",
      "/usr/lib/tmpfiles.d/morecode.conf",
      "",
    ].join("\n"),
  );

  run("rpmbuild", ["--define", `_topdir ${rpmRoot}`, "-bb", specPath]);
  const builtPath = join(
    rpmRoot,
    "RPMS",
    toRpmArch(architecture),
    `morecode-headless-${rpmVersion.version}-${rpmVersion.release}.${toRpmArch(architecture)}.rpm`,
  );
  const output = join(outputDir, builtPath.split("/").at(-1)!);
  renameSync(builtPath, output);
  return output;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      format: { type: "string", default: "deb,rpm" },
      "output-dir": { type: "string", default: "release" },
      "skip-build": { type: "boolean", default: false },
    },
  });
  const formats = values.format
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is PackageFormat => value === "deb" || value === "rpm");
  if (formats.length === 0) throw new Error("Choose at least one package format: deb or rpm.");
  if (process.platform !== "linux") throw new Error("Linux packages must be built on Linux.");

  const architecture = resolveLinuxPackageArch(process.arch);
  if (architecture !== "x64" && architecture !== "arm64") {
    throw new Error(`Unsupported Linux package architecture: ${process.arch}`);
  }
  if (!values["skip-build"])
    run("corepack", ["pnpm", "exec", "vp", "run", "--filter", "t3", "build"]);
  if (
    !existsSync(join(serverDistDir, "bin.mjs")) ||
    !existsSync(join(serverDistDir, "client/index.html"))
  ) {
    throw new Error("Missing server build output. Run the t3 build before packaging.");
  }
  for (const command of formats.map((format) => (format === "deb" ? "dpkg-deb" : "rpmbuild"))) {
    run(command, ["--version"]);
  }

  const outputDir = resolve(repoRoot, values["output-dir"]);
  mkdirSync(outputDir, { recursive: true });
  const tempRoot = mkdtempSync(join(tmpdir(), "morecode-linux-package-"));
  try {
    const serverPackage = readJson<ServerPackageJson>(join(serverDir, "package.json"));
    const payloadRoot = join(tempRoot, "payload");
    copyPackagePayload(payloadRoot);
    const built: string[] = [];
    for (const format of formats) {
      const root = join(tempRoot, `root-${format}`);
      cpSync(payloadRoot, root, { recursive: true });
      built.push(
        format === "deb"
          ? buildDeb(root, outputDir, serverPackage, architecture)
          : buildRpm(root, tempRoot, outputDir, serverPackage, architecture),
      );
    }
    process.stdout.write(`Built Linux packages:\n${built.map((path) => `  ${path}`).join("\n")}\n`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
