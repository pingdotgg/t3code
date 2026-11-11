const handler = async () => ({
  statusCode: 200,
  headers: { "content-type": "text/plain" },
  body: "hello from a custom domain",
});

export { handler };
export default handler;
