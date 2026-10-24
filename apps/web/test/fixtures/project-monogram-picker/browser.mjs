// Evaluate in the real app after opening the isolated Monogram evidence project.
(() => {
  globalThis.monogramEvidence?.restore();
  const originalSend = WebSocket.prototype.send;
  const OriginalDate = Date;
  const fixedTime = OriginalDate.parse("2026-10-21T12:00:00Z");
  const observed = new WeakSet();
  const fixture = {
    mode: "pass",
    projectId: null,
    held: [],
    requests: [],
    responses: [],
    release() {
      const pending = this.held.splice(0);
      this.mode = "pass";
      for (const [socket, data] of pending) originalSend.call(socket, data);
    },
    restore() {
      this.release();
      WebSocket.prototype.send = originalSend;
      globalThis.Date = OriginalDate;
    },
    compose(value, commit = false) {
      const input = document.querySelector("#project-monogram");
      if (!input) throw new Error("Open the Monogram picker first.");
      if (!commit) input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(
        new InputEvent("input", { bubbles: true, data: value, isComposing: !commit }),
      );
      if (commit)
        input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: value }));
    },
    environment() {
      return {
        userAgent: navigator.userAgent,
        viewport: [innerWidth, innerHeight],
        dpr: devicePixelRatio,
        fontSize: getComputedStyle(document.documentElement).fontSize,
        theme: document.documentElement.className,
        clock: new Date().toISOString(),
        emulation: "CSS viewport only; desktop user agent; default font scaling",
      };
    },
  };
  globalThis.Date = class extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [fixedTime]));
    }
    static now() {
      return fixedTime;
    }
  };
  WebSocket.prototype.send = function (data) {
    if (typeof data !== "string" || !data.includes('"projects.mutate"')) {
      return originalSend.call(this, data);
    }
    const request = JSON.parse(data);
    const payload = request.payload;
    if (
      request.tag !== "projects.mutate" ||
      payload?.type !== "project.update" ||
      !("projectIcon" in payload)
    ) {
      return originalSend.call(this, data);
    }
    fixture.projectId ??= payload.projectId;
    if (payload.projectId !== fixture.projectId) return originalSend.call(this, data);
    if (!observed.has(this)) {
      observed.add(this);
      this.addEventListener("message", (event) => {
        if (typeof event.data === "string" && event.data.includes('"Exit"'))
          fixture.responses.push(event.data);
      });
    }
    fixture.requests.push({ mode: fixture.mode, data });
    if (fixture.mode === "server-reject" && payload.projectIcon?.kind === "monogram") {
      payload.projectIcon.text = "ABC";
      data = JSON.stringify(request);
    }
    if (fixture.mode === "hold") {
      fixture.held.push([this, data]);
      return;
    }
    if (fixture.mode === "reject") {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            _tag: "Exit",
            requestId: Number(request.id),
            exit: {
              _tag: "Failure",
              cause: [
                {
                  _tag: "Fail",
                  error: {
                    _tag: "ProjectMutationError",
                    commandId: payload.commandId,
                    message: "Connection closed.",
                    cause: { name: "Error", message: "Connection closed." },
                  },
                },
              ],
            },
          }),
        }),
      );
      return;
    }
    return originalSend.call(this, data);
  };
  globalThis.monogramEvidence = fixture;
  return fixture.environment();
})();
