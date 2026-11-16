export async function requestMicrophone(
  microphoneId: string,
  signal?: AbortSignal,
): Promise<MediaStream> {
  const constraints = { audio: microphoneId ? { deviceId: { exact: microphoneId } } : true };
  const open = async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      const name = typeof error === "object" && error !== null && "name" in error ? error.name : "";
      if (!microphoneId || (name !== "OverconstrainedError" && name !== "NotFoundError"))
        throw error;
      signal?.throwIfAborted();
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    if (signal?.aborted) {
      stream.getTracks().forEach((track) => track.stop());
      signal.throwIfAborted();
    }
    return stream;
  };
  try {
    return await open();
  } catch (error) {
    const desktop = window.desktopBridge;
    if (
      signal?.aborted ||
      !(error instanceof DOMException) ||
      (error.name !== "NotFoundError" && error.name !== "NotReadableError") ||
      desktop?.getClientPlatform() !== "linux" ||
      !(await desktop.restartAudioService?.().catch(() => false))
    )
      throw error;
    signal?.throwIfAborted();
    return open();
  }
}
