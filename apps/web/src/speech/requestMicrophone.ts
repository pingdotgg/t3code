export async function requestMicrophone(
  microphoneId: string,
  signal?: AbortSignal,
): Promise<MediaStream> {
  const constraints = { audio: microphoneId ? { deviceId: { exact: microphoneId } } : true };
  const open = async () => {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
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
