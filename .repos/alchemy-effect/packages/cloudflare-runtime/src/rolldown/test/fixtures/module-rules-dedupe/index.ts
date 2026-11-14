import text from "./a.md";
import data from "./b.bin";

export default {
  fetch() {
    return Response.json({
      text: Object.prototype.toString.call(text),
      data: Object.prototype.toString.call(data),
    });
  },
};
