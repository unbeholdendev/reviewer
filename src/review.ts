import { anchorable, changedLines, skipped, withoutSkipped } from "./diff";
import type { Adapters, Comment, Forgejo, PR } from "./types";

const largePR = 3000;
const fixReply = /^Fixed in \w+\.\n\n<!-- reviewer:fixed=(\d+) -->$/;

export async function review({ forgejo, git, claude }: Adapters, pr: PR, base: string, head: string, pushed: boolean) {
  const reviews = pushed ? (await forgejo.reviews(pr)).filter((r) => r.user === forgejo.login) : [];
  // anchored: the summary is model output and could echo a marker
  const since = reviews.map((r) => r.body.match(/<!-- reviewer:sha=(\w+) -->$/)?.[1]).findLast(Boolean);
  const checkout = await git.checkout(pr, base, head, since);
  try {
    const open = checkout.incremental ? await openComments(forgejo, pr, reviews) : [];
    const diff = withoutSkipped(checkout.diff);
    const changed = changedLines(diff);
    const large = changed > largePR;
    const { summary, recommendation, comments: all, addressed } = await claude.review({ ...checkout, diff }, large, open);
    const comments = all.filter((c) => !skipped(c.path));
    const lines = anchorable(diff);
    // Forgejo numbers removed lines against the PR base, not the last reviewed SHA
    const inline = comments.filter((c) => lines.has(`${c.side} ${c.path}:${c.line}`) && !(checkout.incremental && c.side === "LEFT"));
    const outside = comments.filter((c) => !inline.includes(c));
    let body = `**Recommendation:** ${recommendation}\n\n${summary}`;
    if (large) body += `\n\n_Partial review: this PR has ${changed} changed lines, so only the key files were reviewed._`;
    if (outside.length) body += `\n\n**Outside the diff:**\n\n${outside.map((c) => `- \`${c.path}:${c.line}\` ${label(c)}`).join("\n")}`;
    body += `\n\n<!-- reviewer:sha=${head} -->`;
    await forgejo.createReview(pr, {
      event: "COMMENT",
      body,
      comments: inline.map((c) => ({ path: c.path, [c.side === "RIGHT" ? "new_position" : "old_position"]: c.line, body: label(c) })),
    });
    for (const c of open) {
      const fix = addressed.find((a) => a.commentId === c.id && checkout.log.includes(a.sha));
      if (fix) await forgejo.reply(pr, c, `Fixed in ${fix.sha}.\n\n<!-- reviewer:fixed=${c.id} -->`);
    }
  } finally {
    await git.remove(checkout);
  }
}

function label(c: Comment) {
  return `**${c.severity}:** ${c.body}`;
}

async function openComments(forgejo: Forgejo, pr: PR, reviews: { id: number }[]) {
  const all = (await Promise.all(reviews.map((r) => forgejo.comments(pr, r.id)))).flat().filter((c) => c.user === forgejo.login);
  const fixed = new Set(all.map((c) => Number(c.body.match(fixReply)?.[1])));
  return all.filter((c) => !c.resolved && !fixed.has(c.id) && !fixReply.test(c.body));
}
