import { chunkTerminalWrite } from "@t3tools/contracts";

/** Sends one chunk of terminal input; resolves false when it failed and the rest should drop. */
type SendTerminalChunk = (chunk: string) => Promise<boolean>;

/**
 * Orders one terminal's input into writes that fit `terminal.write`. Input that fits goes out at
 * once, as keystrokes always have. Longer input, such as a large paste, goes one chunk per round
 * trip, and input arriving meanwhile waits behind it so the paste reaches the program whole.
 */
export function createTerminalInputWriter() {
  let pending: Promise<void> | null = null;

  const sendChunks = async (chunks: ReadonlyArray<string>, send: SendTerminalChunk) => {
    for (const chunk of chunks) {
      if (!(await send(chunk))) return;
    }
  };

  return (data: string, send: SendTerminalChunk): Promise<void> => {
    const chunks = chunkTerminalWrite(data);
    if (pending === null && chunks.length === 1) return sendChunks(chunks, send);
    const current: Promise<void> =
      pending === null ? sendChunks(chunks, send) : pending.then(() => sendChunks(chunks, send));
    pending = current;
    void current.then(() => {
      if (pending === current) pending = null;
    });
    return current;
  };
}
