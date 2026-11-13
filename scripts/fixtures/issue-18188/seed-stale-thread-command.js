/**
 * Run in the isolated dev client's browser with preview_evaluate.
 * Seed only IndexedDB; authoritative server state remains unchanged.
 * Await completion, then reload before exercising Stop.
 */
globalThis.seedStaleThreadCommand = async function ({ environmentId, threadId, itemId }) {
  const response = await fetch(`/api/orchestration/threads/${threadId}`, {
    headers: { "x-t3-orchestration-protocol": "2" },
  });
  if (!response.ok) throw new Error(`Thread fetch failed: ${response.status}`);
  const full = await response.json();
  const authoritative = full.projection.turnItems.find((item) => item.id === itemId);
  const visible = full.projection.visibleTurnItems.find((row) => row.item.id === itemId);
  if (
    authoritative?.type !== "command_execution" ||
    authoritative.status !== "completed" ||
    !visible
  ) {
    throw new Error("Choose an authoritative completed command with a visible row");
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("t3code:connection-runtime", 4);
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("success", () => {
      const db = request.result;
      const transaction = db.transaction("thread", "readwrite");
      const store = transaction.objectStore("thread");
      const key = `${environmentId}:${threadId}`;
      const read = store.get(key);
      let assertion;
      transaction.addEventListener("error", () => reject(transaction.error));
      transaction.addEventListener("abort", () =>
        reject(transaction.error ?? new Error("Seed aborted")),
      );
      transaction.addEventListener("complete", () => {
        db.close();
        resolve(assertion);
      });
      read.addEventListener("success", () => {
        if (!read.result) {
          transaction.abort();
          return;
        }
        const saved = JSON.parse(read.result);
        const snapshot = saved.snapshot;
        const projection = snapshot.projection;
        const stale = { ...authoritative, status: "running", completedAt: null };
        assertion = {
          authoritativeStatus: authoritative.status,
          omittedBeforeSeed: !projection.turnItems.some((item) => item.id === itemId),
          originalCount: projection.turnItems.length,
          snapshotSequence: snapshot.snapshotSequence,
          historyCursor: snapshot.historyCursor,
          hasMoreHistory: snapshot.hasMoreHistory,
        };
        projection.turnItems = [
          stale,
          ...projection.turnItems.filter((item) => item.id !== itemId),
        ];
        projection.visibleTurnItems = [
          { ...visible, item: stale },
          ...projection.visibleTurnItems.filter((row) => row.item.id !== itemId),
        ];
        store.put(JSON.stringify(saved), key);
      });
    });
  });
};
