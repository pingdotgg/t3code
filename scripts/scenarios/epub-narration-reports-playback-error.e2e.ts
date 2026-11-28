/// <reference lib="dom" />
import { expect } from "e2e";
import JSZip from "jszip";

import { test, WEB } from "./t3.ts";

async function readAlongBook() {
  const sampleRate = 8_000;
  const wav = Buffer.alloc(44 + sampleRate * 2 * 10);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);

  return new JSZip()
    .file(
      "META-INF/container.xml",
      '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
    )
    .file(
      "book.opf",
      `<package><manifest>
        <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml" media-overlay="read"/>
        <item id="read" href="read.smil" media-type="application/smil+xml"/>
        <item id="audio" href="audio.wav" media-type="audio/wav"/>
      </manifest><spine><itemref idref="chapter"/></spine></package>`,
    )
    .file("chapter.xhtml", '<html><body><p id="opening">The first passage.</p></body></html>')
    .file(
      "read.smil",
      `<smil xmlns="http://www.w3.org/ns/SMIL"><body>
        <par><text src="chapter.xhtml#opening"/><audio src="audio.wav" clipEnd="10s"/></par>
      </body></smil>`,
    )
    .file("audio.wav", wav)
    .generateAsync({ type: "uint8array" });
}

test(
  "An EPUB narration decoding error after playback starts is shown in the preview",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo", { "read-along.epub": await readAlongBook() });
    const thread = await t3.thread({ project, title: "Read a book", messages: ["Start"] });
    await t3.open(thread);
    await screen.getByText("fixture turn complete", { exact: false }).waitFor();
    await browser.keyboard.press("Control+p");
    await screen.getByPlaceholder("Search files…").fill("read-along.epub");
    await screen.getByRole("option", "read-along.epub", { exact: false }).tap();
    const read = screen.getByRole("button", "Read aloud");
    // Cold dev servers can reload while optimizing the EPUB worker.
    await read.waitFor({ timeout: 120_000 });
    await browser.evaluate(() => {
      const player = document.querySelector("audio")!;
      player.muted = true;
      // Simulate the decoder reporting a fatal error after the play promise has settled.
      player.addEventListener(
        "playing",
        () => {
          player.addEventListener(
            "timeupdate",
            () => {
              player.pause();
              Object.defineProperty(player, "error", {
                value: { code: 3, message: "Decoding failed" },
                configurable: true,
              });
              player.dispatchEvent(new Event("error"));
              player.dataset.decodeErrorDelivered = "true";
            },
            { once: true },
          );
        },
        { once: true },
      );
      return null;
    });
    await read.tap();
    await browser
      .locator('audio[data-decode-error-delivered="true"]')
      .waitFor({ state: "attached" });
    await expect(
      await browser.evaluate(() =>
        document.body.textContent?.includes("Could not play narration."),
      ),
    ).toBe(true);
    await read.waitFor();
    await app.screenshot("epub-after-narration-error");
  },
);
