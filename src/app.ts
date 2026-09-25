import { Hono } from "hono";
import { z } from "zod";
import { WEBHOOK_SECRET } from "./env";
import { verify } from "./signature";

export type PR = { owner: string; repo: string; number: number };
export type Review = { summary: string; recommendation: "blocking" | "nits" | "looks-good" };
export type Checkout = { dir: string; diff: string; log: string };
export type Adapters = {
  forgejo: { createReview(pr: PR, review: { event: "COMMENT"; body: string }): Promise<void> };
  git: { checkout(pr: PR, base: string, head: string): Promise<Checkout>; remove(checkout: Checkout): Promise<void> };
  claude: { review(pr: PR, checkout: Checkout): Promise<Review> };
};

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

const PullRequestEvent = z.object({
  action: z.string(),
  number: z.number(),
  pull_request: z.object({ base: z.object({ sha: z.string() }), head: z.object({ sha: z.string() }) }),
  repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
});

async function handle({ forgejo, git, claude }: Adapters, event: string | undefined, payload: unknown) {
  if (event !== "pull_request") return;
  const parsed = PullRequestEvent.safeParse(payload);
  if (!parsed.success || !["opened", "reopened"].includes(parsed.data.action)) return;
  const { number, pull_request, repository } = parsed.data;
  const pr = { owner: repository.owner.login, repo: repository.name, number };
  const checkout = await git.checkout(pr, pull_request.base.sha, pull_request.head.sha);
  try {
    const { summary, recommendation } = await claude.review(pr, checkout);
    await forgejo.createReview(pr, { event: "COMMENT", body: `**Recommendation:** ${recommendation}\n\n${summary}` });
  } finally {
    await git.remove(checkout);
  }
}
