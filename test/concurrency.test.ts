import { expect, test } from "bun:test";
import { send, setup } from "./harness";
import { CONCURRENCY } from "../src/env";
import opened from "./fixtures/pull_request.opened.json";

test("at most CONCURRENCY jobs run at once under a burst of webhooks", async () => {
  let running = 0, peak = 0;
  const release: (() => void)[] = [];
  const { app, calls } = setup({
    "git.checkout": () => {
      peak = Math.max(peak, ++running);
      return new Promise((r) => release.push(() => r({ dir: "/wt", diff: "", log: "", rules: "" })));
    },
    "git.remove": () => void running--,
    "claude.review": { summary: "", recommendation: "looks-good", comments: [] },
  });
  await Promise.all(Array.from({ length: 5 }, () => send(app, "pull_request", opened)));
  const done = app.idle();
  while (calls.filter((c) => c.method === "createReview").length < 5) {
    await Bun.sleep(1);
    release.shift()?.();
  }
  await done;
  expect(peak).toBe(CONCURRENCY);
});
