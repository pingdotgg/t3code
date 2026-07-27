/**
 * AppSync Lambda data-source fixture. The JS resolvers under test invoke
 * this function with `{ field, args }` payloads and surface the returned
 * value as the GraphQL result — proving the value was computed here.
 */
const handler = async (event: {
  field?: string;
  args?: Record<string, number & string>;
}) => {
  switch (event?.field) {
    case "add":
      return Number(event.args?.a) + Number(event.args?.b);
    case "double":
      return Number(event.args?.n) * 2;
    case "greet":
      return `Hello, ${event.args?.name}! (from Lambda)`;
    default:
      throw new Error(`Unknown field: ${event?.field}`);
  }
};

export { handler };
export default handler;
