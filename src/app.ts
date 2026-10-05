import { Hono } from "hono";
import { z } from "zod";
import { CONCURRENCY, WEBHOOK_SECRET } from "./env";
import { reply, review } from "./review";
import { verify } from "./signature";
import type { Adapters, PR } from "./types";

export function createApp(adapters: Adapters) {
  const pending = new Set<Promise<unknown>>();
  const waiting: (() => void)[] = [];
  const tails = new Map<string, Promise<unknown>>();
  const reviews = new Map<string, AbortController>();
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
    const delivery = c.req.header("X-Forgejo-Delivery");
    if (!verify(WEBHOOK_SECRET, body, c.req.header("X-Forgejo-Signature"))) {
      console.log(`webhook ${delivery}: bad signature, 401`);
      return c.body(null, 401);
    }
    const event = c.req.header("X-Forgejo-Event");
    const payload = JSON.parse(body);
    const job = handle(adapters, event, payload);
    const number = payload?.number ?? payload?.issue?.number;
    console.log(`webhook ${delivery}: ${event} ${payload?.action} ${payload?.repository?.full_name}#${number} by ${payload?.sender?.login}: ${job ? "queued" : "ignored"}`);
    if (job) schedule(job);
    return c.body(null, 200);
  });

  function schedule({ pr, cancellable, pushed, run }: Job) {
    const key = `${pr.owner}/${pr.repo}#${pr.number}`;
    if (pushed && reviews.has(key)) console.log(`${key}: new push, cancelling the running review`);
    if (pushed) reviews.get(key)?.abort();
    if (pushed || !reviews.has(key)) reviews.set(key, new AbortController());
    const controller = cancellable ? reviews.get(key)! : new AbortController();
    const job = (tails.get(key) ?? Promise.resolve())
      .then(() =>
        limited(async () => {
          const start = Date.now();
          console.log(`${key}: job started, ${waiting.length} waiting`);
          await run(controller.signal);
          console.log(`${key}: job ${controller.signal.aborted ? "cancelled" : "done"} in ${Date.now() - start}ms`);
        }),
      )
      .catch((e) => {
        if (controller.signal.aborted) console.log(`${key}: job cancelled`);
        else console.log("webhook job failed:", e);
      })
      .finally(() => {
        pending.delete(job);
        if (tails.get(key) !== job) return;
        tails.delete(key);
        reviews.delete(key);
      });
    tails.set(key, job);
    pending.add(job);
  }

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
    user: z.object({ login: z.string() }).nullable(),
    title: z.string(),
    body: z.string(),
    created_at: z.string(),
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

type Job = { pr: PR; cancellable: boolean; pushed?: boolean; run: (signal: AbortSignal) => Promise<void> };

function handle(adapters: Adapters, event: string | undefined, payload: unknown): Job | undefined {
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
  const { base, head, user, title, body, created_at } = pull_request;
  const pull = { base: base.sha, head: head.sha, description: { user: user?.login ?? "", body: `${title}\n\n${body}`, at: created_at } };
  return { pr, cancellable: true, pushed, run: (signal) => review(adapters, pr, pull, pushed, signal) };
}

function commented(adapters: Adapters, payload: unknown): Job | undefined {
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
  if (rest === comment.body) return { pr, cancellable: false, run: () => reply(adapters, pr, comment, mentioned) };
  return {
    pr,
    cancellable: true,
    async run(signal) {
      await review(adapters, pr, await adapters.forgejo.pull(pr), false, signal, comment.id);
      if (/\w/.test(rest) && !signal.aborted) await reply(adapters, pr, comment, true);
    },
  };
}
