import { expect, it } from "vite-plus/test";

import { zipDownloadTimeLeft } from "./zipTree";

const timeLeft = (seconds: number) =>
  zipDownloadTimeLeft({ receivedBytes: 1, totalBytes: 2, elapsedMs: seconds * 1000 });

it("uses singular units when one minute or one second is left", () => {
  expect(timeLeft(1)).toBe("About 1 second left");
  expect(timeLeft(60)).toBe("About 1 minute left");
  expect(timeLeft(61)).toBe("About 2 minutes left");
});
