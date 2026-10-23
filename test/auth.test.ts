import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./test-env";

const agentURL = new URL("../src/agent.ts", import.meta.url).href;

async function run(dir: string, script: string) {
  const env: Record<string, string | undefined> = { ...process.env, PI_AUTH_FILE: join(dir, "auth.json") };
  delete env.PI_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.PI_MODEL;
  const proc = Bun.spawn([process.execPath, "-e", script], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { stdout, stderr, code };
}

test("subscription credentials refresh once for concurrent reviews and survive a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reviewer-auth-test-"));
  try {
    const auth = join(dir, "auth.json");
    await Bun.write(auth, JSON.stringify({ openai: { type: "oauth", access: "expired", refresh: "old-refresh", expires: 0 } }));
    const script = `
      import { spyOn } from "bun:test";
      import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
      import { ModelRuntime } from "@earendil-works/pi-coding-agent";
      const faux = fauxProvider({ provider: "openai", models: [{id: "gpt-6.1-sol"}] });
      let refreshes = 0;
      const create = ModelRuntime.create.bind(ModelRuntime);
      const spy = spyOn(ModelRuntime, "create").mockImplementation(async options => {
        if (options.credentials !== undefined || options.authPath !== process.env.PI_AUTH_FILE || options.modelsPath !== null) throw new Error("Wrong storage configuration");
        const runtime = await create(options);
        runtime.registerNativeProvider({ ...faux.provider, auth: { oauth: {
          name: "Test subscription", isSubscription: true,
          login: async () => { throw new Error("Unexpected login"); },
          refresh: async credential => {
            refreshes++;
            if (credential.refresh !== "old-refresh") throw new Error("Wrong refresh token");
            await Bun.sleep(20);
            return { ...credential, access: "new-access", refresh: "new-refresh", expires: Date.now() + 3_600_000 };
          },
          toAuth: async credential => ({ apiKey: credential.access }),
        } } });
        return runtime;
      });
      const { agent } = await import(${JSON.stringify(agentURL)});
      spy.mockRestore();
      faux.setResponses([1, 2].map(() => (_context, options) => {
        if (options.apiKey !== "new-access") throw new Error("Refreshed credential was not used");
        return fauxAssistantMessage('{"body":"Working."}');
      }));
      const checkout = {dir: ${JSON.stringify(dir)}, diff:"", log:"", rules:""};
      const results = await Promise.all([1, 2].map(() => agent.reply(checkout, "Why?", undefined, [], "bot")));
      console.log(JSON.stringify({refreshes, results}));
    `;
    for (const refreshes of [1, 0]) {
      const result = await run(dir, script);
      expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toEqual({ refreshes, results: [{ body: "Working." }, { body: "Working." }] });
      expect((await Bun.file(auth).json()).openai).toMatchObject({ type: "oauth", access: "new-access", refresh: "new-refresh" });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing subscription login gives a setup error without making model requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reviewer-auth-missing-"));
  try {
    const result = await run(dir, `await import(${JSON.stringify(agentURL)});`);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("No Pi subscription login for openai");
    expect(result.stderr).toContain("subscription setup");
    expect((await stat(join(dir, "auth.json"))).mode & 0o777).toBe(0o600);
    const ambientKey = await run(dir, `process.env.OPENAI_API_KEY = "unintended-api-key"; await import(${JSON.stringify(agentURL)});`);
    expect(ambientKey.code).not.toBe(0);
    expect(ambientKey.stderr).toContain("No Pi subscription login for openai");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
