import { helloCjs, helloWorldExt, worldJs } from "@playground/module-resolution-requires/ext";

export default {
  "(requires/ext) helloWorld": helloWorldExt,
  "(requires/ext) hello.cjs (wrong-extension)": helloCjs,
  "(requires/ext) world.js (wrong-extension)": worldJs,
};
