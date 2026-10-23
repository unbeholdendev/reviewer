export const secret = "test-secret";

Object.assign(process.env, {
  FORGEJO_URL: "http://forgejo.test",
  FORGEJO_TOKEN: "forgejo-token",
  WEBHOOK_SECRET: secret,
  PI_MODEL: "openai/test-model",
  PI_API_KEY: "model-key",
});
