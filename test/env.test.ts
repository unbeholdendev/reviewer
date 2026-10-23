import { expect, test } from "bun:test";
import "./harness";

function start(change: Record<string, string | undefined>) {
  const env = { ...process.env, ...change };
  for (const name in change) if (change[name] === undefined) delete env[name];
  const { exitCode, stdout, stderr } = Bun.spawnSync(["bun", "-e", 'import { PI_MODEL } from "./src/env"; console.log(PI_MODEL);'], { env });
  return { exitCode, stdout: stdout.toString(), stderr: stderr.toString() };
}

test("startup succeeds with a full env", () => {
  expect(start({}).exitCode).toBe(0);
});

test("startup fails naming every missing env variable", () => {
  const { exitCode, stderr } = start({ FORGEJO_TOKEN: undefined, PI_MODEL: undefined, PI_API_KEY: undefined });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("FORGEJO_TOKEN");
});

test("the default model is GPT-6.1 SOL", () => {
  const { exitCode, stdout } = start({ PI_MODEL: undefined });
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe("openai/gpt-6.1-sol");
});

test("subscription settings accept an unset or empty API key", () => {
  expect(start({ PI_API_KEY: undefined }).exitCode).toBe(0);
  expect(start({ PI_API_KEY: "" }).exitCode).toBe(0);
});

test("startup requires a provider-qualified model and a nonempty credential path", () => {
  expect(start({ PI_MODEL: "gpt-5.4" }).exitCode).not.toBe(0);
  expect(start({ PI_MODEL: "openai/" }).exitCode).not.toBe(0);
  expect(start({ PI_AUTH_FILE: "" }).exitCode).not.toBe(0);
});

test("startup fails on a CONCURRENCY that is not a positive whole number", () => {
  for (const CONCURRENCY of ["abc", "0", "1.5"]) {
    const { exitCode, stderr } = start({ CONCURRENCY });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("CONCURRENCY");
  }
});
