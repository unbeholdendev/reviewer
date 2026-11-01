import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./test-env";

const loginURL = new URL("../src/login.ts", import.meta.url).href;
const deployPath = new URL("../deploy.sh", import.meta.url).pathname;
const script = `
  import { spyOn } from "bun:test";
  import { fauxProvider } from "@earendil-works/pi-ai";
  import { ModelRuntime } from "@earendil-works/pi-coding-agent";
  if (process.env.TEST_TTY) {
    Object.defineProperty(process.stdin, "isTTY", {value:true});
    Object.defineProperty(process.stdout, "isTTY", {value:true});
  }
  const create = ModelRuntime.create.bind(ModelRuntime);
  const faux = fauxProvider({provider:"openai", models:[{id:"gpt-6.1-sol"}]});
  spyOn(ModelRuntime, "create").mockImplementation(async options => {
    const runtime = await create(options);
    runtime.registerNativeProvider({...faux.provider, auth:{oauth:{
      name:"Test subscription", isSubscription:true,
      async login(interaction, options) {
        interaction.notify({type:"auth_url",url:"https://example.test/login",instructions:"Sign in"});
        const code = await interaction.prompt({type:"manual_code",message:"Paste redirect URL:"});
        if (code.trim() !== "approved") throw new Error("Login cancelled");
        return {type:"oauth",access:"new-access",refresh:"new-refresh",expires:Date.now()+3_600_000,deviceId:options.getDeviceId()};
      },
      async refresh(credential) {
        if (credential.refresh === "revoked") throw new Error("Revoked");
        return {...credential,access:"new-access",refresh:"new-refresh",expires:Date.now()+3_600_000};
      },
      toAuth:async credential => ({apiKey:credential.access}),
    }}});
    return runtime;
  });
  await import(${JSON.stringify(loginURL)});
`;

async function login(dir: string, input?: string, key = "") {
  const env = { ...process.env, PI_MODEL: "openai/gpt-6.1-sol", PI_AUTH_FILE: join(dir, "auth.json"), PI_API_KEY: key, TEST_TTY: input === undefined ? "" : "1" };
  const proc = Bun.spawn([process.execPath, "-e", script], {
    env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  if (input !== undefined) proc.stdin.write(input);
  const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { stdout, stderr, code };
}

const credential = (expires: number, refresh = "old-refresh") => ({ openai: { type: "oauth", access: "old-access", refresh, expires } });

test("deployment reuses saved credentials and refreshes expired ones without a terminal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reviewer-login-saved-"));
  try {
    for (const expires of [Date.now() + 3_600_000, 0]) {
      await Bun.write(join(dir, "auth.json"), JSON.stringify(credential(expires)));
      const result = await login(dir);
      expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
      expect(result.stdout).toContain("Saved openai login is ready");
      expect((await Bun.file(join(dir, "auth.json")).json()).openai.access).toBe(expires ? "old-access" : "new-access");
      expect(await Bun.file(join(dir, "device-id")).exists()).toBe(false);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("deployment prompts for missing or revoked logins and keeps the installation ID", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reviewer-login-new-"));
  try {
    const first = await login(dir, "approved\n");
    expect({ code: first.code, stderr: first.stderr }).toEqual({ code: 0, stderr: "" });
    expect(first.stdout).toContain("https://example.test/login");
    expect(first.stdout).toContain("Saved openai subscription login");
    expect(first.stdout).not.toContain("new-refresh");
    const id = await Bun.file(join(dir, "device-id")).text();
    expect((await Bun.file(join(dir, "auth.json")).json()).openai.deviceId).toBe(id);
    await Bun.write(join(dir, "auth.json"), JSON.stringify(credential(0, "revoked")));
    const second = await login(dir, "approved\n");
    expect({ code: second.code, stderr: second.stderr }).toEqual({ code: 0, stderr: "" });
    expect(second.stdout).toContain("sign in again");
    expect((await Bun.file(join(dir, "auth.json")).json()).openai.deviceId).toBe(id);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a missing login fails clearly without a terminal, and a cancelled login fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reviewer-login-failed-"));
  try {
    const missing = await login(dir);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("interactive terminal");
    const cancelled = await login(dir, "cancel\n");
    expect(cancelled.code).not.toBe(0);
    expect(cancelled.stderr).toContain("Login cancelled");
    expect((await Bun.file(join(dir, "auth.json")).json()).openai).toBeUndefined();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an explicit API key skips subscription setup and does not create credential files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reviewer-login-key-"));
  try {
    const result = await login(dir, undefined, "model-key");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("skipping subscription login");
    expect(await Bun.file(join(dir, "auth.json")).exists()).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("deployment pulls or builds, checks login, then starts; failures never start the service", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reviewer-deploy-test-"));
  try {
    await Bun.write(join(dir, "deploy.sh"), await Bun.file(deployPath).text());
    await Bun.write(join(dir, "docker"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\nif [ "$*" = "$FAIL_COMMAND" ]; then exit 17; fi\n');
    await chmod(join(dir, "docker"), 0o755);
    const calls = ["compose pull --ignore-buildable reviewer", "compose build reviewer", "compose run --rm reviewer bun src/login.ts", "compose up -d"];
    for (const fail of ["", calls[0]!, calls[1]!, calls[2]!]) {
      await Bun.write(join(dir, "calls"), "");
      const proc = Bun.spawn(["sh", join(dir, "deploy.sh")], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: join(dir, "calls"), FAIL_COMMAND: fail } });
      expect(await proc.exited).toBe(fail ? 17 : 0);
      expect((await Bun.file(join(dir, "calls")).text()).trim().split("\n")).toEqual(fail ? calls.slice(0, calls.indexOf(fail) + 1) : calls);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
