import { expect, it } from "vite-plus/test";

import { zipDownloadTimeLeft } from "./zipTree";

it("says one minute, not one minutes, when a minute of the download is left", () => {
  // Half the bytes in 60 seconds leaves 60 seconds to go.
  expect(zipDownloadTimeLeft({ receivedBytes: 50, totalBytes: 100, elapsedMs: 60_000 })).toBe(
    "About 1 minute left",
  );
  expect(zipDownloadTimeLeft({ receivedBytes: 50, totalBytes: 100, elapsedMs: 61_000 })).toBe(
    "About 2 minutes left",
  );
  expect(zipDownloadTimeLeft({ receivedBytes: 50, totalBytes: 100, elapsedMs: 1_000 })).toBe(
    "About 1 second left",
  );
});
