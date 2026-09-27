import { expect, test } from "bun:test";
import { send, setup } from "./harness";

const pr = { owner: "pycan", repo: "reviewer", number: 27 };
const checkout = { dir: "/wt", diff: "diff --git a/x b/x\n", log: "", rules: "" };
const shas = { base: "b".repeat(40), head: "c".repeat(40) };
const mention = {
  action: "created",
  is_pull: true,
  issue: { number: 27, pull_request: {} },
  comment: { id: 99, body: "@reviewer-bot why is this safe?", user: { login: "alice" } },
  repository: { name: "reviewer", owner: { login: "pycan" } },
  sender: { login: "alice" },
};
const returns = { "forgejo.pull": shas, "git.checkout": checkout, "claude.reply": { body: "Because." } };

test("a PR comment mentioning the bot gets 👀, then a reply from the diff and comment", async () => {
  const { app, calls } = setup(returns);
  await send(app, "issue_comment", mention);
  await app.idle();
  expect(calls).toEqual([
    { adapter: "forgejo", method: "reactComment", args: [pr, 99] },
    { adapter: "forgejo", method: "pull", args: [pr] },
    { adapter: "git", method: "checkout", args: [pr, shas.base, shas.head] },
    { adapter: "claude", method: "reply", args: [checkout, mention.comment.body] },
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
  expect(calls).toEqual([]);
});
