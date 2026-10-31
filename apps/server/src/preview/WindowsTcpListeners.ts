import * as NodeModule from "node:module";

import { fileBasename } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class WindowsTcpProbeError extends Schema.TaggedError<WindowsTcpProbeError>()(
  "WindowsTcpProbeError",
  { operation: Schema.Literals(["load", "listeners", "process-name"]), cause: Schema.Defect() },
) {}

/** Native Windows listener rows retain every owner until PortDiscovery resolves ownership. */
export class WindowsTcpListeners extends Context.Service<
  WindowsTcpListeners,
  {
    readonly scan: Effect.Effect<
      ReadonlyArray<{ readonly port: number; readonly pid: number | null }>,
      WindowsTcpProbeError
    >;
    readonly processName: (pid: number) => Effect.Effect<string | null, WindowsTcpProbeError>;
  }
>()("t3/preview/WindowsTcpListeners") {}

const loadApi = () => {
  const { DataType, load, open }: typeof import("ffi-rs") = NodeModule.createRequire(
    import.meta.url,
  )("ffi-rs");
  const iphlpapi = "t3-preview-iphlpapi";
  const kernel32 = "t3-preview-kernel32";
  open({ library: iphlpapi, path: "iphlpapi.dll" });
  open({ library: kernel32, path: "kernel32.dll" });

  const table = (family: 2 | 23) => {
    const size = Buffer.alloc(4);
    let buffer = Buffer.alloc(4);
    // The TCP table can grow between calls. Bound both retry work and allocation.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      size.writeUInt32LE(buffer.length);
      const status = load({
        library: iphlpapi,
        funcName: "GetExtendedTcpTable",
        retType: DataType.U32,
        paramsType: [
          DataType.U8Array,
          DataType.U8Array,
          DataType.I32,
          DataType.U32,
          DataType.I32,
          DataType.U32,
        ],
        paramsValue: [buffer, size, 1, family, 3, 0],
      });
      if (status === 122) {
        const required = size.readUInt32LE();
        if (required < 4 || required > 16 * 1024 * 1024) throw new Error("Invalid TCP table size");
        buffer = Buffer.alloc(required);
        continue;
      }
      if (status !== 0) throw new Error(`GetExtendedTcpTable failed (${status})`);
      // Windows DWORD fields have four-byte alignment on x86, x64, and ARM64.
      const stride = family === 2 ? 24 : 56;
      const count = buffer.readUInt32LE();
      if (count > Math.floor((buffer.length - 4) / stride)) throw new Error("Truncated TCP table");
      const rows: Array<{ port: number; pid: number | null }> = [];
      for (let index = 0; index < count; index += 1) {
        const offset = 4 + index * stride;
        const addressOffset = offset + (family === 2 ? 4 : 0);
        const address = buffer.subarray(addressOffset, addressOffset + (family === 2 ? 4 : 16));
        const wildcard = address.every((byte) => byte === 0);
        const loopback =
          family === 2
            ? address.equals(Buffer.from([127, 0, 0, 1]))
            : address.subarray(0, 15).every((byte) => byte === 0) && address[15] === 1;
        if (!wildcard && !loopback) continue;
        const port = buffer.readUInt16BE(offset + (family === 2 ? 8 : 20));
        if (port === 0) continue;
        const pid = buffer.readUInt32LE(offset + (family === 2 ? 20 : 52));
        rows.push({ port, pid: pid > 0 ? pid : null });
      }
      return rows;
    }
    throw new Error("TCP table kept growing");
  };

  return {
    scan: () => [...table(2), ...table(23)],
    processName: (pid: number) => {
      const handle = load({
        library: kernel32,
        funcName: "OpenProcess",
        retType: DataType.BigInt,
        paramsType: [DataType.U32, DataType.I32, DataType.U32],
        paramsValue: [0x1000, 0, pid],
      });
      if (handle.valueOf() === 0n) return null;
      try {
        const buffer = Buffer.alloc(32_768 * 2);
        const size = Buffer.alloc(4);
        size.writeUInt32LE(buffer.length / 2);
        const ok = load({
          library: kernel32,
          funcName: "QueryFullProcessImageNameW",
          retType: DataType.I32,
          paramsType: [DataType.BigInt, DataType.U32, DataType.U8Array, DataType.U8Array],
          paramsValue: [handle, 0, buffer, size],
        });
        if (!ok) return null;
        const length = size.readUInt32LE();
        if (length > buffer.length / 2) throw new Error("Invalid process image length");
        const imagePath = buffer.toString("utf16le", 0, length * 2);
        return fileBasename(imagePath).replace(/\.exe$/i, "") || null;
      } finally {
        load({
          library: kernel32,
          funcName: "CloseHandle",
          retType: DataType.I32,
          paramsType: [DataType.BigInt],
          paramsValue: [handle],
        });
      }
    },
  };
};

const make = Effect.gen(function* () {
  // Keep native loading out of non-Windows imports and idle preview scans.
  const api = yield* Effect.cached(
    Effect.try({
      try: loadApi,
      catch: (cause) => new WindowsTcpProbeError({ operation: "load", cause }),
    }),
  );
  return WindowsTcpListeners.of({
    scan: Effect.flatMap(api, (native) =>
      Effect.try({
        try: native.scan,
        catch: (cause) => new WindowsTcpProbeError({ operation: "listeners", cause }),
      }),
    ),
    processName: Effect.fn("WindowsTcpListeners.processName")((pid: number) =>
      Effect.flatMap(api, (native) =>
        Effect.try({
          try: () => native.processName(pid),
          catch: (cause) => new WindowsTcpProbeError({ operation: "process-name", cause }),
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(WindowsTcpListeners, make);
