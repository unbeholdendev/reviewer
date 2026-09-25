import { expect, test } from "bun:test";
import { send, setup } from "./harness";
import opened from "./fixtures/pull_request.opened.json";

const review = { summary: "Adds a signed webhook route.", recommendation: "nits", comments: [] };
const pr = { owner: "pycan", repo: "reviewer", number: 27 };
const checkout = { dir: "/wt", diff: "", log: "", rules: "" };

test("an opened PR gets a COMMENT review with the summary and recommendation", async () => {
  const { app, calls } = setup({ "git.checkout": checkout, "claude.review": review });
  await send(app, "pull_request", opened);
  await app.idle();
  expect(calls.filter((c) => c.adapter === "forgejo")).toEqual([
    {
      adapter: "forgejo",
      method: "createReview",
      args: [pr, { event: "COMMENT", body: "**Recommendation:** nits\n\nAdds a signed webhook route.", comments: [] }],
    },
  ]);
});

test("a reopened PR gets a review", async () => {
  const { app, calls } = setup({ "git.checkout": checkout, "claude.review": review });
  await send(app, "pull_request", { ...opened, action: "reopened" });
  await app.idle();
  expect(calls.filter((c) => c.adapter === "forgejo")).toHaveLength(1);
});

test("other PR actions and other events run no job", async () => {
  const { app, calls } = setup({ "git.checkout": checkout, "claude.review": review });
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

test("comments on diff lines go inline, others move into the summary", async () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,3 @@ fn",
    " keep",
    "-old",
    "+new",
    " keep",
  ].join("\n");
  const comments = [
    { path: "src/a.ts", line: 11, side: "RIGHT", body: "Null here.", severity: "blocking" },
    { path: "src/a.ts", line: 11, side: "LEFT", body: "Was fine.", severity: "nit" },
    { path: "src/a.ts", line: 12, side: "RIGHT", body: "Context line.", severity: "nit" },
    { path: "src/a.ts", line: 40, side: "RIGHT", body: "Far away.", severity: "nit" },
    { path: "src/b.ts", line: 1, side: "RIGHT", body: "Not in diff.", severity: "blocking" },
  ];
  const { app, calls } = setup({ "git.checkout": { ...checkout, diff }, "claude.review": { ...review, comments } });
  await send(app, "pull_request", opened);
  await app.idle();
  expect(calls.find((c) => c.adapter === "forgejo")?.args[1]).toEqual({
    event: "COMMENT",
    body: [
      "**Recommendation:** nits\n\nAdds a signed webhook route.",
      "**Outside the diff:**\n\n- `src/a.ts:40` **nit:** Far away.\n- `src/b.ts:1` **blocking:** Not in diff.",
    ].join("\n\n"),
    comments: [
      { path: "src/a.ts", new_position: 11, body: "**blocking:** Null here." },
      { path: "src/a.ts", old_position: 11, body: "**nit:** Was fine." },
      { path: "src/a.ts", new_position: 12, body: "**nit:** Context line." },
    ],
  });
});

test("lockfiles and vendored files are not reviewed and get no comments", async () => {
  const section = (path: string) =>
    [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", "-old", "+new"].join("\n");
  const kept = section("src/a.ts");
  const diff = [
    section("bun.lock"),
    kept,
    section("web/package-lock.json"),
    section("yarn.lock"),
    section("pnpm-lock.yaml"),
    section("Cargo.lock"),
    section("go.sum"),
    section("vendor/lib/x.go"),
    section("web/node_modules/y/index.js"),
    'diff --git "a/caf\\303\\251/yarn.lock" "b/caf\\303\\251/yarn.lock"\n@@ -1 +1 @@\n-old\n+new',
  ].join("\n");
  const comments = [
    { path: "src/a.ts", line: 1, side: "RIGHT", body: "Real.", severity: "nit" },
    { path: "bun.lock", line: 1, side: "RIGHT", body: "Lock.", severity: "nit" },
    { path: "vendor/lib/x.go", line: 1, side: "RIGHT", body: "Vendored.", severity: "nit" },
  ];
  const { app, calls } = setup({ "git.checkout": { ...checkout, diff }, "claude.review": { ...review, comments } });
  await send(app, "pull_request", opened);
  await app.idle();
  expect(calls.find((c) => c.adapter === "claude")?.args[1]).toEqual({ ...checkout, diff: `${kept}\n` });
  expect(calls.find((c) => c.adapter === "forgejo")?.args[1]).toEqual({
    event: "COMMENT",
    body: "**Recommendation:** nits\n\nAdds a signed webhook route.",
    comments: [{ path: "src/a.ts", new_position: 1, body: "**nit:** Real." }],
  });
});

test("a PR payload that fails validation runs no job", async () => {
  const { app, calls } = setup({ "git.checkout": checkout, "claude.review": review });
  await send(app, "pull_request", { ...opened, repository: { name: "reviewer" } });
  await app.idle();
  expect(calls).toEqual([]);
});
