// libghostty-vt has no clipboard callback, so OSC 52 writes are framed here,
// alongside the bytes Ghostty parses. Reads (`?`) are never answered: replying
// would send this client's clipboard to whatever process asked for it.

// Base64 characters, about 768 KiB of copied text. Longer sequences are dropped
// instead of buffered so a broken stream cannot grow memory without bound.
const MAX_OSC52_PAYLOAD_LENGTH = 1024 * 1024;

const PREFIX = "52;";
// BEL ends the OSC, ESC may start ST, CAN and SUB abort it.
// oxlint-disable-next-line no-control-regex -- matching VT control bytes is the point.
const OSC_CONTROL = /[\x07\x18\x1a\x1b]/g;
// The browser has one clipboard, so the system and both X11 selections map to it.
const SELECTION = /^[cps0-7]*$/;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeClipboardWrite(body: string): string | null {
  const separator = body.indexOf(";", PREFIX.length);
  if (separator === -1) return null;
  const selection = body.slice(PREFIX.length, separator);
  if (!SELECTION.test(selection) || (selection !== "" && !/[cps]/.test(selection))) return null;
  const encoded = body.slice(separator + 1);
  if (encoded === "" || encoded === "?") return null;
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const text = decoder.decode(bytes);
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export class Osc52Scanner {
  private state: "ground" | "escape" | "osc" | "oscEscape" = "ground";
  // The OSC body so far, or null once it can no longer be a clipboard write.
  private body: string | null = null;
  private readonly onCopy: (text: string) => void;

  constructor(onCopy: (text: string) => void) {
    this.onCopy = onCopy;
  }

  reset(): void {
    this.state = "ground";
    this.body = null;
  }

  write(data: string): void {
    let index = 0;
    while (index < data.length) {
      switch (this.state) {
        case "ground": {
          const escape = data.indexOf("\x1b", index);
          if (escape === -1) return;
          this.state = "escape";
          index = escape + 1;
          break;
        }
        case "escape": {
          const char = data[index];
          index += 1;
          if (char === "]") {
            this.state = "osc";
            this.body = "";
          } else if (char !== "\x1b") {
            this.state = "ground";
          }
          break;
        }
        case "osc": {
          OSC_CONTROL.lastIndex = index;
          const control = OSC_CONTROL.exec(data);
          const end = control?.index ?? data.length;
          this.append(data.slice(index, end));
          if (!control) return;
          index = end + 1;
          if (control[0] === "\x07") this.finish();
          else if (control[0] === "\x1b") this.state = "oscEscape";
          else this.reset();
          break;
        }
        case "oscEscape": {
          if (data[index] === "\\") {
            index += 1;
            this.finish();
          } else {
            // Any other escape aborts the OSC and begins a new sequence.
            this.state = "escape";
            this.body = null;
          }
          break;
        }
      }
    }
  }

  private append(text: string): void {
    if (this.body === null || text.length === 0) return;
    if (this.body.length + text.length > MAX_OSC52_PAYLOAD_LENGTH) {
      this.body = null;
      return;
    }
    const checkPrefix = this.body.length < PREFIX.length;
    this.body += text;
    if (checkPrefix && !PREFIX.startsWith(this.body.slice(0, PREFIX.length))) this.body = null;
  }

  private finish(): void {
    const body = this.body;
    this.reset();
    const text = body === null ? null : decodeClipboardWrite(body);
    if (text !== null) this.onCopy(text);
  }
}
