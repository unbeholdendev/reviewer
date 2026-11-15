import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import "./test-env";

const dir = await mkdtemp(join(tmpdir(), "reviewer-sdk-test-"));
const checkout = { dir, diff: "the diff", log: "the commits", rules: "base rules", incremental: true };
const faux = fauxProvider({ provider: "openai", models: [{ id: "test-model" }] });
const create = ModelRuntime.create.bind(ModelRuntime);
const runtimeSpy = spyOn(ModelRuntime, "create").mockImplementation(async (options) => {
  expect(options?.modelsPath).toBeNull();
  expect(options?.credentials).toBeDefined();
  expect(options?.refreshOnCreate).toBe(false);
  const runtime = await create(options);
  runtime.registerNativeProvider(faux.provider);
  return runtime;
});
const { agent } = await import("../src/agent");
runtimeSpy.mockRestore();
const reply = () => agent.reply(checkout, "Why?", undefined, [], "bot");
const answer = (body = "Because.") => fauxAssistantMessage(JSON.stringify({ body }));

await Bun.write(join(dir, ".pi/settings.json"), '{"extensions":["./attack.ts"]}');
await Bun.write(join(dir, ".pi/attack.ts"), 'throw new Error("untrusted extension loaded")');
await Bun.write(join(dir, "AGENTS.md"), "untrusted head rules");
await Bun.write(join(dir, "code.ts"), "export const value = 42;\n");
await symlink(tmpdir(), join(dir, "escape"));

afterAll(() => rm(dir, { recursive: true, force: true }));

test("SDK replies use only read-only tools and explicitly supplied rules", async () => {
  faux.setResponses([
    (context) => {
      const tools = context.messages.flatMap((m) => (m.role === "system" ? (m.toolsAdded ?? []) : []));
      expect(tools.map((t) => t.name).sort()).toEqual(["find", "grep", "ls", "read"]);
      const text = JSON.stringify(context);
      expect(text).toContain("base rules");
      expect(text).toContain("Why?");
      expect(text).not.toContain("untrusted head rules");
      expect(text).not.toContain(process.env.FORGEJO_TOKEN!);
      expect(text).not.toContain(process.env.PI_API_KEY!);
      return answer();
    },
  ]);
  expect(await reply()).toEqual({ body: "Because." });
});

test("SDK reviews validate JSON and include incremental context and conversation", async () => {
  const review = { summary: "Fine.", recommendation: "looks-good" as const, comments: [], addressed: [] };
  faux.setResponses([
    (context) => {
      const text = JSON.stringify(context);
      expect(text).toContain("new commits only, large PR");
      expect(text).toContain("the diff");
      expect(text).toContain("author context");
      return fauxAssistantMessage(JSON.stringify(review));
    },
  ]);
  expect(
    await agent.review(
      checkout,
      true,
      [],
      [{ user: "alice", body: "author context", at: "now" }],
      new AbortController().signal,
    ),
  ).toEqual(review);
});

test("invalid output is retried once in a fresh session", async () => {
  for (const invalid of ["not JSON", '{"body":42}']) {
    faux.setResponses([
      fauxAssistantMessage(invalid),
      (context) => {
        expect(context.messages.filter((m) => m.role === "user")).toHaveLength(1);
        return answer("Recovered.");
      },
    ]);
    expect(await reply()).toEqual({ body: "Recovered." });
    expect(faux.getPendingResponseCount()).toBe(0);
    faux.setResponses([fauxAssistantMessage(invalid), fauxAssistantMessage(invalid)]);
    await expect(reply()).rejects.toThrow("pi returned no valid output");
    expect(faux.getPendingResponseCount()).toBe(0);
  }
});

test("provider errors and truncated responses fail rather than retry invalid output", async () => {
  for (const stopReason of ["error", "length"] as const) {
    faux.setResponses([
      fauxAssistantMessage('{"body":"partial"}', { stopReason, errorMessage: "provider failed" }),
      answer(),
    ]);
    await expect(reply()).rejects.toThrow("provider failed");
    expect(faux.getPendingResponseCount()).toBe(1);
  }
});

test("read-only tools can inspect files in the checkout", async () => {
  for (const [name, args] of [
    ["read", { path: "code.ts" }],
    ["grep", { pattern: "value" }],
    ["find", { pattern: "*.ts" }],
    ["ls", {}],
  ] as const) {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(name, args)),
      (context) => {
        const result = context.messages.findLast((m) => m.role === "toolResult");
        expect(result?.role === "toolResult" && result.isError).toBe(false);
        expect(JSON.stringify(result)).toContain(name === "read" ? "value = 42" : "code.ts");
        return answer();
      },
    ]);
    await reply();
  }
});

test("all tools reject paths and symlinks that leave the checkout", async () => {
  for (const name of ["read", "grep", "find", "ls"]) {
    for (const path of ["..", tmpdir(), "escape"]) {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall(name, { path, pattern: "*" })),
        (context) => {
          const result = context.messages.findLast((m) => m.role === "toolResult");
          expect(result?.role === "toolResult" && result.isError).toBe(true);
          expect(JSON.stringify(result)).toContain("Path is outside the checkout");
          return answer();
        },
      ]);
      await reply();
    }
  }
});

test("cancellation aborts an active SDK review without retrying", async () => {
  const controller = new AbortController();
  faux.setResponses([
    async (_context, options) => {
      controller.abort();
      if (!options?.signal?.aborted)
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      return fauxAssistantMessage("", { stopReason: "aborted" });
    },
    answer(),
  ]);
  await expect(agent.review(checkout, false, [], [], controller.signal)).rejects.toThrow();
  expect(faux.getPendingResponseCount()).toBe(1);
});

test("the ten-minute limit aborts the SDK session", async () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const timer = spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(20));
  try {
    faux.setResponses([
      async (_context, options) => {
        if (!options?.signal?.aborted)
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        return fauxAssistantMessage("", { stopReason: "aborted" });
      },
      answer(),
    ]);
    await expect(reply()).rejects.toThrow();
    expect(timer).toHaveBeenCalledWith(10 * 60_000);
    expect(faux.getPendingResponseCount()).toBe(1);
  } finally {
    timer.mockRestore();
  }
});

test("an already cancelled review never calls the provider", async () => {
  faux.setResponses([answer()]);
  await expect(agent.review(checkout, false, [], [], AbortSignal.abort())).rejects.toThrow();
  expect(faux.getPendingResponseCount()).toBe(1);
});

test("review and reply prompts are built exactly", async () => {
  const instructions = (name: string) => Bun.file(new URL(`../prompts/${name}.md`, import.meta.url)).text();
  const [reviewInstructions, replyInstructions] = await Promise.all([instructions("review"), instructions("reply")]);
  const conversation = [{ user: "alice", body: "author context", at: "now", path: "a.ts", line: 3 }];
  const open = {
    id: 7,
    review: 1,
    user: "bot",
    path: "a.ts",
    line: 3,
    side: "RIGHT" as const,
    body: "Open.",
    resolved: false,
    at: "now",
  };
  const note = '- {"user":"alice","path":"a.ts","line":3,"body":"author context"}';
  const prompts: string[] = [];
  const capture = (body: string) => (context: { messages: { role: string; content: unknown }[] }) => {
    const user = context.messages.find((m) => m.role === "user");
    const content = user?.content;
    prompts.push(
      typeof content === "string" ? content : (content as { text: string }[]).map((part) => part.text).join(""),
    );
    return fauxAssistantMessage(body);
  };
  const review = { summary: "Fine.", recommendation: "looks-good", comments: [], addressed: [] };
  faux.setResponses([
    capture(JSON.stringify(review)),
    capture(JSON.stringify(review)),
    capture(JSON.stringify({ body: "Because." })),
    capture(JSON.stringify({ body: "Because." })),
  ]);
  const signal = new AbortController().signal;
  await agent.review(checkout, true, [open], conversation, signal);
  await agent.review({ ...checkout, rules: "", incremental: false }, false, [], [], signal);
  await agent.reply(checkout, "Why?", [open], conversation, "bot");
  await agent.reply({ ...checkout, rules: "" }, "Why?", undefined, [], "bot");
  const expected = [
    `${reviewInstructions}\n## Repository rules\n\nbase rules\n\n## Conversation\n\n${note}\n\n## Your open comments\n\n- {"id":7,"path":"a.ts","line":3,"side":"RIGHT","body":"Open."}\n\n## Commits\n\nthe commits\n\n## Diff (new commits only, large PR)\n\nthe diff`,
    `${reviewInstructions}\n## Repository rules\n\nNone.\n\n## Conversation\n\n\n\n## Your open comments\n\nNone.\n\n## Commits\n\nthe commits\n\n## Diff\n\nthe diff`,
    `${replyInstructions}\nYou are @bot. Comments by \`bot\` are yours.\n\n## Repository rules\n\nbase rules\n\n## Conversation\n\n${note}\n\n## Commits\n\nthe commits\n\n## Diff\n\nthe diff\n\n## Thread on \`a.ts:3\`\n\n- {"user":"bot","body":"Open."}\n\n## Comment\n\nWhy?`,
    `${replyInstructions}\nYou are @bot. Comments by \`bot\` are yours.\n\n## Repository rules\n\nNone.\n\n## Conversation\n\n\n\n## Commits\n\nthe commits\n\n## Diff\n\nthe diff\n\n## Comment\n\nWhy?`,
  ];
  expect(prompts.map((p) => p.slice(0, p.lastIndexOf("\n\nReturn only a JSON object")))).toEqual(expected);
});
