import { Hono } from "hono";
import { WEBHOOK_SECRET } from "./env";
import { verify } from "./signature";

export type Adapters = { forgejo: object; git: object; claude: object };

export function createApp(adapters: Adapters) {
  const pending = new Set<Promise<void>>();
  const app = new Hono();

  app.post("/webhook", async (c) => {
    const body = await c.req.text();
    if (!verify(WEBHOOK_SECRET, body, c.req.header("X-Forgejo-Signature"))) return c.body(null, 401);
    const event = c.req.header("X-Forgejo-Event");
    const job = Promise.resolve()
      .then(() => handle(adapters, event, JSON.parse(body)))
      .finally(() => pending.delete(job));
    pending.add(job);
    return c.body(null, 200);
  });

  async function idle() {
    while (pending.size) await Promise.all(pending);
  }

  return Object.assign(app, { idle });
}

async function handle(adapters: Adapters, event: string | undefined, payload: unknown) {}
