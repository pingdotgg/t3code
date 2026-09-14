let reserved = false;
const listeners = new Set<() => void>();

export const isLiveVoiceMicrophoneReserved = () => reserved;
export function subscribeLiveVoiceMicrophone(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Keeps dictation blocked across navigation until a late permission result is released. */
export function reserveLiveVoiceMicrophone() {
  if (reserved) throw new Error("The microphone is still finishing the previous voice chat.");
  reserved = true;
  listeners.forEach((listener) => listener());
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reserved = false;
    listeners.forEach((listener) => listener());
  };
}
