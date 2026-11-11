export default defineEventHandler((event) => ({
  name: getQuery(event).name ?? "visitor",
  greeting: process.env.GREETING ?? "Hello!",
}));
