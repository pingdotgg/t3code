import { describe, expect, it } from "vite-plus/test";

import {
  parseMacVoices,
  parseSpeechDispatcherVoices,
  parseWindowsVoices,
  speakCommand,
} from "./readAloudCore.ts";

describe("parseSpeechDispatcherVoices", () => {
  it("reads right-aligned columns, keeping names with spaces", () => {
    const output = [
      "                     NAME                 LANGUAGE                  VARIANT",
      "                 samantha                    en-US                     none",
      " English (America)+Adam                   en-US                     Adam",
      "English (Caribbean)+Alex                   en-029                     Alex",
      "                Afrikaans                       af                     none",
    ].join("\n");
    expect(parseSpeechDispatcherVoices("espeak-ng", output)).toEqual([
      { id: "espeak-ng:samantha", name: "samantha", language: "en-US", module: "espeak-ng" },
      {
        id: "espeak-ng:English (America)+Adam",
        name: "English (America)+Adam",
        language: "en-US",
        module: "espeak-ng",
      },
      { id: "espeak-ng:Afrikaans", name: "Afrikaans", language: "af", module: "espeak-ng" },
    ]);
  });
});

describe("other engines", () => {
  it("parses macOS and Windows voice listings", () => {
    expect(
      parseMacVoices("Alex                en_US    # Most people recognize me by my voice.\n"),
    ).toEqual([{ id: "Alex", name: "Alex", language: "en-US", module: null }]);
    expect(parseWindowsVoices("Microsoft Zira Desktop|en-US\r\n\r\n")).toEqual([
      {
        id: "Microsoft Zira Desktop",
        name: "Microsoft Zira Desktop",
        language: "en-US",
        module: null,
      },
    ]);
  });
});

describe("speakCommand", () => {
  it("sends text on stdin and selects the module and voice", () => {
    const command = speakCommand("speech-dispatcher", {
      text: "rm -rf /; echo $(whoami)",
      voice: "espeak-ng:English (America)+Adam",
      rate: 3,
      pitch: 1,
      volume: 1,
    });
    expect(command.command).toBe("spd-say");
    expect(command.args.join(" ")).not.toContain("whoami");
    expect(command.args).toEqual([
      "-w",
      "-e",
      "-r",
      "100",
      "-p",
      "0",
      "-i",
      "100",
      "-o",
      "espeak-ng",
      "-y",
      "English (America)+Adam",
    ]);
  });
});
