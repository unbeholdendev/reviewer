import { expect, test } from "bun:test";
import "./harness";

function start(change: Record<string, string | undefined>) {
  const env = { ...process.env, ...change };
  for (const name in change) if (change[name] === undefined) delete env[name];
  const { exitCode, stderr } = Bun.spawnSync(["bun", "src/env.ts"], { env });
  return { exitCode, stderr: stderr.toString() };
}

test("startup succeeds with a full env", () => {
  expect(start({}).exitCode).toBe(0);
});

test("startup fails naming every missing env variable", () => {
  const { exitCode, stderr } = start({ FORGEJO_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("FORGEJO_TOKEN");
  expect(stderr).toContain("CLAUDE_CODE_OAUTH_TOKEN");
});

test("startup fails on a CONCURRENCY that is not a positive whole number", () => {
  for (const CONCURRENCY of ["abc", "0", "1.5"]) {
    const { exitCode, stderr } = start({ CONCURRENCY });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("CONCURRENCY");
  }
});
