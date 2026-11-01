export default {
  fetch() {
    return Response.json({
      authUrl: process.env.NEON_AUTH_BASE_URL,
      jwksUrl: process.env.NEON_AUTH_JWKS_URL,
      dataUrl: process.env.NEON_DATA_API_URL,
      aiUrl: process.env.NEON_AI_GATEWAY_BASE_URL,
      hasToken: Boolean(process.env.NEON_AI_GATEWAY_TOKEN),
      hasDeploymentKey: Boolean(process.env.NEON_API_KEY),
    });
  },
};
