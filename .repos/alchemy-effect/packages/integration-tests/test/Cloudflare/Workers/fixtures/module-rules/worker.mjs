import data from "./data.bin";
import font from "./font.ttf";
import notice from "./notice.txt";
import readme from "./readme.md";

const hex = (buffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");

export default {
  fetch: () =>
    Response.json({
      font: { type: Object.prototype.toString.call(font), hex: hex(font) },
      data: hex(data),
      notice,
      readme,
    }),
};
