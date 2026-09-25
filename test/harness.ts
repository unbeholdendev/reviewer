// must stay first: sets env before src/env.ts parses it on import
import { secret } from "./test-env";
import { createHmac } from "node:crypto";
import { createApp } from "../src/app";

type Call = { adapter: string; method: string; args: unknown[] };

export function setup() {
  const calls: Call[] = [];
  const fake = (adapter: string) =>
    new Proxy(
      {},
      {
        // not thenable, so awaiting an adapter doesn't record a call
        get: (_, method) =>
          method === "then" ? undefined : (...args: unknown[]) => void calls.push({ adapter, method: String(method), args }),
      },
    );
  const app = createApp({ forgejo: fake("forgejo"), git: fake("git"), claude: fake("claude") });
  return { app, calls };
}

export function sign(body: string) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function send(app: ReturnType<typeof createApp>, event: string, payload: unknown, signature?: string | null) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "X-Forgejo-Event": event };
  if (signature !== null) headers["X-Forgejo-Signature"] = signature ?? sign(body);
  return app.request("/webhook", { method: "POST", headers, body });
}
