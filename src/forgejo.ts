import { FORGEJO_TOKEN, FORGEJO_URL } from "./env";
import type { Forgejo } from "./types";

export const forgejo: Forgejo = {
  async createReview({ owner, repo, number }, review) {
    const res = await fetch(`${FORGEJO_URL}/api/v1/repos/${owner}/${repo}/pulls/${number}/reviews`, {
      method: "POST",
      headers: { Authorization: `token ${FORGEJO_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(review),
    });
    if (!res.ok) throw new Error(`Forgejo createReview ${res.status}: ${await res.text()}`);
  },
};
