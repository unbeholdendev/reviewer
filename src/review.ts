import { anchorable, changedLines, skipped, withoutSkipped } from "./diff";
import type { Adapters, BotComment, Comment, Forgejo, Note, PR, Pull, Thread } from "./types";

const largePR = 3000;
const fixReply = /^Fixed in \w+\.\n\n<!-- reviewer:fixed=(\d+) -->$/;

export async function review(adapters: Adapters, pr: PR, pull: Pull, pushed: boolean, signal: AbortSignal, comment?: number) {
  if (signal.aborted) return;
  try {
    await run(adapters, pr, pull, pushed, signal, comment);
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

async function run({ forgejo, git, claude }: Adapters, pr: PR, { base, head, description }: Pull, pushed: boolean, signal: AbortSignal, comment?: number) {
  try {
    await (comment ? forgejo.reactComment(pr, comment) : forgejo.react(pr));
  } catch (e) {
    console.error("reaction failed:", e);
  }
  const [reviews, notes] = await Promise.all([forgejo.reviews(pr), forgejo.issueComments(pr)]);
  const threads = await inlineComments(forgejo, pr, reviews);
  const mine = pushed ? reviews.filter((r) => r.user === forgejo.login) : [];
  // anchored: the summary is model output and could echo a marker
  const since = mine.map((r) => r.body.match(/<!-- reviewer:sha=(\w+) -->$/)?.[1]).findLast(Boolean);
  const checkout = await git.checkout(pr, base, head, since);
  try {
    const open = checkout.incremental ? openComments(forgejo.login, threads) : [];
    const diff = withoutSkipped(checkout.diff);
    const changed = changedLines(diff);
    const large = changed > largePR;
    console.log(`${key(pr)}: reviewing ${checkout.incremental ? `since ${since}` : "full diff"}, ${changed} changed lines, ${open.length} open comments`);
    const { summary, recommendation, comments: all, addressed } = await claude.review({ ...checkout, diff }, large, open, conversation(description, notes, reviews, threads), signal);
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
  const reviews = await forgejo.reviews(pr);
  const mine = reviews.filter((r) => r.user === forgejo.login);
  // Forgejo files a thread reply under the review that started the thread
  const ours = await inlineComments(forgejo, pr, mine);
  const thread = botThread(forgejo.login, ours, comment.id);
  if (!thread && !mentioned) return console.log(`${key(pr)}: comment ${comment.id} not for the bot, no reply`);
  console.log(`${key(pr)}: replying to comment ${comment.id}${thread ? " in a thread" : ""}`);
  try {
    await forgejo.reactComment(pr, comment.id);
  } catch (e) {
    console.error("reaction failed:", e);
  }
  const [{ base, head, description }, notes, theirs] = await Promise.all([
    forgejo.pull(pr),
    forgejo.issueComments(pr),
    inlineComments(forgejo, pr, reviews.filter((r) => !mine.includes(r))),
  ]);
  const checkout = await git.checkout(pr, base, head);
  try {
    const history = conversation(description, notes, reviews, ours, theirs);
    const { body } = await claude.reply({ ...checkout, diff: withoutSkipped(checkout.diff) }, comment.body, thread, history, forgejo.login);
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

async function inlineComments(forgejo: Forgejo, pr: PR, reviews: { id: number }[]) {
  return (await Promise.all(reviews.map((r) => forgejo.comments(pr, r.id)))).flat();
}

function conversation(description: Note, ...notes: Note[][]) {
  return [description, ...notes.flat()].filter((n) => n.body).sort((a, b) => a.at.localeCompare(b.at));
}

function openComments(login: string, all: BotComment[]) {
  const bot = all.filter((c) => c.user === login);
  const fixed = new Set(bot.map((c) => Number(c.body.match(fixReply)?.[1])));
  return bot.filter((c) => !c.resolved && !fixed.has(c.id) && !fixReply.test(c.body) && !all.some((o) => o.id < c.id && sameThread(o, c)));
}

function botThread(login: string, comments: BotComment[], id: number): Thread | undefined {
  const comment = comments.find((c) => c.id === id);
  if (!comment) return;
  const [first, ...rest] = comments.filter((c) => c.id < id && sameThread(c, comment)).sort((a, b) => a.id - b.id);
  return first?.user === login ? [first, ...rest] : undefined;
}

function sameThread(a: BotComment, b: BotComment) {
  return a.review === b.review && a.path === b.path && a.line === b.line && a.side === b.side;
}
