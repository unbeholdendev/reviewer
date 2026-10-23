import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PI_API_KEY, PI_AUTH_FILE, PI_MODEL } from "./env";

async function main() {
  if (PI_API_KEY) {
    console.log("Using PI_API_KEY; skipping subscription login.");
    return;
  }
  const runtime = await ModelRuntime.create({ authPath: PI_AUTH_FILE, modelsPath: null, refreshOnCreate: false });
  const slash = PI_MODEL.indexOf("/");
  const provider = PI_MODEL.slice(0, slash);
  if (!runtime.getModel(provider, PI_MODEL.slice(slash + 1))) throw new Error(`Unknown Pi model: ${PI_MODEL}`);
  if ((await runtime.checkAuth(provider))?.type === "oauth") {
    try {
      if (await runtime.getAuth(provider, { signal: AbortSignal.timeout(60_000) })) {
        console.log(`Saved ${provider} login is ready.`);
        return;
      }
    } catch {
      console.log(`Saved ${provider} login could not be refreshed; sign in again.`);
    }
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Subscription login required. Run ./deploy.sh in an interactive terminal.");
  }
  const deviceFile = join(dirname(PI_AUTH_FILE), "device-id");
  try {
    await writeFile(deviceFile, randomUUID(), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const deviceId = (await readFile(deviceFile, "utf8")).trim();
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  terminal.once("SIGINT", cancel);
  terminal.once("close", cancel);
  process.once("SIGINT", cancel);
  try {
    await runtime.login(provider, "oauth", {
      signal: controller.signal,
      prompt(request) {
        if (request.type !== "text" && request.type !== "manual_code") throw new Error("This login requires Pi's interactive CLI.");
        return terminal.question(`${request.message} `, { signal: request.signal ?? controller.signal });
      },
      notify(event) {
        if ("message" in event) console.log(event.message);
        if (event.type === "auth_url") console.log(`${event.instructions ?? ""}\n${event.url}`);
        if (event.type === "device_code") console.log(`Open ${event.verificationUri} and enter ${event.userCode}`);
        if (event.type === "info") for (const link of event.links ?? []) console.log(link.url);
      },
    }, { getDeviceId: () => deviceId });
    console.log(`Saved ${provider} subscription login.`);
  } finally {
    process.off("SIGINT", cancel);
    terminal.off("close", cancel);
    terminal.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
