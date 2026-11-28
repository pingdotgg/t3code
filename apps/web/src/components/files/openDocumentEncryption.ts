import { cbc } from "@noble/ciphers/aes.js";
import { sha1 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import type JSZip from "jszip";

import { officeXmlDecoder } from "./officeArchive";
import { find, parseXml } from "./documentPreviewXml";
import { OFFICE_PREVIEW_MAX_BYTES } from "./officePreviewProtocol";
import { PreviewError } from "./previewFailure";

const manifest = "{urn:oasis:names:tc:opendocument:xmlns:manifest:1.0}";
const manifestAlgorithm = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0#";

function unsupported(): never {
  throw new PreviewError({ code: "encryption-unsupported" });
}

function invalid(): never {
  throw new PreviewError({ code: "office-invalid" });
}

function decode(value: string | undefined) {
  if (!value) invalid();
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    invalid();
  }
}

async function inflate(compressed: Uint8Array<ArrayBuffer>, size: number) {
  const stream = new Blob([compressed])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const output = new Uint8Array(size);
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (length + value.length > size) invalid();
      output.set(value, length);
      length += value.length;
    }
    if (length !== size) invalid();
    return output;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

export async function unlockOpenDocument(archive: JSZip, password?: string) {
  const source = await archive.file("META-INF/manifest.xml")?.async("uint8array");
  if (!source?.length) return;
  const xml = parseXml(officeXmlDecoder(source).decode(source));
  const parts = find(xml, manifest + "file-entry").flatMap((entry) => {
    const encryption = find(entry, manifest + "encryption-data")[0];
    if (!encryption) return [];
    const path = entry.attrs[manifest + "full-path"];
    const size = Number(entry.attrs[manifest + "size"]);
    const key = find(encryption, manifest + "key-derivation")[0]?.attrs;
    const algorithm = find(encryption, manifest + "algorithm")[0]?.attrs;
    const start = find(encryption, manifest + "start-key-generation")[0]?.attrs;
    const cipher = algorithm?.[manifest + "algorithm-name"];
    const keyBytes =
      Number(
        /^http:\/\/www\.w3\.org\/2001\/04\/xmlenc#aes(128|192|256)-cbc$/.exec(cipher ?? "")?.[1],
      ) / 8;
    const derivation = key?.[manifest + "key-derivation-name"];
    const startName = start?.[manifest + "start-key-generation-name"];
    const check = encryption.attrs[manifest + "checksum-type"];
    if (
      !key ||
      !algorithm ||
      !Number.isFinite(keyBytes) ||
      (derivation !== "PBKDF2" && derivation !== manifestAlgorithm + "pbkdf2") ||
      (startName &&
        startName !== "SHA1" &&
        startName !== "http://www.w3.org/2000/09/xmldsig#sha1" &&
        startName !== "http://www.w3.org/2000/09/xmldsig#sha256" &&
        startName !== "http://www.w3.org/2001/04/xmlenc#sha256") ||
      (check !== "SHA1/1K" &&
        check !== manifestAlgorithm + "sha1-1k" &&
        check !== manifestAlgorithm + "sha256-1k")
    )
      unsupported();
    const iterations = Number(key[manifest + "iteration-count"]);
    if (!Number.isSafeInteger(iterations) || iterations < 1) invalid();
    if (!path || !Number.isSafeInteger(size) || size < 0) invalid();
    return [
      {
        path,
        size,
        iterations,
        keyBytes,
        iv: decode(algorithm[manifest + "initialisation-vector"]),
        salt: decode(key[manifest + "salt"]),
        expected: decode(encryption.attrs[manifest + "checksum"]),
        startHash: startName?.endsWith("sha256") ? sha256 : sha1,
        checksum: check.endsWith("sha256-1k") ? sha256 : sha1,
      },
    ];
  });
  if (parts.length === 0) return;
  if (parts.some((part) => part.path === "encrypted-package")) unsupported();
  if (password === undefined) throw new PreviewError({ code: "password-required" });
  const total = parts.reduce((sum, part) => sum + part.size, 0);
  const rounds = parts.reduce(
    (sum, part) => sum + part.iterations * Math.ceil(part.keyBytes / 20),
    0,
  );
  if (rounds > 4_000_000 || parts.some((part) => part.iterations > 1_000_000))
    throw new PreviewError({ code: "office-decryption-limit" });
  if (
    total > OFFICE_PREVIEW_MAX_BYTES ||
    parts.some((part) => part.path.toLowerCase().endsWith(".xml") && part.size > 8 * 1024 * 1024)
  )
    throw new PreviewError({ code: "office-too-large-expanded" });
  const utf8 = new TextEncoder().encode(password);
  for (const part of parts) {
    const encrypted = await archive.file(part.path)?.async("uint8array");
    if (
      !encrypted?.length ||
      encrypted.length % 16 !== 0 ||
      part.iv.length !== 16 ||
      part.salt.length > 64
    )
      invalid();
    const key = pbkdf2(sha1, part.startHash(utf8), part.salt, {
      c: part.iterations,
      dkLen: part.keyBytes,
    });
    const padded = new Uint8Array(encrypted.length);
    cbc(key, part.iv, { disablePadding: true }).decrypt(encrypted, padded);
    const padding = padded.at(-1)!;
    const compressed = padded.subarray(0, padded.length - padding);
    const hash = part.checksum(compressed.subarray(0, 1024));
    if (
      padding < 1 ||
      padding > 16 ||
      hash.length !== part.expected.length ||
      hash.some((value, index) => value !== part.expected[index])
    )
      throw new PreviewError({ code: "password-incorrect" });
    archive.file(part.path, await inflate(compressed, part.size), { createFolders: false });
  }
}
