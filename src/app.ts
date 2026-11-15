import { Hono } from "hono";
import { WEBHOOK_SECRET } from "./env";
import { handle } from "./events";
import { createQueue } from "./queue";
import { verify } from "./signature";
import type { Adapters } from "./types";

export function createApp(adapters: Adapters) {
  const { schedule, idle } = createQueue();
  const app = new Hono();

  app.post("/webhook", async (c) => {
    const body = await c.req.text();
    const delivery = c.req.header("X-Forgejo-Delivery");
    if (!verify(WEBHOOK_SECRET, body, c.req.header("X-Forgejo-Signature"))) {
      console.log(`webhook ${delivery}: bad signature, 401`);
      return c.body(null, 401);
    }
    const event = c.req.header("X-Forgejo-Event");
    const payload = JSON.parse(body);
    const job = handle(adapters, event, payload);
    const number = payload?.number ?? payload?.issue?.number;
    console.log(
      `webhook ${delivery}: ${event} ${payload?.action} ${payload?.repository?.full_name}#${number} by ${payload?.sender?.login}: ${job ? "queued" : "ignored"}`,
    );
    if (job) schedule(job);
    return c.body(null, 200);
  });

  return Object.assign(app, { idle });
}
