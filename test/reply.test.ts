import { expect, test } from "bun:test";
import { send, setup } from "./harness";

const pr = { owner: "unbeholden", repo: "reviewer", number: 27 };
const checkout = { dir: "/wt", diff: "diff --git a/x b/x\n", log: "", rules: "" };
const shas = { base: "b".repeat(40), head: "c".repeat(40) };
const mention = {
  action: "created",
  is_pull: true,
  issue: { number: 27, pull_request: {} },
  comment: { id: 99, body: "@reviewer-bot why is this safe?", user: { login: "alice" } },
  repository: { name: "reviewer", owner: { login: "unbeholden" } },
  sender: { login: "alice" },
};
const returns = { "forgejo.reviews": [], "forgejo.pull": shas, "git.checkout": checkout, "claude.reply": { body: "Because." } };

test("a PR comment mentioning the bot gets 👀, then a reply from the diff and comment", async () => {
  const { app, calls } = setup(returns);
  await send(app, "issue_comment", mention);
  await app.idle();
  expect(calls).toEqual([
    { adapter: "forgejo", method: "reviews", args: [pr] },
    { adapter: "forgejo", method: "reactComment", args: [pr, 99] },
    { adapter: "forgejo", method: "pull", args: [pr] },
    { adapter: "git", method: "checkout", args: [pr, shas.base, shas.head] },
    { adapter: "claude", method: "reply", args: [checkout, mention.comment.body, undefined] },
    { adapter: "forgejo", method: "comment", args: [pr, "Because."] },
    { adapter: "git", method: "remove", args: [checkout] },
  ]);
});

test("a mention ending a sentence counts", async () => {
  const { app, calls } = setup(returns);
  await send(app, "issue_comment", { ...mention, comment: { ...mention.comment, body: "Over to you, @Reviewer-Bot." } });
  await app.idle();
  expect(calls.filter((c) => c.method === "comment")).toHaveLength(1);
});

test("a failed reaction doesn't stop the reply", async () => {
  const { app, calls } = setup({ ...returns, "forgejo.reactComment": () => Promise.reject(new Error("403")) });
  await send(app, "issue_comment", mention);
  await app.idle();
  expect(calls.filter((c) => c.method === "comment")).toHaveLength(1);
});

test("comments that don't mention the bot, edits, and issue comments are ignored", async () => {
  const { app, calls } = setup(returns);
  await send(app, "issue_comment", { ...mention, comment: { ...mention.comment, body: "looks fine" } });
  await send(app, "issue_comment", { ...mention, comment: { ...mention.comment, body: "cc @reviewer-botany" } });
  await send(app, "issue_comment", { ...mention, action: "edited" });
  await send(app, "issue_comment", { ...mention, is_pull: false, issue: { number: 27, pull_request: null } });
  await app.idle();
  expect(calls.filter((c) => !["reviews", "comments"].includes(c.method))).toEqual([]);
});

const botComment = (id: number, user: string, body: string) => ({ id, review: 5, user, path: "src/x.ts", line: 3, side: "RIGHT", body, resolved: false });
const thread = [botComment(10, "reviewer-bot", "**nit:** rename this"), botComment(11, "alice", "to what?"), botComment(12, "bob", "elsewhere")];
const threadReturns = {
  ...returns,
  "forgejo.reviews": [{ id: 4, user: "alice", body: "" }, { id: 5, user: "reviewer-bot", body: "" }],
  "forgejo.comments": (_: unknown, review: number) => (review === 5 ? [...thread, { ...botComment(13, "bob", "other line"), line: 9 }] : []),
};
const threadReply = { ...mention, comment: { ...mention.comment, id: 11, body: "to what?" } };
const writes = <T extends { adapter: string; method: string }>(calls: T[]) => calls.filter((c) => c.adapter !== "forgejo" || ["reactComment", "reply", "comment"].includes(c.method));

test("a reply in a bot thread gets 👀, then an answer in that thread with the history", async () => {
  const { app, calls } = setup(threadReturns);
  await send(app, "issue_comment", threadReply);
  await app.idle();
  expect(writes(calls)).toEqual([
    { adapter: "forgejo", method: "reactComment", args: [pr, 11] },
    { adapter: "git", method: "checkout", args: [pr, shas.base, shas.head] },
    { adapter: "claude", method: "reply", args: [checkout, "to what?", [thread[0]]] },
    { adapter: "forgejo", method: "reply", args: [pr, thread[0], "Because."] },
    { adapter: "git", method: "remove", args: [checkout] },
  ]);
});

test("a mention in a bot thread is answered in the thread", async () => {
  const { app, calls } = setup(threadReturns);
  await send(app, "issue_comment", { ...threadReply, comment: { ...threadReply.comment, body: "@reviewer-bot to what?" } });
  await app.idle();
  expect(calls.filter((c) => c.method === "comment")).toEqual([]);
  expect(calls.filter((c) => c.method === "reply").map((c) => c.adapter)).toEqual(["claude", "forgejo"]);
});

test("replies in threads the bot didn't start are ignored", async () => {
  const { app, calls } = setup({
    ...threadReturns,
    "forgejo.comments": (_: unknown, review: number) => (review === 4 ? [botComment(20, "alice", "hm"), botComment(21, "bob", "yes")] : []),
  });
  await send(app, "issue_comment", { ...threadReply, comment: { ...threadReply.comment, id: 21 } });
  await app.idle();
  expect(writes(calls)).toEqual([]);
});

const review = { summary: "Fine.", recommendation: "looks-good", comments: [], addressed: [] };
const again = (body: string) => ({ ...mention, comment: { ...mention.comment, body } });

test("\"@bot review again\" gets 👀 and a full base..head review, ignoring the SHA marker", async () => {
  const { app, calls } = setup({ ...returns, "claude.review": review });
  await send(app, "issue_comment", again("@reviewer-bot, review again"));
  await app.idle();
  expect(calls.filter((c) => c.method !== "createReview")).toEqual([
    { adapter: "forgejo", method: "pull", args: [pr] },
    { adapter: "forgejo", method: "reactComment", args: [pr, 99] },
    { adapter: "git", method: "checkout", args: [pr, shas.base, shas.head, undefined] },
    { adapter: "claude", method: "review", args: [checkout, false, [], expect.any(AbortSignal)] },
    { adapter: "git", method: "remove", args: [checkout] },
  ]);
  expect(calls.filter((c) => c.method === "createReview")).toHaveLength(1);
});

test("text after \"review again\" is also answered as a question", async () => {
  const { app, calls } = setup({ ...returns, "claude.review": review });
  const body = "@Reviewer-Bot review again, and why is this safe?";
  await send(app, "issue_comment", again(body));
  await app.idle();
  expect(calls.filter((c) => c.adapter === "claude").map((c) => [c.method, c.args[1]])).toEqual([["review", false], ["reply", body]]);
  expect(calls.filter((c) => c.method === "comment")).toEqual([{ adapter: "forgejo", method: "comment", args: [pr, "Because."] }]);
});

test("\"review again\" without the mention is not a command", async () => {
  const { app, calls } = setup({ ...returns, "claude.review": review });
  await send(app, "issue_comment", again("please review again"));
  await app.idle();
  expect(writes(calls)).toEqual([]);
});
