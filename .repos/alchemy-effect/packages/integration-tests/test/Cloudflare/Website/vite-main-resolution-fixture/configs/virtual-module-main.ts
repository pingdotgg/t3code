// `playground/main-resolution/vite.config.virtual-module-main.ts`.
export default {
  plugins: [
    {
      name: "virtual-module-plugin",
      resolveId(source: string) {
        if (source === "virtual:entry") {
          return `\0${source}`;
        }
      },
      load(id: string) {
        if (id === "\0virtual:entry") {
          return `
export default {
	fetch() {
		return new Response("Virtual module as Worker entry file");
	}
}
					`;
        }
      },
    },
  ],
};
