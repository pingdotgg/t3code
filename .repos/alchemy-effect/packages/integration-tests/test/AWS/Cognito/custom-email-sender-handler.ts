// Minimal CustomEmailSender trigger target. Cognito only needs a real
// function ARN to configure the pool; this handler never has to decrypt
// anything for the lifecycle test.
const handler = async () => undefined;

export { handler };
export default handler;
