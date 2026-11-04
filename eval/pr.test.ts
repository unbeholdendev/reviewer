import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Checkout, Note, Review } from "../src/types";
import { reviewPull } from "./pr";

const clone = await mkdtemp(join(tmpdir(), "reviewer-eval-pr-"));
const result: Review = { summary: "Fine.", recommendation: "looks-good", comments: [], addressed: [] };
const signal = new AbortController().signal;

function git(...args: string[]) {
  const { exitCode, stdout, stderr } = Bun.spawnSync([
    "git", "-C", clone, "-c", "user.name=Author", "-c", "user.email=author@example.invalid", "-c", "commit.gpgsign=false", ...args,
  ]);
  if (exitCode) throw new Error(stderr.toString());
  return stdout.toString().trim();
}

async function commit(files: Record<string, string>, message: string) {
  for (const [path, text] of Object.entries(files)) await Bun.write(join(clone, path), text);
  git("add", ".");
  git("commit", "-m", message);
  return git("rev-parse", "HEAD");
}

git("init", "-b", "main");
const base = await commit({ "AGENTS.md": "base rules\n", "code.ts": "old\n" }, "Start");
git("checkout", "-b", "feature");
const head = await commit({ "AGENTS.md": "head rules\n", "code.ts": "new\n", "bun.lock": "locked\n" }, "Change code");
git("checkout", "main");
const moved = await commit({ "other.ts": "unrelated base change\n" }, "Move main");

afterAll(() => rm(clone, { recursive: true, force: true }));

test("reviews the PR's own changes on a checkout of its head, with rules from the base", async () => {
  let seen: { checkout: Checkout; large: boolean; conversation: Note[]; code: string } | undefined;
  const { review, changed } = await reviewPull({
    review: async (checkout, large, _open, conversation) => {
      seen = { checkout, large, conversation, code: await Bun.file(join(checkout.dir, "code.ts")).text() };
      return result;
    },
  }, { clone, base: moved, head, description: "The goal." }, signal);
  expect(review).toEqual(result);
  expect(seen!.code).toBe("new\n");
  expect(seen!.large).toBe(false);
  expect(seen!.checkout.diff).toContain("+new");
  expect(seen!.checkout.diff).not.toContain("other.ts");
  expect(seen!.checkout.diff).not.toContain("bun.lock");
  expect(changed).toBe(4);
  expect(seen!.checkout.log).toContain("Change code");
  expect(seen!.checkout.log).not.toContain("Move main");
  expect(seen!.checkout.rules).toBe("### AGENTS.md\n\nbase rules\n");
  expect(seen!.conversation.map((n) => n.body)).toEqual(["The goal."]);
  expect(existsSync(seen!.checkout.dir)).toBe(false);
  expect(git("worktree", "list")).not.toContain(seen!.checkout.dir);
});

test("sends no conversation without a description", async () => {
  await reviewPull({
    review: async (_checkout, _large, _open, conversation) => {
      expect(conversation).toEqual([]);
      return result;
    },
  }, { clone, base, head }, signal);
});

test("removes the checkout when the review fails", async () => {
  let dir = "";
  await expect(reviewPull({
    review: async (checkout) => {
      dir = checkout.dir;
      throw new Error("model failed");
    },
  }, { clone, base, head }, signal)).rejects.toThrow("model failed");
  expect(existsSync(dir)).toBe(false);
  expect(git("worktree", "list")).not.toContain(dir);
});

test("a failing post-checkout hook in the clone does not run or leave a checkout", async () => {
  const hook = join(clone, ".git/hooks/post-checkout");
  await Bun.write(hook, "#!/bin/sh\nexit 1\n");
  await chmod(hook, 0o755);
  try {
    let dir = "";
    await reviewPull({
      review: async (checkout) => {
        dir = checkout.dir;
        return result;
      },
    }, { clone, base, head }, signal);
    expect(existsSync(dir)).toBe(false);
    expect(git("worktree", "list")).not.toContain("reviewer-eval/");
  } finally {
    await rm(hook);
  }
});
