import { z } from "zod";
import { FORGEJO_TOKEN, FORGEJO_URL } from "./env";
import { type Forgejo, ForgejoCreated, ForgejoPull, ForgejoReview, ForgejoReviewComment, ForgejoUser } from "./types";

const headers = { Authorization: `token ${FORGEJO_TOKEN}`, "Content-Type": "application/json" };

async function api<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const method = body ? "POST" : "GET";
  const start = Date.now();
  const res = await fetch(`${FORGEJO_URL}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  console.log(`forgejo ${method} ${path} ${res.status} ${Date.now() - start}ms`);
  if (!res.ok) throw new Error(`Forgejo ${path} ${res.status}: ${await res.text()}`);
  return schema.parse(await res.json());
}

export const forgejo: Forgejo = {
  login: (await api("/user", ForgejoUser)).login,
  async react({ owner, repo, number }) {
    await api(`/repos/${owner}/${repo}/issues/${number}/reactions`, z.unknown(), { content: "eyes" });
  },
  async reactComment({ owner, repo }, comment) {
    await api(`/repos/${owner}/${repo}/issues/comments/${comment}/reactions`, z.unknown(), { content: "eyes" });
  },
  async pull({ owner, repo, number }) {
    const { base, head } = await api(`/repos/${owner}/${repo}/pulls/${number}`, ForgejoPull);
    return { base: base.sha, head: head.sha };
  },
  async comment({ owner, repo, number }, body) {
    await api(`/repos/${owner}/${repo}/issues/${number}/comments`, ForgejoCreated, { body });
  },
  async createReview({ owner, repo, number }, review) {
    await api(`/repos/${owner}/${repo}/pulls/${number}/reviews`, ForgejoCreated, review);
  },
  async reviews({ owner, repo, number }) {
    const all: z.infer<typeof ForgejoReview>[] = [];
    for (let page = 1; ; page++) {
      const batch = await api(`/repos/${owner}/${repo}/pulls/${number}/reviews?page=${page}&limit=50`, z.array(ForgejoReview));
      // page order isn't documented, and the latest marker must win
      if (!batch.length) return all.sort((a, b) => a.id - b.id).map((r) => ({ id: r.id, user: r.user?.login ?? "", body: r.body }));
      all.push(...batch);
    }
  },
  async comments({ owner, repo, number }, review) {
    const all = await api(`/repos/${owner}/${repo}/pulls/${number}/reviews/${review}/comments`, z.array(ForgejoReviewComment));
    return all.map((c) => ({
      id: c.id,
      review,
      user: c.user?.login ?? "",
      path: c.path,
      line: c.position || c.original_position,
      side: c.position ? "RIGHT" : "LEFT",
      body: c.body,
      resolved: !!c.resolver,
    }));
  },
  async reply({ owner, repo, number }, { review, path, line, side }, body) {
    // same review, path and line: Forgejo threads it under the original comment
    await api(`/repos/${owner}/${repo}/pulls/${number}/reviews/${review}/comments`, ForgejoCreated, {
      path,
      body,
      [side === "RIGHT" ? "new_position" : "old_position"]: line,
    });
  },
};
