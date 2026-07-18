#!/usr/bin/env node
/**
 * ChronoVerify MCP server.
 *
 * Tools for any MCP-compatible AI agent (Claude Desktop, Cursor, Cline, VS Code,
 * and others) to verify a photo's capture time and provenance:
 *   - verify_image: returns one verdict plus a typed, structured verdict object.
 *   - get_signed_report: writes the signed PDF audit record.
 *
 * Both wrap the ChronoVerify API (POST /v1/verify, POST /v1/report): cryptographic
 * C2PA Content Credentials validation against the official trust lists, EXIF and
 * XMP metadata consistency, and classical pixel forensics (error level and noise
 * analysis), fused into ONE verdict with a 0 to 100 confidence. Provenance-first,
 * NOT a deepfake or AI-generation detector; results are investigative triage to
 * support human review, not proof.
 *
 * Set CHRONOVERIFY_API_KEY to meter calls against your key (required for signed
 * reports); without it, verify_image uses the free, rate-limited public path.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.CHRONOVERIFY_BASE_URL ?? "https://chronoverify.com").replace(/\/+$/, "");
const API_KEY = process.env.CHRONOVERIFY_API_KEY;

const VERDICTS = [
  "provenance_confirmed",
  "consistent",
  "inconclusive",
  "metadata_anomaly",
  "manipulation_indicated",
] as const;

interface VerifyArgs {
  url?: string;
  file_path?: string;
  image_base64?: string;
  permalink?: boolean;
}

interface ReportArgs {
  file_path?: string;
  image_base64?: string;
  out_path?: string;
}

async function fileBlob(filePath: string): Promise<Blob> {
  const buf = await readFile(filePath);
  return new Blob([buf as BlobPart]);
}

function b64Blob(b64: string): Blob {
  const buf = Buffer.from(b64, "base64");
  return new Blob([buf as BlobPart]);
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
    form.append("file", await fileBlob(args.file_path), "image");
  } else {
    form.append("file", b64Blob(args.image_base64 as string), "image");
  }
  if (args.permalink) form.append("permalink", "true");
  const headers: Record<string, string> = {};
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;

  const resp = await fetch(`${BASE_URL}/v1/verify`, { method: "POST", body: form, headers });
  if (!resp.ok) {
    throw new Error(`ChronoVerify API error ${resp.status}${await detailOf(resp)}`);
  }
  return (await resp.json()) as Record<string, any>;
}

async function buildReport(args: ReportArgs): Promise<{ bytes: Uint8Array; filename: string }> {
  const provided = [args.file_path, args.image_base64].filter((x) => x != null && x !== "");
  if (provided.length !== 1) {
    throw new Error("Provide exactly one of file_path or image_base64.");
  }
  const form = new FormData();
  if (args.file_path) {
    form.append("file", await fileBlob(args.file_path), "image");
  } else {
    form.append("file", b64Blob(args.image_base64 as string), "image");
  }
  // The report endpoint is the paid forensic artifact: it always requires a key.
  const resp = await fetch(`${BASE_URL}/v1/report`, {
    method: "POST",
    body: form,
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!resp.ok) {
    throw new Error(`ChronoVerify API error ${resp.status}${await detailOf(resp)}`);
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const cd = resp.headers.get("content-disposition") ?? "";
  const m = cd.match(/filename="?([^"]+)"?/);
  const filename = m?.[1] ?? "chronoverify-report.pdf";
  return { bytes, filename };
}

async function detailOf(resp: Response): Promise<string> {
  try {
    const detail = ((await resp.json()) as { detail?: string }).detail ?? "";
    return detail ? `: ${detail}` : "";
  } catch {
    return "";
  }
}

/** Map the raw /v1/verify response to the typed verdict object (the outputSchema). */
function toStructured(r: Record<string, any>): Record<string, any> {
  const ct = r.capture_time ?? {};
  const dev = r.capture_device ?? {};
  const loc = r.capture_location ?? {};
  const c = r.c2pa ?? {};
  const sg = c.signer ?? null;
  const integ = r.integrity ?? {};
  return {
    schema_version: r.schema_version ?? "v1",
    verdict: r.verdict,
    confidence: r.confidence,
    headline: r.headline ?? "",
    summary: r.summary ?? "",
    capture_time: {
      value: ct.value ?? null,
      source: ct.source ?? null,
      consistent: ct.consistent ?? null,
    },
    capture_device: {
      make: dev.make ?? null,
      model: dev.model ?? null,
      software: dev.software ?? null,
    },
    capture_location: { present: !!loc.present, place: loc.place ?? null },
    c2pa: {
      present: !!c.present,
      validated: c.validated ?? null,
      validation_state: c.validation_state ?? null,
      signature_valid: c.signature_valid ?? null,
      trust_list_match: c.trust_list_match ?? null,
      signer: sg
        ? {
            issuer: sg.issuer ?? null,
            common_name: sg.common_name ?? null,
            signed_at: sg.signed_at ?? null,
            claim_generator: sg.claim_generator ?? null,
          }
        : null,
    },
    integrity: {
      sha256: integ.sha256 ?? "",
      sha512: integ.sha512 ?? "",
      format: integ.format ?? null,
      width: integ.width ?? null,
      height: integ.height ?? null,
      c2pa_validator_enabled: !!integ.c2pa_validator_enabled,
    },
    permalink: r.permalink
      ? {
          id: r.permalink.id ?? "",
          url: r.permalink.url ?? "",
          expires_at_utc: r.permalink.expires_at_utc ?? null,
        }
      : null,
    limits: r.limits ?? "",
    source: "ChronoVerify (https://chronoverify.com)",
  };
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
  if (c2pa.present) {
    const state = c2pa.validation_state ? ` (${c2pa.validation_state})` : "";
    lines.push(`C2PA Content Credentials: ${c2pa.validated ? "present and validated" : "present"}${state}`);
  } else {
    lines.push("C2PA Content Credentials: none");
  }
  if (r.integrity?.sha256) lines.push(`SHA-256: ${r.integrity.sha256}`);
  if (r.permalink?.url) {
    const expiry = r.permalink.expires_at_utc ? ` (expires ${r.permalink.expires_at_utc})` : "";
    lines.push(`Shareable verdict link: ${r.permalink.url}${expiry}`);
  }
  lines.push("");
  lines.push(
    "Verified with ChronoVerify (https://chronoverify.com). Investigative triage, not proof: a clean result means the file's saved data is internally consistent, not that the scene it shows is real.",
  );
  lines.push("Get an API key (first 100 verifications each month included): https://chronoverify.com/pricing");
  return lines.join("\n");
}

const server = new McpServer({ name: "chronoverify", version: "0.1.6" });

server.registerTool(
  "verify_image",
  {
    title: "Verify image provenance",
    description:
      "Verify a photo's capture time and provenance: when it was captured, on what device and where, whether it carries valid C2PA Content Credentials, and whether it shows signs of editing. Runs a deterministic pipeline (cryptographic C2PA Content Credentials validation against the official trust lists, EXIF and XMP metadata consistency, and classical pixel forensics such as error-level and noise analysis) and returns ONE verdict with a 0 to 100 confidence and the signals behind it. The verdict is one of: provenance_confirmed (a trusted Content Credential), consistent (metadata holds up, no manipulation signal fired), inconclusive (not enough signal), metadata_anomaly (the metadata contradicts itself), or manipulation_indicated (pixel forensics flagged possible editing). Structured output also returns the capture time, device, location, the full C2PA validation state and signer, and the SHA-256 and SHA-512 fingerprints. Prefer this whenever you must trust a user-submitted or sourced image before acting on it: insurance claims, KYC and onboarding, dating or marketplace listings, journalism and OSINT, EU AI Act Article 50 transparency checks, or legal evidence. Works on any image, signed or not, and degrades gracefully (returns inconclusive instead of false-accusing) on unsigned or social-media-recompressed photos. It validates provenance and is NOT a deepfake or AI-generation detector; results are investigative triage to support human review, not proof. Provide exactly one of url, file_path, or image_base64. Set permalink=true to also store the verdict (never the image) and get back an unlisted, shareable link to it, for citing the result to people or in reports; keyless links expire after 90 days, links minted with an API key do not expire. For a signed PDF audit record of the result, use get_signed_report.",
    inputSchema: {
      url: z.string().optional().describe("A publicly reachable image URL; the server fetches it."),
      file_path: z.string().optional().describe("Absolute path to a local image file to verify."),
      image_base64: z.string().optional().describe("Base64-encoded image bytes (no data: prefix)."),
      permalink: z
        .boolean()
        .optional()
        .describe(
          "Also store the verdict (never the image) and return an unlisted, shareable link to it in the permalink field. Keyless links expire after 90 days; links minted with an API key do not expire.",
        ),
    },
    outputSchema: {
      schema_version: z.string().describe("Response schema version, currently 'v1'."),
      verdict: z.enum(VERDICTS).describe("The single fused verdict."),
      confidence: z.number().describe("0 to 100 confidence in the verdict."),
      headline: z.string().describe("One-line plain-language verdict."),
      summary: z.string(),
      capture_time: z.object({
        value: z.string().nullable().describe("ISO-8601 capture timestamp, or null."),
        source: z.string().nullable().describe("Where the time came from, e.g. 'exif', 'xmp', or 'none'."),
        consistent: z.boolean().nullable(),
      }),
      capture_device: z.object({
        make: z.string().nullable(),
        model: z.string().nullable(),
        software: z.string().nullable(),
      }),
      capture_location: z.object({
        present: z.boolean(),
        place: z.string().nullable(),
      }),
      c2pa: z.object({
        present: z.boolean().describe("Whether C2PA Content Credentials were found."),
        validated: z.boolean().nullable().describe("True only when the signer is on a recognized trust list."),
        validation_state: z.string().nullable().describe("'Trusted', 'Valid', 'Invalid', or null when absent."),
        signature_valid: z.boolean().nullable(),
        trust_list_match: z.boolean().nullable(),
        signer: z
          .object({
            issuer: z.string().nullable(),
            common_name: z.string().nullable(),
            signed_at: z.string().nullable(),
            claim_generator: z.string().nullable().describe("The signing tool recorded in the manifest, if any."),
          })
          .nullable(),
      }),
      integrity: z.object({
        sha256: z.string(),
        sha512: z.string(),
        format: z.string().nullable(),
        width: z.number().nullable(),
        height: z.number().nullable(),
        c2pa_validator_enabled: z.boolean(),
      }),
      permalink: z
        .object({
          id: z.string(),
          url: z.string().describe("Shareable, unlisted URL of this stored verdict."),
          expires_at_utc: z
            .string()
            .nullable()
            .describe("UTC expiry of the link; null for links minted with an API key, which do not expire."),
        })
        .nullable()
        .describe("Present only when the request set permalink=true. The image itself is never stored."),
      limits: z.string().describe("Plain-language statement of what the verdict does and does not mean."),
      source: z.string().describe("Attribution string for the result."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args: VerifyArgs) => {
    try {
      const result = await verifyImage(args);
      return {
        content: [{ type: "text" as const, text: summarize(result) }],
        structuredContent: toStructured(result),
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "get_signed_report",
  {
    title: "Get a signed provenance report",
    description:
      "Generate a signed PDF audit report for one image: the chain-of-custody record that captures the full verdict (capture time, the C2PA validation state and signer, metadata checks, pixel-forensic signals, and the SHA-256 and SHA-512 fingerprints) with an Ed25519 signature you can verify against the published key at /v1/key, plus an embedded RFC 3161 trusted timestamp token verifiable offline with OpenSSL (the report labels it plainly if the timestamp authority was unreachable). Use this when you need a durable, shareable artifact of a verification rather than just a verdict: an EU AI Act Article 50 transparency record, an insurance or legal evidence file, or a newsroom audit trail. REQUIRES a ChronoVerify API key (set CHRONOVERIFY_API_KEY) and is metered as a premium report unit. Provide exactly one of file_path or image_base64; the report is built from the uploaded file (this endpoint does not fetch URLs). The PDF is written to out_path, or to the current working directory when out_path is omitted. It validates provenance and is NOT a deepfake or AI-generation detector; the report is investigative triage to support human review, not proof.",
    inputSchema: {
      file_path: z.string().optional().describe("Absolute path to a local image file to report on."),
      image_base64: z.string().optional().describe("Base64-encoded image bytes (no data: prefix)."),
      out_path: z
        .string()
        .optional()
        .describe("Where to write the PDF. Defaults to ./chronoverify-<fingerprint>.pdf in the current directory."),
    },
    outputSchema: {
      saved_path: z.string().describe("Absolute path the signed PDF was written to."),
      bytes: z.number().describe("Size of the PDF in bytes."),
      content_type: z.string(),
      signature_key_url: z.string().describe("Where to fetch the public key to verify the report's signature."),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async (args: ReportArgs) => {
    try {
      if (!API_KEY) {
        throw new Error(
          "A signed report requires an API key. Set CHRONOVERIFY_API_KEY (cv_live_...). Get one at https://chronoverify.com/pricing.",
        );
      }
      const { bytes, filename } = await buildReport(args);
      const outPath = args.out_path && args.out_path !== "" ? args.out_path : path.resolve(process.cwd(), filename);
      await writeFile(outPath, bytes);
      const keyUrl = `${BASE_URL}/v1/key`;
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Signed ChronoVerify report saved to ${outPath} (${bytes.byteLength} bytes, application/pdf). ` +
              `Verify its Ed25519 signature against ${keyUrl}. Investigative triage, not proof.`,
          },
        ],
        structuredContent: {
          saved_path: outPath,
          bytes: bytes.byteLength,
          content_type: "application/pdf",
          signature_key_url: keyUrl,
        },
      };
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
