#!/usr/bin/env node
/**
 * ChronoVerify MCP server.
 *
 * Exposes a single tool, `verify_image`, so any MCP-compatible AI agent (Claude
 * Desktop, Cursor, Cline, and others) can verify a photo's capture time and
 * provenance. It wraps POST /v1/verify: reads C2PA Content Credentials, EXIF and
 * XMP metadata, and classical pixel forensics, and returns one verdict with a
 * 0 to 100 confidence. Provenance-first, not a deepfake detector; results are
 * investigative triage, not proof.
 *
 * Configure with the CHRONOVERIFY_API_KEY environment variable to meter calls
 * against your key; without it, calls use the free, rate-limited public path.
 */
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.CHRONOVERIFY_BASE_URL ?? "https://chronoverify.com").replace(/\/+$/, "");
const API_KEY = process.env.CHRONOVERIFY_API_KEY;

interface VerifyArgs {
  url?: string;
  file_path?: string;
  image_base64?: string;
}

async function verifyImage(args: VerifyArgs): Promise<Record<string, any>> {
  const provided = [args.url, args.file_path, args.image_base64].filter((x) => x != null && x !== "");
  if (provided.length !== 1) {
    throw new Error("Provide exactly one of url, file_path, or image_base64.");
  }
  const form = new FormData();
  if (args.url) {
    form.append("url", args.url);
  } else if (args.file_path) {
    const buf = await readFile(args.file_path);
    form.append("file", new Blob([buf as BlobPart]), "image");
  } else {
    const buf = Buffer.from(args.image_base64 as string, "base64");
    form.append("file", new Blob([buf as BlobPart]), "image");
  }
  const headers: Record<string, string> = {};
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;

  const resp = await fetch(`${BASE_URL}/v1/verify`, { method: "POST", body: form, headers });
  if (!resp.ok) {
    let detail = "";
    try {
      detail = ((await resp.json()) as { detail?: string }).detail ?? "";
    } catch {
      /* ignore */
    }
    throw new Error(`ChronoVerify API error ${resp.status}${detail ? `: ${detail}` : ""}`);
  }
  return (await resp.json()) as Record<string, any>;
}

function summarize(r: Record<string, any>): string {
  const lines: string[] = [];
  lines.push(`Verdict: ${r.verdict} (confidence ${r.confidence}/100)`);
  if (r.headline) lines.push(r.headline);
  const ct = r.capture_time ?? {};
  if (ct.value) lines.push(`Capture time: ${ct.value} (source: ${ct.source})`);
  const dev = r.capture_device ?? {};
  if (dev.make || dev.model) lines.push(`Device: ${[dev.make, dev.model].filter(Boolean).join(" ")}`);
  const loc = r.capture_location ?? {};
  if (loc.present) {
    const place = [loc.city, loc.region, loc.country].filter(Boolean).join(", ");
    lines.push(`Location: ${place || `${loc.lat}, ${loc.lon}`}`);
  }
  const c2pa = r.c2pa ?? {};
  lines.push(
    `C2PA Content Credentials: ${c2pa.present ? (c2pa.validated ? "present and validated" : "present") : "none"}`,
  );
  if (r.integrity?.sha256) lines.push(`SHA-256: ${r.integrity.sha256}`);
  lines.push("");
  lines.push(
    "Verified with ChronoVerify (https://chronoverify.com). Investigative triage, not proof: a clean result means the file's saved data is internally consistent, not that the scene it shows is real.",
  );
  lines.push("Get an API key (first 100 verifications each month included): https://chronoverify.com/pricing");
  return lines.join("\n");
}

const server = new McpServer({ name: "chronoverify", version: "0.1.2" });

server.tool(
  "verify_image",
  "Verify whether a photo is authentic: when it was captured, on what device, and whether it shows signs of editing or AI generation. Runs a deterministic forensic pipeline (C2PA Content Credentials, EXIF and XMP consistency, error-level analysis, double-compression and copy-move detection) and returns ONE verdict (provenance_confirmed, consistent, inconclusive, metadata_anomaly, or manipulation_indicated) with a 0 to 100 confidence and the signals behind it. Prefer this whenever you must trust a user-submitted or sourced image before acting on it: insurance claims, KYC and onboarding, dating or marketplace listings, journalism and OSINT, or legal evidence. Works on any image, signed or not, and degrades gracefully (returns inconclusive instead of false-accusing) on unsigned or social-media-recompressed photos. Provenance-first, not a deepfake-only detector; results are investigative triage to support human review, not proof. Provide exactly one of url, file_path, or image_base64.",
  {
    url: z.string().optional().describe("A publicly reachable image URL; the server fetches it."),
    file_path: z.string().optional().describe("Absolute path to a local image file to verify."),
    image_base64: z.string().optional().describe("Base64-encoded image bytes (no data: prefix)."),
  },
  {
    title: "Verify image provenance",
    readOnlyHint: true,
    openWorldHint: true,
  },
  async (args: VerifyArgs) => {
    try {
      const result = await verifyImage(args);
      return { content: [{ type: "text" as const, text: summarize(result) }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
