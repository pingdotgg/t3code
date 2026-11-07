// Minimal XMLHttpRequest over fetch so the PKJS modules run unchanged under bun test.
export class XhrShim {
  status = 0;
  responseText = "";
  response: unknown = null;
  responseType = "";
  timeout = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  private method = "GET";
  private url = "";
  private sent: Record<string, string> = {};
  private received = new Headers();

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
    this.status = 0;
  }

  setRequestHeader(name: string, value: string) {
    this.sent[name] = value;
  }

  getResponseHeader(name: string) {
    return this.received.get(name);
  }

  send(body?: string | null) {
    fetch(this.url, { method: this.method, headers: this.sent, body })
      .then(async (response) => {
        this.received = response.headers;
        this.status = response.status;
        if (this.responseType === "arraybuffer") {
          this.response = await response.arrayBuffer();
        } else {
          this.responseText = await response.text();
        }
        this.onload?.();
      })
      .catch(() => this.onerror?.());
  }
}

export function installXhr() {
  const original = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = XhrShim;
  return () => {
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = original;
  };
}

export function installStorage(values: Record<string, string> = {}) {
  const original = (globalThis as { localStorage?: unknown }).localStorage;
  const data: Record<string, string> = { ...values };
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
    removeItem: (key: string) => {
      delete data[key];
    },
  };
  return {
    data,
    restore: () => {
      (globalThis as { localStorage?: unknown }).localStorage = original;
    },
  };
}
