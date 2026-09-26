import { FORGEJO_TOKEN, FORGEJO_URL } from "./env";
import type { Forgejo } from "./types";

const headers = { Authorization: `token ${FORGEJO_TOKEN}`, "Content-Type": "application/json" };

const me = await fetch(`${FORGEJO_URL}/api/v1/user`, { headers });
if (!me.ok) throw new Error(`Forgejo user ${me.status}: ${await me.text()}`);

export const forgejo: Forgejo = {
  login: ((await me.json()) as { login: string }).login,
  async createReview({ owner, repo, number }, review) {
    const res = await fetch(`${FORGEJO_URL}/api/v1/repos/${owner}/${repo}/pulls/${number}/reviews`, {
      method: "POST",
      headers,
      body: JSON.stringify(review),
    });
    if (!res.ok) throw new Error(`Forgejo createReview ${res.status}: ${await res.text()}`);
  },
};
