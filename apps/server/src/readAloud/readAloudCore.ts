import type { ReadAloudSpeakInput, ReadAloudVoice } from "@t3tools/contracts";

/** Base voices of every module, plus the voice variants of these espeak-ng languages. */
const ESPEAK_VARIANT_LANGUAGES = new Set(["en-us", "en-gb"]);
const VOICE_LIMIT = 400;

/**
 * Parses `spd-say -o <module> -L`: a header, then right-aligned NAME, LANGUAGE, VARIANT columns.
 * Names can contain spaces (`English (America)+Adam`), so columns are read from the right.
 */
export function parseSpeechDispatcherVoices(module: string, output: string): ReadAloudVoice[] {
  const voices: ReadAloudVoice[] = [];
  for (const line of output.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const variant = parts.at(-1)!;
    const language = parts.at(-2)!;
    const name = parts.slice(0, -2).join(" ");
    if (name === "" || name === "NAME") continue;
    if (variant !== "none" && !ESPEAK_VARIANT_LANGUAGES.has(language.toLowerCase())) continue;
    voices.push({ id: `${module}:${name}`, name, language, module });
  }
  return voices;
}

/** `say -v '?'`: `Alex                en_US    # Most people recognize me by my voice.` */
export function parseMacVoices(output: string): ReadAloudVoice[] {
  const voices: ReadAloudVoice[] = [];
  for (const line of output.split("\n")) {
    const match = /^(.+?)\s{2,}([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#/.exec(line);
    if (!match) continue;
    const name = match[1]!.trim();
    voices.push({ id: name, name, language: match[2]!.replace("_", "-"), module: null });
  }
  return voices;
}

/** One `name|culture` per line from the PowerShell voice listing. */
export function parseWindowsVoices(output: string): ReadAloudVoice[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("|"))
    .map((line) => {
      const [name = "", language = ""] = line.split("|");
      return { id: name, name, language, module: null };
    })
    .filter((voice) => voice.name !== "");
}

export function limitVoices(voices: ReadonlyArray<ReadAloudVoice>): ReadAloudVoice[] {
  return voices.slice(0, VOICE_LIMIT);
}

/** Command and arguments that speak `input`; text always goes on stdin, never in argv. */
export function speakCommand(
  engine: "speech-dispatcher" | "macos-say" | "windows-sapi",
  input: ReadAloudSpeakInput,
): { readonly command: string; readonly args: string[] } {
  switch (engine) {
    case "speech-dispatcher": {
      const args = [
        "-w",
        "-e",
        "-r",
        String(Math.round((input.rate - 1) * 100 * 0.8)),
        "-p",
        String(Math.round((input.pitch - 1) * 200)),
        "-i",
        String(Math.round(input.volume * 200 - 100)),
      ];
      const separator = input.voice.indexOf(":");
      if (separator > 0) {
        args.push("-o", input.voice.slice(0, separator), "-y", input.voice.slice(separator + 1));
      }
      return { command: "spd-say", args: args.map((arg) => clampSpdArg(arg)) };
    }
    case "macos-say": {
      const args = ["-r", String(Math.round(175 * input.rate)), "-f", "-"];
      if (input.voice) args.unshift("-v", input.voice);
      return { command: "say", args };
    }
    case "windows-sapi": {
      const voice = input.voice.replaceAll("'", "''");
      const script = [
        "Add-Type -AssemblyName System.Speech",
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
        voice ? `$s.SelectVoice('${voice}')` : "",
        `$s.Rate = ${Math.max(-10, Math.min(10, Math.round((input.rate - 1) * 10)))}`,
        `$s.Volume = ${Math.round(input.volume * 100)}`,
        "$s.Speak([Console]::In.ReadToEnd())",
      ]
        .filter(Boolean)
        .join("; ");
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", script],
      };
    }
  }
}

/** speech-dispatcher accepts -100..100 for rate, pitch, and volume. */
function clampSpdArg(arg: string): string {
  if (!/^-?\d+$/.test(arg)) return arg;
  return String(Math.max(-100, Math.min(100, Number(arg))));
}
