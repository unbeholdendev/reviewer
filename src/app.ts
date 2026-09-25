import { Hono } from "hono";
import { z } from "zod";
import { WEBHOOK_SECRET } from "./env";
import { verify } from "./signature";

export type PR = { owner: string; repo: string; number: number };
export type Comment = { path: string; line: number; side: "LEFT" | "RIGHT"; body: string; severity: "blocking" | "nit" };
export type Review = { summary: string; recommendation: "blocking" | "nits" | "looks-good"; comments: Comment[] };
export type InlineComment = { path: string; body: string; new_position?: number; old_position?: number };
export type Checkout = { dir: string; diff: string; log: string; rules: string };
export type Adapters = {
  forgejo: { createReview(pr: PR, review: { event: "COMMENT"; body: string; comments: InlineComment[] }): Promise<void> };
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
    const diff = checkout.diff
      .split(/^(?=diff --git )/m)
      .filter((s) => !skipped(s.match(/^diff --git .* "?b\/(.*?)"?$/m)?.[1] ?? ""))
      .join("");
    const { summary, recommendation, comments: all } = await claude.review(pr, { ...checkout, diff });
    const comments = all.filter((c) => !skipped(c.path));
    const lines = anchorable(diff);
    const inline = comments.filter((c) => lines.has(`${c.side} ${c.path}:${c.line}`));
    const outside = comments.filter((c) => !inline.includes(c));
    let body = `**Recommendation:** ${recommendation}\n\n${summary}`;
    if (outside.length)
      body += `\n\n**Outside the diff:**\n\n${outside.map((c) => `- \`${c.path}:${c.line}\` **${c.severity}:** ${c.body}`).join("\n")}`;
    await forgejo.createReview(pr, {
      event: "COMMENT",
      body,
      comments: inline.map((c) => ({
        path: c.path,
        [c.side === "RIGHT" ? "new_position" : "old_position"]: c.line,
        body: `**${c.severity}:** ${c.body}`,
      })),
    });
  } finally {
    await git.remove(checkout);
  }
}

const lockfiles =
  /(^|\/)(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|flake\.lock|mix\.lock|pubspec\.lock|Podfile\.lock|packages\.lock\.json)$/;
const vendored = /(^|\/)(vendor|node_modules|third_party)\//;

function skipped(path: string) {
  return lockfiles.test(path) || vendored.test(path);
}

// Forgejo only anchors comments on lines shown in a hunk
function anchorable(diff: string) {
  const lines = new Set<string>();
  let path = "", left = 0, right = 0, inHunk = false;
  for (const l of diff.split("\n")) {
    const hunk = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (hunk) [left, right, inHunk] = [Number(hunk[1]), Number(hunk[2]), true];
    else if (l.startsWith("diff ")) [path, inHunk] = ["", false];
    else if (!inHunk) {
      if (l.startsWith("--- a/") || l.startsWith("+++ b/")) path = l.slice(6);
    } else if (l.startsWith("+")) lines.add(`RIGHT ${path}:${right++}`);
    else if (l.startsWith("-")) lines.add(`LEFT ${path}:${left++}`);
    else if (l.startsWith(" ")) lines.add(`LEFT ${path}:${left++}`).add(`RIGHT ${path}:${right++}`);
  }
  return lines;
}
