import { expect, test } from "bun:test";
import { send, setup } from "./harness";
import opened from "./fixtures/pull_request.opened.json";

const review = { summary: "Adds a signed webhook route.", recommendation: "nits" };
const pr = { owner: "pycan", repo: "reviewer", number: 27 };

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

test("a PR payload that fails validation runs no job", async () => {
  const { app, calls } = setup({ "claude.review": review });
  await send(app, "pull_request", { ...opened, repository: { name: "reviewer" } });
  await app.idle();
  expect(calls).toEqual([]);
});
