declare module "pako/lib/zlib/crc32.js" {
  export default function crc32(
    crc: number,
    bytes: Uint8Array,
    length: number,
    offset: number,
  ): number;
}
