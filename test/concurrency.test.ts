import { expect, test } from "bun:test";
import { send, setup } from "./harness";
import { CONCURRENCY } from "../src/env";
import opened from "./fixtures/pull_request.opened.json";

const checkout = { dir: "/wt", diff: "", log: "", rules: "" };
const review = { summary: "", recommendation: "looks-good", comments: [], addressed: [] };

test("at most CONCURRENCY jobs run at once under a burst of webhooks", async () => {
  let running = 0, peak = 0;
  const release: (() => void)[] = [];
  const { app, calls } = setup({
    "git.checkout": () => {
      peak = Math.max(peak, ++running);
      return new Promise((r) => release.push(() => r(checkout)));
    },
    "git.remove": () => void running--,
    "claude.review": review,
  });
  await Promise.all(Array.from({ length: 5 }, (_, i) => send(app, "pull_request", { ...opened, number: i })));
  const done = app.idle();
  while (calls.filter((c) => c.method === "createReview").length < 5) {
    await Bun.sleep(1);
    release.shift()?.();
  }
  await done;
  expect(peak).toBe(CONCURRENCY);
});

test("jobs on one PR never overlap", async () => {
  let running = 0, peak = 0;
  const { app } = setup({
    "git.checkout": async () => {
      peak = Math.max(peak, ++running);
      await Bun.sleep(5);
      return checkout;
    },
    "git.remove": () => void running--,
    "claude.review": review,
  });
  await send(app, "pull_request", opened);
  await send(app, "pull_request", { ...opened, action: "reopened" });
  await app.idle();
  expect(peak).toBe(1);
});

const push = (sha: string) => ({ ...opened, action: "synchronized", pull_request: { ...opened.pull_request, head: { sha } } });

test("a push aborts every review of that PR, not only the last one queued", async () => {
  let release = () => {};
  const { app, calls } = setup({
    "git.checkout": checkout,
    "forgejo.reviews": [],
    "claude.review": () => new Promise((r) => (release = () => r(review))),
  });
  await send(app, "pull_request", opened);
  while (!calls.some((c) => c.method === "review")) await Bun.sleep(1);
  await send(app, "pull_request", { ...opened, action: "reopened" });
  await send(app, "pull_request", push("ccc"));
  release();
  while (calls.filter((c) => c.method === "review").length < 2) await Bun.sleep(1);
  release();
  await app.idle();
  expect(calls.filter((c) => c.method === "checkout").map((c) => c.args[2])).toEqual([opened.pull_request.head.sha, "ccc"]);
  expect(calls.filter((c) => c.method === "createReview")).toHaveLength(1);
});

test("a review killed by a push posts no failure comment", async () => {
  const { app, calls } = setup({
    "git.checkout": checkout,
    "forgejo.reviews": [],
    "claude.review": (_: unknown, __: boolean, ___: unknown, ____: unknown, signal: AbortSignal) =>
      calls.filter((c) => c.method === "review").length > 1 ? review : new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("killed")))),
  });
  await send(app, "pull_request", opened);
  while (!calls.some((c) => c.method === "review")) await Bun.sleep(1);
  await send(app, "pull_request", push("ccc"));
  await app.idle();
  expect(calls.filter((c) => c.method === "comment")).toEqual([]);
  expect(calls.filter((c) => c.method === "createReview")).toHaveLength(1);
});

test("a push aborts the running review, which posts nothing, and only the latest head is reviewed", async () => {
  let release = () => {};
  const signals: AbortSignal[] = [];
  const { app, calls } = setup({
    "git.checkout": checkout,
    "forgejo.reviews": [],
    "claude.review": (_: unknown, __: boolean, ___: unknown, ____: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise((r) => (release = () => r(review)));
    },
  });
  await send(app, "pull_request", push("aaa"));
  while (!signals.length) await Bun.sleep(1);
  await send(app, "pull_request", push("bbb"));
  await send(app, "pull_request", push("ccc"));
  expect(signals[0]?.aborted).toBe(true);
  release();
  while (signals.length < 2) await Bun.sleep(1);
  release();
  await app.idle();
  expect(calls.filter((c) => c.method === "checkout").map((c) => c.args[2])).toEqual(["aaa", "ccc"]);
  expect(calls.filter((c) => c.method === "createReview").map((c) => (c.args[1] as { body: string }).body)).toEqual([
    expect.stringContaining("reviewer:sha=ccc"),
  ]);
});
