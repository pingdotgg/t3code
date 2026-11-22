// @effect-diagnostics nodeBuiltinImport:off - Reads optional extra certificate files once at startup of a printer session.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { BAMBU_PRINTER_CERTIFICATE_AUTHORITIES } from "./bambuCertificates.ts";

/**
 * Folder for extra trusted printer certificate authorities, as PEM files. Lets a newer printer
 * whose authority is not bundled yet, or a local development printer, connect without
 * disabling certificate checks.
 */
export function extraPrinterCertificateDirectory(): string {
  const home = process.env.T3CODE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".t3");
  return NodePath.join(home, "printer-certs");
}

function readExtraCertificates(): ReadonlyArray<string> {
  const directory = extraPrinterCertificateDirectory();
  let names: ReadonlyArray<string>;
  try {
    names = NodeFS.readdirSync(directory);
  } catch {
    return [];
  }
  const pems: string[] = [];
  for (const name of names) {
    if (!/\.(pem|crt|cert)$/i.test(name)) continue;
    try {
      const text = NodeFS.readFileSync(NodePath.join(directory, name), "utf8");
      if (text.includes("BEGIN CERTIFICATE")) pems.push(text);
    } catch {
      // Skip unreadable files.
    }
  }
  return pems;
}

/** Bambu's bundled authorities plus any extra ones, read fresh for each new connection. */
export function bambuTrustedCertificates(): ReadonlyArray<string> {
  return [...BAMBU_PRINTER_CERTIFICATE_AUTHORITIES, ...readExtraCertificates()];
}
