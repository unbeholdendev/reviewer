import { anchorable, changedLines, skipped, withoutSkipped } from "./diff";
import type { Adapters, BotComment, Comment, Forgejo, PR, Thread } from "./types";

const largePR = 3000;
const fixReply = /^Fixed in \w+\.\n\n<!-- reviewer:fixed=(\d+) -->$/;

export async function review(adapters: Adapters, pr: PR, base: string, head: string, pushed: boolean, signal: AbortSignal, comment?: number) {
  if (signal.aborted) return;
  try {
    await run(adapters, pr, base, head, pushed, signal, comment);
  } catch (e) {
    if (signal.aborted) throw e;
    try {
      await adapters.forgejo.comment(pr, `The review failed. Retry with \`@${adapters.forgejo.login} review again\`.`);
    } catch (c) {
      console.log("failure comment failed:", c);
    }
    throw e;
  }
}

async function run({ forgejo, git, claude }: Adapters, pr: PR, base: string, head: string, pushed: boolean, signal: AbortSignal, comment?: number) {
  try {
    await (comment ? forgejo.reactComment(pr, comment) : forgejo.react(pr));
  } catch (e) {
    console.error("reaction failed:", e);
  }
  const reviews = pushed ? (await forgejo.reviews(pr)).filter((r) => r.user === forgejo.login) : [];
  // anchored: the summary is model output and could echo a marker
  const since = reviews.map((r) => r.body.match(/<!-- reviewer:sha=(\w+) -->$/)?.[1]).findLast(Boolean);
  const checkout = await git.checkout(pr, base, head, since);
  try {
    const open = checkout.incremental ? await openComments(forgejo, pr, reviews) : [];
    const diff = withoutSkipped(checkout.diff);
    const changed = changedLines(diff);
    const large = changed > largePR;
    console.log(`${key(pr)}: reviewing ${checkout.incremental ? `since ${since}` : "full diff"}, ${changed} changed lines, ${open.length} open comments`);
    const { summary, recommendation, comments: all, addressed } = await claude.review({ ...checkout, diff }, large, open, signal);
    const comments = all.filter((c) => !skipped(c.path));
    const lines = anchorable(diff);
    // Forgejo numbers removed lines against the PR base, not the last reviewed SHA
    const inline = comments.filter((c) => lines.has(`${c.side} ${c.path}:${c.line}`) && !(checkout.incremental && c.side === "LEFT"));
    const outside = comments.filter((c) => !inline.includes(c));
    let body = `**Recommendation:** ${recommendation}\n\n${summary}`;
    if (large) body += `\n\n_Partial review: this PR has ${changed} changed lines, so only the key files were reviewed._`;
    if (outside.length) body += `\n\n**Outside the diff:**\n\n${outside.map((c) => `- \`${c.path}:${c.line}\` ${label(c)}`).join("\n")}`;
    body += `\n\n<!-- reviewer:sha=${head} -->`;
    console.log(`${key(pr)}: ${recommendation}, ${inline.length} inline, ${outside.length} outside the diff, ${all.length - comments.length} on skipped files, ${addressed.length} addressed`);
    if (signal.aborted) return;
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

export async function reply({ forgejo, git, claude }: Adapters, pr: PR, comment: { id: number; body: string }, mentioned: boolean) {
  const thread = await botThread(forgejo, pr, comment.id);
  if (!thread && !mentioned) return console.log(`${key(pr)}: comment ${comment.id} not for the bot, no reply`);
  console.log(`${key(pr)}: replying to comment ${comment.id}${thread ? " in a thread" : ""}`);
  try {
    await forgejo.reactComment(pr, comment.id);
  } catch (e) {
    console.error("reaction failed:", e);
  }
  const { base, head } = await forgejo.pull(pr);
  const checkout = await git.checkout(pr, base, head);
  try {
    const { body } = await claude.reply({ ...checkout, diff: withoutSkipped(checkout.diff) }, comment.body, thread);
    await (thread ? forgejo.reply(pr, thread[0], body) : forgejo.comment(pr, body));
  } finally {
    await git.remove(checkout);
  }
}

function key({ owner, repo, number }: PR) {
  return `${owner}/${repo}#${number}`;
}

function label(c: Comment) {
  return `**${c.severity}:** ${c.body}`;
}

async function openComments(forgejo: Forgejo, pr: PR, reviews: { id: number }[]) {
  const all = (await Promise.all(reviews.map((r) => forgejo.comments(pr, r.id)))).flat();
  const bot = all.filter((c) => c.user === forgejo.login);
  const fixed = new Set(bot.map((c) => Number(c.body.match(fixReply)?.[1])));
  return bot.filter((c) => !c.resolved && !fixed.has(c.id) && !fixReply.test(c.body) && !all.some((o) => o.id < c.id && sameThread(o, c)));
}

// Forgejo files a thread reply under the review that started the thread
async function botThread(forgejo: Forgejo, pr: PR, id: number): Promise<Thread | undefined> {
  for (const r of (await forgejo.reviews(pr)).filter((r) => r.user === forgejo.login)) {
    const comments = await forgejo.comments(pr, r.id);
    const comment = comments.find((c) => c.id === id);
    if (!comment) continue;
    const [first, ...rest] = comments.filter((c) => c.id < id && sameThread(c, comment)).sort((a, b) => a.id - b.id);
    return first?.user === forgejo.login ? [first, ...rest] : undefined;
  }
}

function sameThread(a: BotComment, b: BotComment) {
  return a.review === b.review && a.path === b.path && a.line === b.line && a.side === b.side;
}
