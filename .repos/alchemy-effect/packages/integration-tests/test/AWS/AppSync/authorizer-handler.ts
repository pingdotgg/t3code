/**
 * AppSync Lambda authorizer fixture: authorizes any request whose
 * authorization token equals "let-me-in".
 */
const handler = async (event: { authorizationToken?: string }) => ({
  isAuthorized: event?.authorizationToken === "let-me-in",
});

export { handler };
export default handler;
