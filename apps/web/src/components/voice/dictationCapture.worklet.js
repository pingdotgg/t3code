/* global AudioWorkletProcessor, registerProcessor */
// The port is dedicated to this recorder; window targetOrigin does not apply.
/* oxlint-disable unicorn/require-post-message-target-origin */
class DictationCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = [];
    this.recording = true;
    this.port.addEventListener("message", ({ data }) => {
      if (data !== "stop") return;
      this.recording = false;
      this.flush();
      this.port.postMessage("stopped");
    });
    this.port.start();
  }
  flush() {
    if (!this.samples.length) return;
    const samples = Float32Array.from(this.samples);
    this.port.postMessage(samples, [samples.buffer]);
    this.samples = [];
  }
  process(inputs) {
    if (this.recording && inputs[0]?.[0]) {
      this.samples.push(...inputs[0][0]);
      if (this.samples.length >= 2048) this.flush();
    }
    return true;
  }
}
registerProcessor("t3-dictation-capture", DictationCapture);
