import { cbc, ecb } from "@noble/ciphers/aes.js";
import { sha1 } from "@noble/hashes/legacy.js";
import { sha256, sha384, sha512 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { SaxesParser } from "saxes";

import { readOfficeEncryptedStreams } from "./officeEncryptedStreams";
import { PreviewError } from "./previewFailure";

const CBC = { disablePadding: true };
const ENCRYPTION_NS = "http://schemas.microsoft.com/office/2006/encryption";
const PASSWORD_NS = "http://schemas.microsoft.com/office/2006/keyEncryptor/password";
const AGILE_HASHES = { SHA1: sha1, SHA256: sha256, SHA384: sha384, SHA512: sha512 };
type Hash = typeof sha256;

function invalid(): never {
  throw new PreviewError({ code: "office-invalid" });
}

function unsupported(): never {
  throw new PreviewError({ code: "encryption-unsupported" });
}

function wrongPassword(): never {
  throw new PreviewError({ code: "password-incorrect" });
}

function uint32(number: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, number, true);
  return bytes;
}

function equal(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!;
  return difference === 0;
}

function pad(bytes: Uint8Array, length: number) {
  const output = new Uint8Array(length).fill(0x36);
  output.set(bytes.subarray(0, length));
  return output;
}

function passwordHash(hash: Hash, salt: Uint8Array, password: string, spins: number) {
  const utf16 = new Uint8Array(password.length * 2);
  const view = new DataView(utf16.buffer);
  for (let i = 0; i < password.length; i++) view.setUint16(i * 2, password.charCodeAt(i), true);
  const block = new Uint8Array(4 + hash.outputLen);
  const counter = new DataView(block.buffer);
  block.set(hash(concatBytes(salt, utf16)), 4);
  for (let i = 0; i < spins; i++) {
    counter.setUint32(0, i, true);
    block.set(hash(block), 4);
  }
  return block.subarray(4);
}

function base64(value: string | undefined) {
  if (!value) invalid();
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    invalid();
  }
}

function agileParameters(attrs: Record<string, string>) {
  const algorithm = attrs.hashAlgorithm as keyof typeof AGILE_HASHES;
  if (!Object.hasOwn(AGILE_HASHES, algorithm)) unsupported();
  const hash = AGILE_HASHES[algorithm];
  const keyBytes = Number(attrs.keyBits) / 8;
  if (
    attrs.cipherAlgorithm !== "AES" ||
    attrs.cipherChaining !== "ChainingModeCBC" ||
    Number(attrs.blockSize) !== 16 ||
    ![16, 24, 32].includes(keyBytes)
  )
    unsupported();
  const salt = base64(attrs.saltValue);
  if (salt.length !== Number(attrs.saltSize) || salt.length > 64 || salt.length === 0) invalid();
  return { hash, keyBytes, salt };
}

function agileDecrypt(info: Uint8Array, pkg: Uint8Array, size: number, password?: string) {
  let data: Record<string, string> | undefined;
  let key: Record<string, string> | undefined;
  let integrity: Record<string, string> | undefined;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", invalid);
  parser.on("error", invalid);
  parser.on("opentag", (tag) => {
    if (tag.uri === ENCRYPTION_NS && tag.local === "keyData")
      data = Object.fromEntries(
        Object.values(tag.attributes).map((attr) => [attr.local, attr.value]),
      );
    if (tag.uri === PASSWORD_NS && tag.local === "encryptedKey")
      key = Object.fromEntries(
        Object.values(tag.attributes).map((attr) => [attr.local, attr.value]),
      );
    if (tag.uri === ENCRYPTION_NS && tag.local === "dataIntegrity")
      integrity = Object.fromEntries(
        Object.values(tag.attributes).map((attr) => [attr.local, attr.value]),
      );
  });
  parser.write(new TextDecoder().decode(info.subarray(8))).close();
  if (!data) invalid();
  if (!key) unsupported();
  const dataParams = agileParameters(data);
  const keyParams = agileParameters(key);
  const spins = Number(key.spinCount);
  if (!Number.isSafeInteger(spins) || spins < 0 || spins > 1_000_000) unsupported();
  if (password === undefined) throw new PreviewError({ code: "password-required" });

  const secret = passwordHash(keyParams.hash, keyParams.salt, password, spins);
  const decryptKeyValue = (value: string | undefined, block: number[]) => {
    const aesKey = pad(
      keyParams.hash(concatBytes(secret, new Uint8Array(block))),
      keyParams.keyBytes,
    );
    return cbc(aesKey, pad(keyParams.salt, 16), CBC).decrypt(base64(value));
  };
  const verifier = decryptKeyValue(
    key.encryptedVerifierHashInput,
    [0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79],
  );
  const expected = decryptKeyValue(
    key.encryptedVerifierHashValue,
    [0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e],
  );
  const actual = keyParams.hash(verifier.subarray(0, keyParams.salt.length));
  if (!equal(actual, expected.subarray(0, actual.length))) wrongPassword();

  const dataKey = decryptKeyValue(
    key.encryptedKeyValue,
    [0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6],
  ).subarray(0, dataParams.keyBytes);
  const decrypt = (block: Uint8Array, value: Uint8Array) =>
    cbc(dataKey, pad(dataParams.hash(concatBytes(dataParams.salt, block)), 16), CBC).decrypt(value);
  if (integrity) {
    const digestSize = dataParams.hash.outputLen;
    const hmacKey = decrypt(
      new Uint8Array([0x5f, 0xb2, 0xad, 0x01, 0x0c, 0xb9, 0xe1, 0xf6]),
      base64(integrity.encryptedHmacKey),
    );
    const digest = decrypt(
      new Uint8Array([0xa0, 0x67, 0x7f, 0x02, 0xb2, 0x2c, 0x84, 0x33]),
      base64(integrity.encryptedHmacValue),
    );
    if (
      !equal(
        hmac(dataParams.hash, hmacKey.subarray(0, digestSize), pkg),
        digest.subarray(0, digestSize),
      )
    )
      invalid();
  }
  const output = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 4096) {
    const length = Math.min(size - offset, 4096);
    const chunk = decrypt(
      uint32(offset / 4096),
      pkg.subarray(8 + offset, 8 + offset + Math.ceil(length / 16) * 16),
    );
    output.set(chunk.subarray(0, length), offset);
  }
  return output.buffer;
}

function standardDecrypt(info: Uint8Array, pkg: Uint8Array, size: number, password?: string) {
  if (info.length < 44) invalid();
  const view = new DataView(info.buffer, info.byteOffset, info.byteLength);
  const verifierOffset = 12 + view.getUint32(8, true);
  const keyBits = view.getUint32(28, true);
  const algorithm = view.getUint32(20, true);
  if (
    ![128, 192, 256].includes(keyBits) ||
    algorithm !== 0x660e + (keyBits - 128) / 64 ||
    view.getUint32(24, true) !== 0x8004
  )
    unsupported();
  if (
    verifierOffset < 44 ||
    verifierOffset + 72 > info.length ||
    view.getUint32(verifierOffset, true) !== 16 ||
    view.getUint32(verifierOffset + 36, true) !== 20
  )
    invalid();
  if (password === undefined) throw new PreviewError({ code: "password-required" });
  const salt = info.subarray(verifierOffset + 4, verifierOffset + 20);
  const secret = passwordHash(sha1, salt, password, 50_000);
  const hash = sha1(concatBytes(secret, uint32(0)));
  const key = concatBytes(
    ...[0x36, 0x5c].map((byte) => {
      const block = new Uint8Array(64).fill(byte);
      hash.forEach((value, i) => {
        block[i] = value ^ byte;
      });
      return sha1(block);
    }),
  ).subarray(0, keyBits / 8);
  const verifier = ecb(key, CBC).decrypt(info.subarray(verifierOffset + 20, verifierOffset + 36));
  const digest = ecb(key, CBC).decrypt(info.subarray(verifierOffset + 40, verifierOffset + 72));
  if (!equal(sha1(verifier), digest.subarray(0, 20))) wrongPassword();
  return ecb(key, CBC).decrypt(pkg.subarray(8)).slice(0, size).buffer;
}

export function decryptOffice(bytes: ArrayBuffer, password?: string) {
  const { info, package: pkg } = readOfficeEncryptedStreams(bytes);
  const size = Number(new DataView(pkg.buffer, pkg.byteOffset).getBigUint64(0, true));
  if (size < 22 || Math.ceil(size / 16) * 16 !== pkg.length - 8) invalid();
  const header = new DataView(info.buffer, info.byteOffset);
  const major = header.getUint16(0, true);
  const minor = header.getUint16(2, true);
  if (major === 4 && minor === 4) return agileDecrypt(info, pkg, size, password);
  if ((major === 2 || major === 3 || major === 4) && minor === 2)
    return standardDecrypt(info, pkg, size, password);
  unsupported();
}
