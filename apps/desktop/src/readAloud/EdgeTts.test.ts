import { describe, expect, it } from "vite-plus/test";

import { isEdgeTtsVoiceName, parseEdgeTtsVoiceList, resolveEdgeTtsCommand } from "./EdgeTts.ts";

describe("parseEdgeTtsVoiceList", () => {
  it("reads the voices out of edge-tts --list-voices", () => {
    const output = [
      "Name                               Gender    ContentCategories      VoicePersonalities",
      "---------------------------------  --------  ---------------------  ------------------",
      "en-US-AvaMultilingualNeural        Female    Conversation, Copilot  Expressive, Caring",
      "en-US-AndrewNeural                 Male      Conversation, Copilot  Warm, Confident",
      "zh-CN-liaoning-XiaobeiNeural       Female    Dialect                Humorous",
      "",
    ].join("\r\n");
    expect(parseEdgeTtsVoiceList(output)).toEqual([
      {
        shortName: "en-US-AvaMultilingualNeural",
        gender: "Female",
        personalities: "Expressive, Caring",
      },
      { shortName: "en-US-AndrewNeural", gender: "Male", personalities: "Warm, Confident" },
      { shortName: "zh-CN-liaoning-XiaobeiNeural", gender: "Female", personalities: "Humorous" },
    ]);
  });
});

describe("isEdgeTtsVoiceName", () => {
  it("accepts voice names and rejects anything that could be an option", () => {
    expect(isEdgeTtsVoiceName("en-US-EmmaMultilingualNeural")).toBe(true);
    expect(isEdgeTtsVoiceName("--write-media")).toBe(false);
    expect(isEdgeTtsVoiceName("Microsoft Ava")).toBe(false);
  });
});

describe("resolveEdgeTtsCommand", () => {
  it("prefers an explicit path, then uv's tool folder, then PATH", () => {
    expect(resolveEdgeTtsCommand({ T3CODE_EDGE_TTS_PATH: "D:\\tts.exe" }, "C:\\Users\\R")).toBe(
      "D:\\tts.exe",
    );
    expect(resolveEdgeTtsCommand({}, "/home/r", () => true)).toMatch(
      /\.local[\\/]bin[\\/]edge-tts/,
    );
    expect(resolveEdgeTtsCommand({}, "/home/r", () => false)).toBe("edge-tts");
  });
});
