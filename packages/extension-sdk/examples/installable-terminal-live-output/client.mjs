const manifest = {
  id: "example.terminal-live-output",
  apiVersion: 1,
  version: "1.0.0",
  surfaces: [
    {
      id: "example.terminal-live-output/view",
      title: "Live terminal output",
      scope: "thread",
      placements: ["side-panel"],
      clients: ["web", "desktop"],
      capabilities: [],
      stateVersion: 1,
    },
  ],
};
const encoder = new TextEncoder();
const tail = (value) => {
  const start = Math.max(0, value.length - 8192);
  const splitPair =
    start > 0 && /[\uDC00-\uDFFF]/.test(value[start]) && /[\uD800-\uDBFF]/.test(value[start - 1]);
  return value.slice(start + (splitPair ? 1 : 0));
};

/** A bounded consumer model; incomplete native chunk groups never become displayed output. */
export function createOutputModel(terminalId) {
  let epoch,
    streamId,
    frameSequence = 0,
    nativeSequence = 0,
    pending = null,
    ended = false;
  let display = { contents: "", status: "Connecting…" };
  const invalid = (message) => {
    throw new Error(message);
  };
  return {
    accept(frame) {
      if (ended) invalid("Output arrived after terminal lifecycle ended.");
      if (!Number.isSafeInteger(frame.sequence) || frame.sequence !== frameSequence + 1)
        invalid("Output transport sequence is discontinuous.");
      if (streamId !== undefined && streamId !== frame.streamId)
        invalid("Output transport changed.");
      streamId = frame.streamId;
      frameSequence = frame.sequence;
      const value = frame.value;
      if (value.terminalId !== terminalId) invalid("Output terminal changed.");
      const type = {
        snapshot: "snapshot",
        output: "data",
        reset: "reset",
        exit: "data",
        closed: "closed",
      }[value.kind];
      if (!type || frame.type !== type) invalid("Output lifecycle frame is invalid.");
      if (value.kind === "snapshot") {
        if (epoch !== undefined) invalid("Unexpected replacement snapshot.");
        if (!Number.isSafeInteger(value.boundarySequence) || value.boundarySequence < 0)
          invalid("Output snapshot boundary is invalid.");
        epoch = value.streamEpoch;
        nativeSequence = value.boundarySequence;
        display = {
          contents: tail(value.contents),
          status: value.truncated
            ? "Watching live output. Older retained history was omitted."
            : "Watching live output.",
        };
        if (value.status === "exited" || value.status === "error") {
          ended = true;
          display = { ...display, status: "Terminal is " + value.status + "." };
        }
        return display;
      }
      if (epoch === undefined || value.streamEpoch !== epoch)
        invalid("Output incarnation changed.");
      if (value.kind === "closed") {
        ended = true;
        pending = null;
        display = {
          contents: "",
          status: "Output unavailable: " + value.reason + ". Subscribe again to recover.",
        };
        return display;
      }
      if (!Number.isSafeInteger(value.sequence) || value.sequence <= nativeSequence)
        invalid("Output native sequence moved backwards.");
      if (value.kind === "reset") {
        pending = null;
        nativeSequence = value.sequence;
        display = { contents: "", status: "Terminal history cleared. Watching live output." };
        return display;
      }
      if (value.kind === "exit") {
        if (pending) invalid("Terminal exited with incomplete output.");
        nativeSequence = value.sequence;
        ended = true;
        display = { ...display, status: "Terminal exited (code " + value.exitCode + ")." };
        return display;
      }
      if (
        !Number.isSafeInteger(value.chunkCount) ||
        value.chunkCount < 1 ||
        value.chunkCount > 64 ||
        !Number.isSafeInteger(value.chunkIndex) ||
        value.chunkIndex < 0 ||
        value.chunkIndex >= value.chunkCount ||
        typeof value.data !== "string" ||
        value.data.length > 8192
      )
        invalid("Output chunk exceeds the public contract.");
      if (!pending) {
        if (value.chunkIndex !== 0) invalid("Output starts with an incomplete chunk group.");
        pending = { sequence: value.sequence, count: value.chunkCount, parts: [], bytes: 0 };
      }
      if (
        pending.sequence !== value.sequence ||
        pending.count !== value.chunkCount ||
        pending.parts.length !== value.chunkIndex
      )
        invalid("Output chunk group is discontinuous.");
      pending.bytes += encoder.encode(value.data).byteLength;
      if (pending.bytes > 256 * 1024) invalid("Output event exceeds the consumer bound.");
      pending.parts.push(value.data);
      if (pending.parts.length === pending.count) {
        const text = tail(pending.parts.join(""));
        nativeSequence = value.sequence;
        pending = null;
        display = { contents: tail(display.contents + text), status: "Watching live output." };
      }
      return display;
    },
    finish() {
      if (pending || !ended) invalid("Output ended without a complete terminal lifecycle receipt.");
      return display;
    },
  };
}

export default function createTerminalLiveOutput(host) {
  const { createElement: h, useState, useRef, useEffect } = host.React;
  const control = {
    padding: "6px 10px",
    border: "1px solid currentColor",
    borderRadius: 6,
    background: "transparent",
    color: "inherit",
    font: "inherit",
    minHeight: 36,
  };
  return {
    manifest,
    surfaces: [
      {
        id: manifest.id + "/view",
        validateRestore: (state) => state === null,
        createView(session) {
          return {
            renderer: function TerminalLiveOutput() {
              const [terminalId, setTerminalId] = useState("term-1");
              const [display, setDisplay] = useState({
                contents: "",
                status: "Subscribe to an existing terminal.",
              });
              const pending = useRef(null);
              const output = useRef(null);
              const follow = useRef(true);
              useEffect(() => {
                if (output.current && follow.current)
                  output.current.scrollTop = output.current.scrollHeight;
              }, [display.contents]);
              useEffect(() => () => pending.current?.abort(), []);
              const stop = () => {
                pending.current?.abort();
                pending.current = null;
                setDisplay({ contents: "", status: "Subscription stopped." });
              };
              const subscribe = async (event) => {
                event.preventDefault();
                if (!terminalId) return;
                pending.current?.abort();
                const controller = new AbortController();
                pending.current = controller;
                const signal = AbortSignal.any([controller.signal, session.signal]);
                const model = createOutputModel(terminalId);
                follow.current = true;
                setDisplay({ contents: "", status: "Connecting…" });
                try {
                  for await (const frame of host.subscribeApi(
                    {
                      id: manifest.id + "/events",
                      versionRange: "^1.0.0",
                      name: "subscribe",
                      input: { terminalId },
                      context: session.context,
                    },
                    signal,
                  )) {
                    if (signal.aborted) return;
                    setDisplay(model.accept(frame));
                  }
                  if (!signal.aborted) setDisplay(model.finish());
                } catch (error) {
                  if (!signal.aborted)
                    setDisplay({
                      contents: "",
                      status:
                        error instanceof Error ? error.message : "Terminal output unavailable.",
                    });
                }
              };
              return h(
                "section",
                {
                  "aria-label": "Installed live terminal output",
                  style: {
                    padding: 12,
                    display: "grid",
                    alignContent: "start",
                    gap: 12,
                    minWidth: 0,
                  },
                },
                h(
                  "form",
                  { onSubmit: subscribe, style: { display: "grid", gap: 8 } },
                  h(
                    "label",
                    null,
                    "Terminal ID",
                    h("input", {
                      value: terminalId,
                      maxLength: 128,
                      style: { ...control, width: "100%", boxSizing: "border-box" },
                      onChange: (event) => {
                        stop();
                        setTerminalId(event.target.value);
                      },
                    }),
                  ),
                  h(
                    "div",
                    { style: { display: "flex", gap: 8 } },
                    h(
                      "button",
                      { type: "submit", disabled: !terminalId, style: control },
                      "Subscribe to output",
                    ),
                    h(
                      "button",
                      { type: "button", onClick: stop, style: control },
                      "Stop subscription",
                    ),
                  ),
                ),
                h(
                  "p",
                  { role: "status", style: { margin: 0, overflowWrap: "anywhere" } },
                  display.status,
                ),
                h(
                  "pre",
                  {
                    ref: output,
                    "aria-label": "Live terminal output text",
                    tabIndex: 0,
                    onScroll: (event) => {
                      const node = event.currentTarget;
                      follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
                    },
                    style: {
                      margin: 0,
                      maxHeight: 320,
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                    },
                  },
                  display.contents,
                ),
                h(
                  "small",
                  null,
                  "Read-only live tail. This does not open a terminal or render terminal control sequences.",
                ),
              );
            },
          };
        },
      },
    ],
  };
}
