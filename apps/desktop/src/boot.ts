require("./compileCache.cjs");
if (process.versions.electron && !process.argv.includes("--version")) {
  require("./initialWindow.cjs").start(() => require("./main.cjs"));
} else {
  require("./main.cjs");
}
