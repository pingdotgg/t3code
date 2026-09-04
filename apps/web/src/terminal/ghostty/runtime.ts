import ghosttyWasmUrl from "./vendor/ghostty-vt.wasm?url";
import ghosttyWritePtyWasmUrl from "./vendor/ghostty-write-pty.wasm?url&no-inline";

type WasmFunction = (...args: Array<number | bigint>) => number;

interface TypeField {
  readonly offset: number;
  readonly size: number;
  readonly type: string;
}

interface TypeLayout {
  readonly size: number;
  readonly align: number;
  readonly fields: Readonly<Record<string, TypeField>>;
}

type TypeLayouts = Readonly<Record<string, TypeLayout>>;

const textDecoder = new TextDecoder();

export class GhosttyRuntime {
  readonly memory: WebAssembly.Memory;
  readonly layouts: TypeLayouts;
  private readonly exports: WebAssembly.Exports;
  private memoryView: DataView;
  private readonly ptyWriters = new Map<number, (data: string) => void>();
  private nextPtyWriterId = 1;
  private writePtyFunctionIndex = 0;

  private constructor(instance: WebAssembly.Instance) {
    this.exports = instance.exports;
    const memory = instance.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) {
      throw new Error("libghostty-vt did not export WebAssembly memory");
    }
    this.memory = memory;
    this.memoryView = new DataView(memory.buffer);
    const jsonPointer = this.call("ghostty_type_json");
    const bytes = new Uint8Array(memory.buffer);
    let end = jsonPointer;
    while (end < bytes.length && bytes[end] !== 0) end += 1;
    this.layouts = JSON.parse(textDecoder.decode(bytes.subarray(jsonPointer, end))) as TypeLayouts;
  }

  static async load(): Promise<GhosttyRuntime> {
    const response = await fetch(ghosttyWasmUrl);
    if (!response.ok) {
      throw new Error(`Unable to load libghostty-vt (${response.status})`);
    }
    let instance: WebAssembly.Instance | undefined;
    const imports = {
      env: {
        log: (pointer: number, length: number) => {
          if (!instance) return;
          const memory = instance.exports.memory;
          if (!(memory instanceof WebAssembly.Memory)) return;
          const message = textDecoder.decode(new Uint8Array(memory.buffer, pointer, length));
          console.debug("[libghostty-vt]", message);
        },
      },
    };
    const result = await WebAssembly.instantiate(await response.arrayBuffer(), imports);
    instance = result.instance;
    const runtime = new GhosttyRuntime(result.instance);
    await runtime.installWritePtyTrampoline();
    return runtime;
  }

  call(name: string, ...args: Array<number | bigint>): number {
    const fn = this.exports[name];
    if (typeof fn !== "function") {
      throw new Error(`libghostty-vt export is unavailable: ${name}`);
    }
    return (fn as WasmFunction)(...args);
  }

  layout(name: string): TypeLayout {
    const layout = this.layouts[name];
    if (!layout) throw new Error(`libghostty-vt type layout is unavailable: ${name}`);
    return layout;
  }

  alloc(size: number): number {
    const pointer = this.call("ghostty_wasm_alloc_u8_array", size);
    if (pointer === 0) throw new Error(`libghostty-vt failed to allocate ${size} bytes`);
    new Uint8Array(this.memory.buffer, pointer, size).fill(0);
    return pointer;
  }

  free(pointer: number, size: number): void {
    if (pointer !== 0) this.call("ghostty_wasm_free_u8_array", pointer, size);
  }

  allocOpaque(): number {
    const pointer = this.call("ghostty_wasm_alloc_opaque");
    if (pointer === 0) throw new Error("libghostty-vt failed to allocate an opaque pointer");
    // The slot is uninitialized until a *_new call writes it; zero it so dispose
    // paths that run after a partial initialization never free a garbage pointer.
    new DataView(this.memory.buffer).setUint32(pointer, 0, true);
    return pointer;
  }

  freeOpaque(pointer: number): void {
    if (pointer !== 0) this.call("ghostty_wasm_free_opaque", pointer);
  }

  readPointer(slot: number): number {
    return this.currentMemoryView().getUint32(slot, true);
  }

  attachPtyWriter(terminal: number, writer: (data: string) => void): number {
    if (this.writePtyFunctionIndex === 0) {
      throw new Error("libghostty-vt PTY callback trampoline is unavailable");
    }
    const id = this.nextPtyWriterId++;
    this.ptyWriters.set(id, writer);
    this.call("ghostty_terminal_set", terminal, 0, id);
    this.call("ghostty_terminal_set", terminal, 1, this.writePtyFunctionIndex);
    return id;
  }

  detachPtyWriter(terminal: number, id: number): void {
    this.call("ghostty_terminal_set", terminal, 1, 0);
    this.call("ghostty_terminal_set", terminal, 0, 0);
    this.ptyWriters.delete(id);
  }

  view(pointer: number, size?: number): DataView {
    return new DataView(this.memory.buffer, pointer, size);
  }

  bytes(pointer: number, size: number): Uint8Array {
    return new Uint8Array(this.memory.buffer, pointer, size);
  }

  /** Reuse scalar reads across cells, refreshing after any terminal grows shared WASM memory. */
  private currentMemoryView(): DataView {
    if (this.memoryView.buffer !== this.memory.buffer) {
      this.memoryView = new DataView(this.memory.buffer);
    }
    return this.memoryView;
  }

  setField(pointer: number, structName: string, fieldName: string, value: number): void {
    const field = this.layout(structName).fields[fieldName];
    if (!field) throw new Error(`libghostty-vt field is unavailable: ${structName}.${fieldName}`);
    const view = this.currentMemoryView();
    const offset = pointer + field.offset;
    switch (field.type) {
      case "bool":
      case "u8":
        view.setUint8(offset, value);
        return;
      case "u16":
        view.setUint16(offset, value, true);
        return;
      case "i32":
        view.setInt32(offset, value, true);
        return;
      case "u32":
      case "enum":
        view.setUint32(offset, value, true);
        return;
      case "u64":
        view.setBigUint64(offset, BigInt(value), true);
        return;
      default:
        throw new Error(`Unsupported libghostty-vt field type: ${field.type}`);
    }
  }

  readField(pointer: number, structName: string, fieldName: string): number {
    const field = this.layout(structName).fields[fieldName];
    if (!field) throw new Error(`libghostty-vt field is unavailable: ${structName}.${fieldName}`);
    const view = this.currentMemoryView();
    const offset = pointer + field.offset;
    switch (field.type) {
      case "bool":
      case "u8":
        return view.getUint8(offset);
      case "u16":
        return view.getUint16(offset, true);
      case "i32":
        return view.getInt32(offset, true);
      case "u32":
      case "enum":
        return view.getUint32(offset, true);
      case "u64":
        return Number(view.getBigUint64(offset, true));
      default:
        throw new Error(`Unsupported libghostty-vt field type: ${field.type}`);
    }
  }

  private async installWritePtyTrampoline(): Promise<void> {
    const response = await fetch(ghosttyWritePtyWasmUrl);
    if (!response.ok) {
      throw new Error(`Unable to load the libghostty-vt PTY trampoline (${response.status})`);
    }
    const result = await WebAssembly.instantiate(await response.arrayBuffer(), {
      env: {
        t3_write_pty: (_terminal: number, userdata: number, pointer: number, length: number) => {
          const writer = this.ptyWriters.get(userdata);
          if (!writer || length === 0) return;
          writer(textDecoder.decode(new Uint8Array(this.memory.buffer, pointer, length)));
        },
      },
    });
    const trampoline = result.instance.exports.ghostty_write_pty;
    const table = this.exports.__indirect_function_table;
    if (typeof trampoline !== "function" || !(table instanceof WebAssembly.Table)) {
      throw new Error("libghostty-vt did not expose its callback table");
    }
    const index = table.length;
    // grow-then-set instead of grow(1, fn): WebKit stores a grow init value
    // with broken type information and every later call_indirect through the
    // entry traps with a signature mismatch. table.set canonicalizes correctly.
    table.grow(1);
    table.set(index, trampoline);
    this.writePtyFunctionIndex = index;
  }
}

let runtimePromise: Promise<GhosttyRuntime> | null = null;

export function loadGhosttyRuntime(): Promise<GhosttyRuntime> {
  runtimePromise ??= GhosttyRuntime.load().catch((error) => {
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}
