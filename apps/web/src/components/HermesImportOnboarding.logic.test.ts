import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";

import {
  describeHermesImportStatus,
  hermesTransportLabel,
  summarizeHermesImportSessions,
} from "./HermesImportOnboarding.logic.ts";

describe("Hermes import onboarding presentation", () => {
  it("summarizes transport and 72-hour settlement classifications", () => {
    expect(
      summarizeHermesImportSessions(
        [
          {
            storedSessionId: "discord-new",
            title: "New",
            preview: "",
            startedAt: 1,
            settlement: "unsettled",
            messageCount: 1,
            source: "discord",
            importedThreadId: null,
          },
          {
            storedSessionId: "telegram-old",
            title: "Old",
            preview: "",
            startedAt: -2 * 24 * 60 * 60,
            settlement: "settled",
            messageCount: 1,
            source: "telegram",
            importedThreadId: null,
          },
          {
            storedSessionId: "discord-old",
            title: "Older",
            preview: "",
            startedAt: 1,
            settlement: "settled",
            messageCount: 1,
            source: "discord",
            importedThreadId: ThreadId.make("thread:existing"),
          },
        ],
        1,
        0,
      ),
    ).toEqual({
      total: 2,
      ready: 1,
      alreadyImported: 1,
      unsettled: 1,
      settled: 0,
      transports: [{ source: "discord", count: 2 }],
    });
  });

  it("uses friendly built-in labels and a readable forward-compatible fallback", () => {
    expect(hermesTransportLabel("telegram")).toBe("Telegram");
    expect(hermesTransportLabel("whatsapp_cloud")).toBe("WhatsApp Cloud");
    expect(hermesTransportLabel("future_transport")).toBe("future transport");
  });

  it("describes ready conversations and their settlement behavior", () => {
    expect(
      describeHermesImportStatus(
        {
          total: 9,
          ready: 7,
          alreadyImported: 2,
          unsettled: 3,
          settled: 4,
          transports: [],
        },
        "30 days",
      ),
    ).toEqual({
      title: "7 conversations ready to import",
      description:
        "3 started in the last 72 hours will remain unsettled; 4 older will start settled.",
    });
  });

  it("describes empty and already-imported selections", () => {
    expect(
      describeHermesImportStatus(
        {
          total: 0,
          ready: 0,
          alreadyImported: 0,
          unsettled: 0,
          settled: 0,
          transports: [],
        },
        "14 days",
      ),
    ).toEqual({
      title: "No matching conversations",
      description: "No conversations started within the last 14 days.",
    });

    expect(
      describeHermesImportStatus(
        {
          total: 1,
          ready: 0,
          alreadyImported: 1,
          unsettled: 0,
          settled: 0,
          transports: [{ source: "telegram", count: 1 }],
        },
        "14 days",
      ),
    ).toEqual({
      title: "Hermes is up to date",
      description: "All 1 matching conversation is already in T3 Work.",
    });
  });
});
