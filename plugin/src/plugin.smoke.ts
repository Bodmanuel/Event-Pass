/**
 * TEMPORARY — the EventPass $0.10 USDC x402 smoke test, built as its own artifact.
 *
 * This is deliberately NOT part of `src/plugin.ts`. The submitted plugin must keep
 * its four tools and its exact bytes, so this entry point imports the same modules
 * (`paybox.ts`, `eventpass.ts`) without sharing their bundle. It builds to
 * `dist/plugin.smoke-test.mjs`, which is uploaded on its own for the duration of
 * the smoke test and never replaces `dist/plugin.mjs`.
 *
 * The tool PROPOSES and nothing else. It does not sign, submit, or settle. An
 * unsigned x402 proposal is handed to PayBox, which owns validation and approval;
 * this file contains no key, no token, and no payment code, because the API holds
 * every credential server-side.
 *
 * Why the tool reads the API before it proposes: the proposal has to describe the
 * endpoint that will actually receive the money. The preflight is the server's own
 * statement of its payee, network, asset and price, so the plugin checks its
 * constants against it and refuses to propose anything that disagrees — a proposal
 * that contradicts the server's configuration is a payment to an unknown address.
 *
 * Delete this file, `dist/plugin.smoke-test.mjs`, the API's `lib/x402-smoke.mjs`
 * and its routes when the smoke test is done.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { proposeX402, x402OutputSchema } from "./paybox.js";
import { apiGet, resolveApiUrl } from "./eventpass.js";

const PROTOCOL_VERSION = "2026-07-28";

/**
 * Mirrors the API's `lib/x402-smoke.mjs`. Both sides hold these as constants and
 * neither reads them from input, so a caller cannot argue the price upward.
 */
const SMOKE_AMOUNT_ATOMIC = "100000";
const SMOKE_AMOUNT_USDC = "0.10";
const SMOKE_NETWORK = "eip155:8453";
const SMOKE_RESOURCE_PATH = "/v1/x402/smoke/pay";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

/** The API's preflight report. Everything is optional here so a missing field is
 * reported as a specific refusal rather than a schema error the caller cannot read. */
type Preflight = {
  smokeTest?: boolean;
  amountAtomic?: string;
  amountUsdc?: string;
  network?: string;
  asset?: string;
  payTo?: string;
  facilitatorHost?: string | null;
  authentication?: string;
  resourceUrl?: string;
  problems?: string[];
};

function requireMatch(label: string, actual: unknown, expected: string): string {
  if (typeof actual !== "string" || actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `The smoke endpoint reports ${label} = ${JSON.stringify(actual ?? null)}, but this tool proposes ${expected}. ` +
      "Refusing to propose a payment that contradicts the server's own configuration.",
    );
  }
  return actual;
}

function createServer() {
  const server = new McpServer(
    { name: "eventpass", version: "1.0.0-smoke" },
    { supportedProtocolVersions: [PROTOCOL_VERSION] },
  );

  server.registerTool(
    "x402_smoke_test",
    {
      title: "x402 smoke test",
      description:
        "TEMPORARY. Returns an unsigned x402 payment proposal for the EventPass $0.10 USDC smoke-test endpoint on Base mainnet. " +
        "Proposes only: it never signs or settles, and the endpoint creates no order, reserves no inventory and issues no ticket. " +
        "Takes no payment arguments — the amount, recipient and network are fixed by the API's configuration and are reported back for review.",
      inputSchema: z.object({}).strict(),
      outputSchema: x402OutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const status = await apiGet<Preflight>("/v1/x402/smoke");
      if (!status.ok) {
        if (status.kind === "http" && status.status === 404) {
          throw new Error(
            "The smoke-test endpoint is not enabled on the API (HTTP 404). Enable X402_SMOKE_TEST_ENABLED and redeploy before proposing a payment.",
          );
        }
        if (status.kind === "http" && status.status === 503) {
          throw new Error("The smoke-test endpoint reports an unusable configuration (HTTP 503). Fix it before proposing a payment.");
        }
        throw new Error(`Could not read the smoke-test preflight: ${status.message}`);
      }

      const report = status.data;
      if (report.smokeTest !== true) {
        throw new Error("The smoke-test preflight did not identify itself. Refusing to propose a payment against an unknown endpoint.");
      }
      if (Array.isArray(report.problems) && report.problems.length > 0) {
        throw new Error(`The smoke-test endpoint is not fully configured: ${report.problems.join(" ")}`);
      }

      // The endpoint's own statement, checked field by field against this tool's constants.
      requireMatch("amountAtomic", report.amountAtomic, SMOKE_AMOUNT_ATOMIC);
      requireMatch("amountUsdc", report.amountUsdc, SMOKE_AMOUNT_USDC);
      requireMatch("network", report.network, SMOKE_NETWORK);
      requireMatch("asset", report.asset, USDC_BASE);
      // The payee has no value this tool can check it against — it is the
      // operator's wallet, reported for human confirmation. It is only required
      // to be a well-formed address; it is echoed below and never assumed.
      const payTo = typeof report.payTo === "string" ? report.payTo : "";
      if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
        throw new Error("The smoke endpoint reports no usable receiving address. Refusing to propose a payment.");
      }

      // Pin the resource to the API this plugin was configured to talk to. The
      // preflight would otherwise be able to aim the proposal at any host at all.
      const configured = resolveApiUrl();
      let resource: URL;
      try {
        resource = new URL(String(report.resourceUrl ?? ""));
      } catch {
        throw new Error("The smoke endpoint reported an unusable resource URL. Refusing to propose a payment.");
      }
      if (resource.pathname !== SMOKE_RESOURCE_PATH || resource.origin !== new URL(configured).origin) {
        throw new Error(
          `The smoke endpoint reported its resource at ${resource.origin}${resource.pathname}, which is not this API (${configured}). ` +
          "Refusing to propose a payment against it.",
        );
      }

      const proposal = proposeX402({
        chain: SMOKE_NETWORK,
        url: resource.toString(),
        maxAmount: SMOKE_AMOUNT_ATOMIC,
      });

      const summary = [
        "Temporary x402 smoke test — unsigned proposal prepared. Nothing has been signed, paid or settled.",
        "",
        `  Amount      ${SMOKE_AMOUNT_USDC} USDC (${SMOKE_AMOUNT_ATOMIC} atomic units, exactly)`,
        `  Network     Base mainnet (${SMOKE_NETWORK})`,
        `  Asset       USDC ${USDC_BASE}`,
        `  Pay to      ${payTo}`,
        `  Resource    ${resource.toString()}`,
        `  Facilitator ${report.facilitatorHost ?? "unknown"} (authentication: ${report.authentication ?? "unknown"})`,
        "",
        "PayBox validates this proposal and obtains approval before anything reaches the network. The amount above is the",
        "entire charge this endpoint encodes; read the total, including any fee the facilitator adds, from the PayBox",
        "approval preview rather than from this text.",
        "",
        "This endpoint creates no order, reserves no inventory and issues no ticket. Reusing the same authorization",
        "cannot charge twice: the EIP-3009 nonce is single-use on Base.",
      ].join("\n");

      return { content: [{ type: "text" as const, text: summary }], structuredContent: proposal.structuredContent };
    },
  );

  return server;
}

serveStdio(createServer, { legacy: "reject" });
