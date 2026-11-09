import { defineWebPlugin } from "@t3tools/plugin-sdk/web";

export default defineWebPlugin({
  activate(api) {
    api.ui.replace("app.pageFrame", (frame) => frame.page);
    api.ui.replace("app.sidebar", (sidebar) => (
      <>
        {sidebar.header}
        {sidebar.nav ?? sidebar.threads}
        {sidebar.page === null ? sidebar.footer : sidebar.back}
      </>
    ));
  },
});
