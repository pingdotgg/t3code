// Mirrors `playground/react-spa/vite.config.server-headers.ts`.
export default {
  server: {
    headers: {
      "custom-string": "string-value",
      "custom-string-array": ["one", "two", "three"],
      "custom-number": 123,
    },
  },
};
