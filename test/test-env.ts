export const secret = "test-secret";

Object.assign(process.env, {
  FORGEJO_URL: "http://forgejo.test",
  FORGEJO_TOKEN: "forgejo-token",
  WEBHOOK_SECRET: secret,
  CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
});
