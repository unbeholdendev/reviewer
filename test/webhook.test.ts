import { expect, test } from "bun:test";
import { send, setup, sign } from "./harness";
import payload from "./fixtures/pull_request.opened.json";

test("missing signature is rejected and runs no job", async () => {
  const { app, calls } = setup();
  const res = await send(app, "pull_request", payload, null);
  await app.idle();
  expect(res.status).toBe(401);
  expect(calls).toEqual([]);
});

test("wrong signature is rejected and runs no job", async () => {
  const { app, calls } = setup();
  const res = await send(app, "pull_request", payload, sign("something else"));
  await app.idle();
  expect(res.status).toBe(401);
  expect(calls).toEqual([]);
});

test("valid signature is accepted", async () => {
  const { app } = setup({ "git.checkout": { diff: "" }, "agent.review": { summary: "", recommendation: "looks-good", comments: [] } });
  const res = await send(app, "pull_request", payload);
  expect(res.status).toBe(200);
  await app.idle();
});

test("valid signature with trailing junk is rejected", async () => {
  const { app } = setup();
  const res = await send(app, "pull_request", payload, sign(JSON.stringify(payload)) + "zz");
  expect(res.status).toBe(401);
});
