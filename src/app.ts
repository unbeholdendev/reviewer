import { Hono } from "hono";
import { z } from "zod";
import { CONCURRENCY, WEBHOOK_SECRET } from "./env";
import { reply, review } from "./review";
import { verify } from "./signature";
import type { Adapters } from "./types";

export function createApp(adapters: Adapters) {
  const pending = new Set<Promise<void>>();
  const waiting: (() => void)[] = [];
  let running = 0;
  const app = new Hono();

  async function limited(fn: () => Promise<void>) {
    if (running < CONCURRENCY) running++;
    else await new Promise<void>((r) => waiting.push(r));
    try {
      await fn();
    } finally {
      // pass the slot on without freeing it, so a newcomer can't jump the queue
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  }

  app.post("/webhook", async (c) => {
    const body = await c.req.text();
    if (!verify(WEBHOOK_SECRET, body, c.req.header("X-Forgejo-Signature"))) return c.body(null, 401);
    const event = c.req.header("X-Forgejo-Event");
    const job = limited(() => handle(adapters, event, JSON.parse(body)))
      .catch((e) => console.log("webhook job failed:", e))
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

const IssueCommentEvent = z.object({
  action: z.string(),
  is_pull: z.boolean(),
  issue: z.object({ number: z.number() }),
  comment: z.object({ id: z.number(), body: z.string() }),
  repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
});

const Sender = z.object({ sender: z.object({ login: z.string() }) });

async function handle(adapters: Adapters, event: string | undefined, payload: unknown) {
  if (Sender.safeParse(payload).data?.sender.login === adapters.forgejo.login) return;
  if (event === "issue_comment") return commented(adapters, payload);
  if (event !== "pull_request") return;
  const parsed = PullRequestEvent.safeParse(payload);
  if (!parsed.success) return;
  const { action, changes, number, pull_request, repository } = parsed.data;
  if (pull_request.labels?.some((l) => l.name === "no-review")) return;
  // Forgejo has no ready-for-review action: a draft is a title with a WIP prefix
  const undrafted = action === "edited" && /^(wip:|\[wip\])/i.test(changes?.title?.from ?? "");
  const pushed = action === "synchronized";
  if (pull_request.draft || pull_request.state !== "open" || !(["opened", "reopened"].includes(action) || undrafted || pushed)) return;
  const pr = { owner: repository.owner.login, repo: repository.name, number };
  await review(adapters, pr, pull_request.base.sha, pull_request.head.sha, pushed);
}

async function commented(adapters: Adapters, payload: unknown) {
  const parsed = IssueCommentEvent.safeParse(payload);
  if (!parsed.success) return;
  const { action, is_pull, issue, comment, repository } = parsed.data;
  const login = adapters.forgejo.login.replaceAll(".", "\\.");
  if (action !== "created" || !is_pull) return;
  // not part of an email or a longer login; a trailing full stop ends the sentence
  const mention = `(^|[^\\w@])@${login}`;
  const mentioned = new RegExp(`${mention}(?![\\w-]|\\.\\w)`, "i").test(comment.body);
  const rest = comment.body.replace(new RegExp(`${mention}[\\s,:]+review\\s+again\\b`, "i"), "$1");
  const pr = { owner: repository.owner.login, repo: repository.name, number: issue.number };
  if (rest === comment.body) return reply(adapters, pr, comment, mentioned);
  const { base, head } = await adapters.forgejo.pull(pr);
  await review(adapters, pr, base, head, false, comment.id);
  if (/\w/.test(rest)) await reply(adapters, pr, comment, true);
}
