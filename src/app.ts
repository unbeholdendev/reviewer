import { Hono } from "hono";
import { z } from "zod";
import { WEBHOOK_SECRET } from "./env";
import { review } from "./review";
import { verify } from "./signature";
import type { Adapters } from "./types";

export function createApp(adapters: Adapters) {
  const pending = new Set<Promise<void>>();
  const app = new Hono();

  app.post("/webhook", async (c) => {
    const body = await c.req.text();
    if (!verify(WEBHOOK_SECRET, body, c.req.header("X-Forgejo-Signature"))) return c.body(null, 401);
    const event = c.req.header("X-Forgejo-Event");
    const job = Promise.resolve()
      .then(() => handle(adapters, event, JSON.parse(body)))
      .catch((e) => console.error("webhook job failed:", e))
      .finally(() => pending.delete(job));
    pending.add(job);
    return c.body(null, 200);
  });

  async function idle() {
    while (pending.size) await Promise.all(pending);
  }

  return Object.assign(app, { idle });
}

const PullRequestEvent = z.object({
  action: z.string(),
  number: z.number(),
  changes: z.object({ title: z.object({ from: z.string() }).optional() }).optional(),
  pull_request: z.object({
    state: z.string(),
    draft: z.boolean().optional(),
    labels: z.array(z.object({ name: z.string() })).nullish(),
    base: z.object({ sha: z.string() }),
    head: z.object({ sha: z.string() }),
  }),
  repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
});

const Sender = z.object({ sender: z.object({ login: z.string() }) });

async function handle(adapters: Adapters, event: string | undefined, payload: unknown) {
  if (Sender.safeParse(payload).data?.sender.login === adapters.forgejo.login) return;
  if (event !== "pull_request") return;
  const parsed = PullRequestEvent.safeParse(payload);
  if (!parsed.success) return;
  const { action, changes, number, pull_request, repository } = parsed.data;
  if (pull_request.labels?.some((l) => l.name === "no-review")) return;
  // Forgejo has no ready-for-review action: a draft is a title with a WIP prefix
  const undrafted = action === "edited" && /^(wip:|\[wip\])/i.test(changes?.title?.from ?? "");
  if (pull_request.draft || pull_request.state !== "open" || !(["opened", "reopened"].includes(action) || undrafted)) return;
  const pr = { owner: repository.owner.login, repo: repository.name, number };
  await review(adapters, pr, pull_request.base.sha, pull_request.head.sha);
}
