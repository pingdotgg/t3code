import { ipcRenderer, nativeImage } from "electron";

ipcRenderer.once("t3:linux-capture", (_event, bytes: Uint8Array) => {
  try {
    const png = Buffer.from(bytes);
    const image = nativeImage.createFromBuffer(png);
    if (image.isEmpty()) throw new Error("The window screenshot is empty.");
    const { width, height } = image.getSize();
    const scale = Math.min(2_560 / width, 1_600 / height, 1);
    const result =
      scale < 1
        ? image
            .resize({
              width: Math.max(1, Math.round(width * scale)),
              height: Math.max(1, Math.round(height * scale)),
              quality: "best",
            })
            .toPNG()
        : png;
    ipcRenderer.send("t3:linux-capture", result);
  } catch (error) {
    ipcRenderer.send(
      "t3:linux-capture",
      error instanceof Error ? error.message : "Window screenshot processing failed.",
    );
  }
});
