/**
 * TEMPORARY — verifies `dist/plugin.smoke-test.mjs` without any real payment.
 *
 * It drives the artifact over the same stdio JSON-RPC the PayBox runtime uses,
 * against a loopback stub that impersonates the API's preflight. What it proves
 * is that the tool proposes the right thing when the server is configured, and
 * refuses to propose anything when the server is not — the two failure modes
 * that would otherwise put a wrong payment in front of a reviewer.
 *
 * A passing run says nothing about whether a payment settles. Nothing here
 * touches a network.
 */
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

import { withProcess } from "./process.mjs";
import { validateSample } from "./schema.mjs";

const ARTIFACT = resolve(process.cwd(), "dist/plugin.smoke-test.mjs");
const PROTOCOL_VERSION = "2026-07-28";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const PAY_TO = "0x1111111111111111111111111111111111111111";

const SERVER_INFO = { name: "paybox-smoke-check", version: "1.0.0" };

let pass = 0;
const failures = [];

function check(condition, message) {
  if (condition) { pass += 1; return; }
  failures.push(message);
  console.error(`  ✗ ${message}`);
}

/** A stub of the API's `GET /v1/x402/smoke`. Only this route is ever served. */
async function startStub(respond) {
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const { status, body } = respond(new URL(`${origin}${request.url}`));
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

const healthy = (origin) => ({
  status: 200,
  body: {
    smokeTest: true,
    amountAtomic: "100000",
    amountUsdc: "0.10",
    network: "eip155:8453",
    asset: USDC,
    payTo: PAY_TO,
    facilitatorHost: "api.cdp.coinbase.com",
    authentication: "cdp-jwt",
    resourceUrl: `${origin}/v1/x402/smoke/pay`,
    problems: [],
  },
});

/** One JSON-RPC round trip against the artifact. */
async function call(apiUrl, method, params) {
  const home = await mkdtemp(resolve(tmpdir(), "eventpass-smoke-check-"));
  try {
    return await withProcess(process.execPath, [ARTIFACT], {
      cwd: dirname(ARTIFACT),
      // The API URL is the only variable passed: the tool must need no credential.
      env: { HOME: home, NODE_ENV: "production", NO_COLOR: "1", EVENTPASS_API_URL: apiUrl, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    }, async (child) => {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      try {
        child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
            "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": SERVER_INFO,
            "io.modelcontextprotocol/clientCapabilities": {},
          } },
        })}\n`);
        for await (const line of lines) {
          const message = JSON.parse(line);
          if (message.id === 1) return message;
        }
        throw new Error(`no response to ${method}`);
      } finally { lines.close(); }
    }, 15_000);
  } finally { await rm(home, { recursive: true, force: true }); }
}

const textOf = (result) => (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");

// ─── The tool catalog ────────────────────────────────────────────────────────
{
  // tools/list never touches the API, so any origin will do here.
  const response = await call("http://127.0.0.1:1", "tools/list", {});

  const tools = response.result?.tools ?? [];
  check(tools.length === 1, `the smoke artifact must expose exactly one tool, found ${tools.length}`);
  check(tools[0]?.name === "x402_smoke_test", `the tool must be named x402_smoke_test, found ${tools[0]?.name}`);
  const params = JSON.stringify(tools[0]?.inputSchema ?? {});
  check(!/amount|payTo|to\b|recipient/i.test(params), "the tool must take no argument that can set an amount or recipient");
  check(tools[0]?.outputSchema !== undefined, "the tool must declare an output schema for PayBox to validate");
}

// ─── A correctly configured server: propose, and propose the right thing ─────
//
// This needs an HTTPS origin on port 443, because `proposeX402` enforces exactly
// that and the enforcement is not something to weaken for a test: port 443 is a
// PayBox requirement. Binding 443 needs root, so this leg runs against the real
// deployment once `X402_SMOKE_TEST_ENABLED` is on. It settles nothing — producing
// a proposal is not a payment — so it is safe to run before approval, and it is
// the only way to see the deployed payee and price in the proposal itself.
if (process.env.SMOKE_CHECK_API_URL) {
  const apiUrl = process.env.SMOKE_CHECK_API_URL.replace(/\/+$/, "");
  const listed = await call(apiUrl, "tools/list", {});
  const response = await call(apiUrl, "tools/call", { name: "x402_smoke_test", arguments: {} });

  const result = response.result ?? {};
  check(result.isError !== true, `the deployed endpoint must not error: ${textOf(result)}`);
  if (result.isError !== true) {
    validateSample(listed.result.tools[0], {}, result);
    pass += 1; // reaching here means PayBox's own output-schema check passed

    const proposal = result.structuredContent?.["io.paybox/transactionProposal"];
    check(proposal?.kind === "x402", "the proposal must be an x402 proposal");
    check(proposal?.chain === "eip155:8453", `the chain must be Base mainnet, found ${proposal?.chain}`);
    check(proposal?.payment?.maxAmount === "100000", `the amount must be exactly 100000 atomic units, found ${proposal?.payment?.maxAmount}`);
    check(proposal?.payment?.asset === USDC, "the asset must be canonical Base USDC");
    check(proposal?.request?.url === `${apiUrl}/v1/x402/smoke/pay`, `the resource must be the smoke endpoint, found ${proposal?.request?.url}`);
    check(proposal?.request?.method === "GET", "the resource must be fetched with GET");
    check(typeof proposal?.expiresAt === "string" && proposal.expiresAt.endsWith("Z"), "the proposal must carry a UTC expiry");

    const text = textOf(result);
    check(/^0x[0-9a-fA-F]{40}$/.test(text.match(/Pay to\s+(0x[0-9a-fA-F]{40})/)?.[1] ?? ""), "the text must show a well-formed receiving address");
    check(text.includes("0.10 USDC"), "the amount must be shown to the reviewer");
    check(text.includes("Base mainnet"), "the network must be shown to the reviewer");
    check(/unsigned/i.test(text), "the text must state the proposal is unsigned");
    check(!/Bearer|api[_-]?key|secret/i.test(text), "no credential may appear in the tool output");
    console.log("  · deployed proposal verified — nothing was signed or settled by this check");
  }
} else {
  console.log("  · the proposal leg is skipped: set SMOKE_CHECK_API_URL after enabling the flag");
}

// ─── Every way the server can be wrong: refuse, do not propose ───────────────
const refusals = [
  ["the smoke endpoint is disabled", () => ({ status: 404, body: { error: "Not found." } }), /not enabled/i],
  ["the endpoint reports an unusable configuration", () => ({ status: 503, body: { problems: ["X402_PAY_TO is missing."] } }), /not fully configured|unusable configuration/i],
  ["the server prices it differently", (origin) => ({ status: 200, body: { ...healthy(origin).body, amountAtomic: "19000000", amountUsdc: "19.00" } }), /amountAtomic/],
  ["the server names a different network", (origin) => ({ status: 200, body: { ...healthy(origin).body, network: "eip155:84532" } }), /network/],
  ["the server names a different asset", (origin) => ({ status: 200, body: { ...healthy(origin).body, asset: "0x0000000000000000000000000000000000000000" } }), /asset/],
  ["the server names no usable payee", (origin) => ({ status: 200, body: { ...healthy(origin).body, payTo: "" } }), /receiving address/i],
  ["the server aims the payment at another host", (origin) => ({ status: 200, body: { ...healthy(origin).body, resourceUrl: "https://attacker.example/v1/x402/smoke/pay" } }), /not this API/i],
  ["the server aims the payment at another path", (origin) => ({ status: 200, body: { ...healthy(origin).body, resourceUrl: `${origin}/v1/orders/ord_1/pay` } }), /not this API/i],
  ["the response is not a smoke-test preflight", () => ({ status: 200, body: { ok: true } }), /did not identify itself/i],
  ["the server reports its own problems", (origin) => ({ status: 200, body: { ...healthy(origin).body, problems: ["CDP_API_KEY_SECRET cannot be used."] } }), /not fully configured/i],
  // Even a flawless preflight is refused when it is not served over the transport
  // PayBox requires: this is the loopback stub's own case, and it is the reason
  // the proposal leg above needs the real deployment.
  ["the API is not HTTPS on port 443", (origin) => healthy(origin), /HTTPS port 443/i],
];

for (const [label, respond, expected] of refusals) {
  const stub = await startStub((url) => respond(url.origin));
  const response = await call(stub.url, "tools/call", { name: "x402_smoke_test", arguments: {} });
  await stub.close();

  const result = response.result ?? {};
  const text = textOf(result);
  check(result.isError === true, `must refuse when ${label} (returned: ${text.slice(0, 200)})`);
  check(expected.test(text), `the refusal when ${label} must say why (got: ${text.slice(0, 200)})`);
  check(result.structuredContent === undefined, `must propose nothing when ${label}`);
}

// ─── The artifact carries no credential ──────────────────────────────────────
{
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(ARTIFACT, "utf8");
  for (const name of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "X402_VERIFY_TOKEN", "TICKET_SECRET", "ORGANIZER_KEY", "DATABASE_URL", "PRIVATE_KEY"]) {
    check(!source.includes(name), `the artifact must not reference ${name}`);
  }
  check(!/0x[0-9a-fA-F]{64}\b/.test(source), "the artifact must contain no raw private key");
}

console.log(`\n${pass} checks passed, ${failures.length} failed`);
if (failures.length) {
  console.error(failures.map((failure) => `  - ${failure}`).join("\n"));
  process.exit(1);
}
