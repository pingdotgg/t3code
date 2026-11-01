// @effect-diagnostics nodeBuiltinImport:off -- Fake Electron net request and response emitters.
import * as NodeEvents from "node:events";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

function startRequest() {
  const request = Object.assign(new NodeEvents.EventEmitter(), { abort: vi.fn() });
  const response = new NodeEvents.EventEmitter();
  const reject = vi.fn();
  new ElectronHttpExecutor().addErrorAndTimeoutHandlers(request, reject);
  // Electron's net.ClientRequest emits these as soon as the request body is sent, before any response.
  request.emit("finish");
  request.emit("close");
  return { request, response, reject };
}

describe("ElectronHttpExecutor idle timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts a request that receives no response for 60 seconds", () => {
    const { request, reject } = startRequest();

    vi.advanceTimersByTime(59_999);
    expect(reject).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(request.abort).toHaveBeenCalledOnce();
    expect(reject).toHaveBeenCalledWith(new Error("Request timed out"));
  });

  it("keeps a slow download alive while data keeps arriving", () => {
    const { request, response, reject } = startRequest();
    request.emit("response", response);

    for (let elapsed = 0; elapsed < 180_000; elapsed += 30_000) {
      vi.advanceTimersByTime(30_000);
      response.emit("data", Buffer.alloc(1));
    }

    expect(request.abort).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });

  it("stops the timer once the response ends", () => {
    const { request, response, reject } = startRequest();
    request.emit("response", response);

    response.emit("end");
    vi.advanceTimersByTime(600_000);

    expect(request.abort).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });
});
