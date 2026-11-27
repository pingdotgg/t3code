import font from "./font.ttf";

export default {
  fetch() {
    return Response.json({ type: Object.prototype.toString.call(font) });
  },
};
