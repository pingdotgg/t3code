const { contextBridge, ipcRenderer } = require("electron");

let recording = null;

ipcRenderer.on("phase0:recording-frame", async (_event, dataUrl) => {
  if (!recording) return;
  const response = await fetch(dataUrl);
  const bitmap = await createImageBitmap(await response.blob());
  recording.context.drawImage(bitmap, 0, 0, recording.canvas.width, recording.canvas.height);
  bitmap.close();
});

contextBridge.exposeInMainWorld("phase0", {
  invokeCdp: () => ipcRenderer.invoke("phase0:cdp-evaluate"),
  startRecording: ({ width, height, fps }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    const stream = canvas.captureStream(fps);
    const mimeTypes = [
      "video/mp4;codecs=avc1.42E01E",
      "video/mp4;codecs=h264",
      "video/mp4",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    const mimeType = mimeTypes.find((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!mimeType) throw new Error("No supported WebM MediaRecorder codec");
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_000_000 });
    const chunks = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.start(250);
    recording = { canvas, context, recorder, chunks, mimeType };
    return { mimeType };
  },
  stopRecording: async () => {
    if (!recording) throw new Error("Recording was not started");
    const activeRecording = recording;
    recording = null;
    await new Promise((resolve) => {
      activeRecording.recorder.addEventListener("stop", resolve, { once: true });
      activeRecording.recorder.stop();
    });
    const bytes = new Uint8Array(await new Blob(activeRecording.chunks).arrayBuffer());
    return { mimeType: activeRecording.mimeType, bytes };
  },
});
