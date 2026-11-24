import { createServer, build } from "vite";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
const config = {root,configFile:false,server:{host:"127.0.0.1",port:4390,strictPort:true,proxy:{"/api":"http://127.0.0.1:4319"}},build:{outDir:"dist",emptyOutDir:true}};
if (process.argv.includes("--build")) await build(config);
else {
  const server = await createServer(config);
  await server.listen();
  server.printUrls();
}
