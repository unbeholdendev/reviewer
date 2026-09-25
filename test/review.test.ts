import { expect, test } from "bun:test";
import { send, setup } from "./harness";
import opened from "./fixtures/pull_request.opened.json";

const review = { summary: "Adds a signed webhook route.", recommendation: "nits" };
const pr = { owner: "pycan", repo: "reviewer", number: 27 };
const checkout = { dir: "/wt", diff: "", log: "" };

test("an opened PR gets a COMMENT review with the summary and recommendation", async () => {
  const { app, calls } = setup({ "claude.review": review });
  await send(app, "pull_request", opened);
  await app.idle();
  expect(calls.filter((c) => c.adapter === "forgejo")).toEqual([
    {
      adapter: "forgejo",
      method: "createReview",
      args: [pr, { event: "COMMENT", body: "**Recommendation:** nits\n\nAdds a signed webhook route." }],
    },
  ]);
});

test("a reopened PR gets a review", async () => {
  const { app, calls } = setup({ "claude.review": review });
  await send(app, "pull_request", { ...opened, action: "reopened" });
  await app.idle();
  expect(calls.filter((c) => c.adapter === "forgejo")).toHaveLength(1);
});

test("other PR actions and other events run no job", async () => {
  const { app, calls } = setup({ "claude.review": review });
  await send(app, "pull_request", { ...opened, action: "closed" });
  await send(app, "issues", opened);
  await app.idle();
  expect(calls).toEqual([]);
});

test("the review runs in a checkout of the PR head, removed afterwards", async () => {
  const { app, calls } = setup({ "git.checkout": checkout, "claude.review": review });
  await send(app, "pull_request", opened);
  await app.idle();
  expect(calls.filter((c) => c.adapter !== "forgejo")).toEqual([
    { adapter: "git", method: "checkout", args: [pr, opened.pull_request.base.sha, opened.pull_request.head.sha] },
    { adapter: "claude", method: "review", args: [pr, checkout] },
    { adapter: "git", method: "remove", args: [checkout] },
  ]);
});

test("the checkout is removed when the review fails", async () => {
  const { app, calls } = setup({
    "git.checkout": checkout,
    "claude.review": () => Promise.reject(new Error("claude failed")),
  });
  await send(app, "pull_request", opened);
  await app.idle().catch(() => {});
  expect(calls.at(-1)).toEqual({ adapter: "git", method: "remove", args: [checkout] });
});

test("a PR payload that fails validation runs no job", async () => {
  const { app, calls } = setup({ "claude.review": review });
  await send(app, "pull_request", { ...opened, repository: { name: "reviewer" } });
  await app.idle();
  expect(calls).toEqual([]);
});
