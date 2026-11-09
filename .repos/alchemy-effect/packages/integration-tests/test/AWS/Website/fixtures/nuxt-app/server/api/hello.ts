export default defineEventHandler((event) => ({
  marker: "NUXT_AWS_API_MARKER",
  method: event.method,
  echo: getQuery(event).echo ?? null,
}));
