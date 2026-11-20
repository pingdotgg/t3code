const { rebrandName, rebrandText } = require("../../scripts/lib/rebrand.ts");

// A standalone build names its own product in every string, as the web and desktop bundles do.
function rebrandStringsPlugin({ types: t }, { name }) {
  const rename = (state, path, value, make) => {
    if (state.filename?.includes("node_modules")) return;
    const next = rebrandText(value, name);
    if (next !== value) path.replaceWith(make(next));
  };
  return {
    visitor: {
      StringLiteral(path, state) {
        rename(state, path, path.node.value, t.stringLiteral);
      },
      JSXText(path, state) {
        rename(state, path, path.node.value, t.jsxText);
      },
      TemplateElement(path, state) {
        const { raw, cooked } = path.node.value;
        rename(state, path, raw, (next) =>
          t.templateElement(
            { raw: next, cooked: cooked == null ? cooked : rebrandText(cooked, name) },
            path.node.tail,
          ),
        );
      },
    },
  };
}

module.exports = function (api) {
  // Metro's cacheVersion carries the name, so a cached config never outlives a rename.
  api.cache(true);
  const name = rebrandName(process.env);
  return {
    presets: [["babel-preset-expo", { unstable_transformImportMeta: true }]],
    plugins: name ? [[rebrandStringsPlugin, { name }]] : [],
  };
};
