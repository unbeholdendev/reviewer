import { anchorable, changedLines, skipped, withoutSkipped } from "./diff";
import type { Adapters, Comment, PR } from "./types";

const largePR = 3000;

export async function review({ forgejo, git, claude }: Adapters, pr: PR, base: string, head: string) {
  const checkout = await git.checkout(pr, base, head);
  try {
    const diff = withoutSkipped(checkout.diff);
    const changed = changedLines(diff);
    const large = changed > largePR;
    const { summary, recommendation, comments: all } = await claude.review({ ...checkout, diff }, large);
    const comments = all.filter((c) => !skipped(c.path));
    const lines = anchorable(diff);
    const inline = comments.filter((c) => lines.has(`${c.side} ${c.path}:${c.line}`));
    const outside = comments.filter((c) => !inline.includes(c));
    let body = `**Recommendation:** ${recommendation}\n\n${summary}`;
    if (large) body += `\n\n_Partial review: this PR has ${changed} changed lines, so only the key files were reviewed._`;
    if (outside.length) body += `\n\n**Outside the diff:**\n\n${outside.map((c) => `- \`${c.path}:${c.line}\` ${label(c)}`).join("\n")}`;
    await forgejo.createReview(pr, {
      event: "COMMENT",
      body,
      comments: inline.map((c) => ({ path: c.path, [c.side === "RIGHT" ? "new_position" : "old_position"]: c.line, body: label(c) })),
    });
  } finally {
    await git.remove(checkout);
  }
}

function label(c: Comment) {
  return `**${c.severity}:** ${c.body}`;
}
