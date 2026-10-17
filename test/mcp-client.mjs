import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export const PLUGIN_PATH = process.env.PLUGIN_PATH ?? "/Users/hi/eventpass-plugin/dist/plugin.mjs";

/** Minimal MCP stdio client: one tools/call at a time, matching the 2026-07-28 envelope. */
export function startPlugin(env = {}) {
  const child = spawn(process.execPath, [PLUGIN_PATH], {
    cwd: PLUGIN_PATH.slice(0, PLUGIN_PATH.lastIndexOf("/")),
    env: { PATH: process.env.PATH, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const messages = lines[Symbol.asyncIterator]();
  let nextId = 1;

  return {
    stderr,
    async call(name, args) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0", id, method: "tools/call",
        params: {
          name, arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "eventpass-e2e", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      })}\n`);

      for (;;) {
        const next = await messages.next();
        if (next.done) throw new Error(`plugin exited before answering ${name}. stderr: ${stderr.join("").slice(0, 500)}`);
        let message;
        try { message = JSON.parse(next.value); } catch { continue; }
        if (message.id !== id) continue;
        if (message.error) throw new Error(`plugin returned a JSON-RPC error for ${name}: ${JSON.stringify(message.error)}`);
        return message.result;
      }
    },
    stop() { lines.close(); child.kill("SIGKILL"); },
  };
}
