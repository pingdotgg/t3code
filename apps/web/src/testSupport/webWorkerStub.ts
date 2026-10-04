/**
 * Inert stand-in for a Vite `?worker` module.
 *
 * Vitest evaluates modules in Node, where Vite's `?worker` transform does not
 * run, so the real worker bundle is loaded as an ordinary module and its
 * `self` references throw `ReferenceError: self is not defined` while the
 * importing test file is still being collected. Aliasing every `?worker`
 * specifier to this module keeps such imports inert under test; see the
 * `test.alias` entry in the repository `vite.config.ts`.
 *
 * The stub deliberately does no work. A unit test that genuinely needs diff
 * rendering across the worker boundary has to assert observable behavior
 * through the pool, not through a real worker.
 */
export class WebWorkerStub extends EventTarget implements Worker {
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onerror: ((event: ErrorEvent) => unknown) | null = null;
  onmessageerror: ((event: MessageEvent) => unknown) | null = null;

  postMessage(_message: unknown, transfer: Transferable[]): void;
  postMessage(_message: unknown, options?: StructuredSerializeOptions): void;
  postMessage(): void {
    // No counterpart to answer, so queued work is dropped instead of failing.
  }

  terminate(): void {
    // Nothing was ever started.
  }
}

export default WebWorkerStub;
