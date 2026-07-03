# chronoverify-mcp

[![chronoverify-mcp MCP server](https://glama.ai/mcp/servers/beeswaxpat/chronoverify-mcp/badges/score.svg)](https://glama.ai/mcp/servers/beeswaxpat/chronoverify-mcp)

An [MCP](https://modelcontextprotocol.io) server for [ChronoVerify](https://chronoverify.com). It gives any MCP-compatible AI agent (Claude Desktop, Cursor, Cline, VS Code, and others) the tools to check a photo's capture time and provenance: C2PA Content Credentials, EXIF and XMP metadata, and classical pixel forensics, fused into one verdict (`provenance_confirmed`, `consistent`, `inconclusive`, `metadata_anomaly`, or `manipulation_indicated`) with a 0 to 100 confidence.

Provenance-first, not a deepfake or AI-generation detector. Results are investigative triage to support human review, not proof.

> **Get an API key** (the first 100 verifications each month are included): https://chronoverify.com/pricing . Without a key, `verify_image` uses the free, rate-limited public path. A signed report requires a key.

## Install

Add it to your MCP client config. For Claude Desktop (`claude_desktop_config.json`) or any MCP client:

```json
{
  "mcpServers": {
    "chronoverify": {
      "command": "npx",
      "args": ["-y", "chronoverify-mcp"],
      "env": { "CHRONOVERIFY_API_KEY": "cv_live_..." }
    }
  }
}
```

Omit the `env` block to use the free public path (verification only; signed reports always need a key).

## Tools

### `verify_image`

Verify a photo's capture time and provenance. Takes exactly one of:

- `url`: a publicly reachable image URL (the server fetches it),
- `file_path`: an absolute path to a local image, or
- `image_base64`: base64-encoded image bytes.

Optionally set `permalink: true` to also store the verdict (never the image) and get back an unlisted, shareable link to it in the `permalink` field, for citing the result to people or in reports. Keyless links expire after 90 days; links minted with an API key do not expire.

It returns a human-readable summary **and** a typed structured object so an agent can branch on the result without parsing prose:

```json
{
  "schema_version": "v1",
  "verdict": "consistent",
  "confidence": 58,
  "headline": "Metadata is internally consistent. No manipulation signals fired.",
  "summary": "...",
  "capture_time": { "value": "2026-03-14T09:21:30", "source": "exif", "consistent": null },
  "capture_device": { "make": "Canon", "model": "EOS R6", "software": "Firmware 1.8.1" },
  "capture_location": { "present": false, "place": null },
  "c2pa": {
    "present": false,
    "validated": null,
    "validation_state": null,
    "signature_valid": null,
    "trust_list_match": null,
    "signer": null
  },
  "integrity": {
    "sha256": "1313339a...",
    "sha512": "93a81e4a...",
    "format": "JPEG",
    "width": 1200,
    "height": 800,
    "c2pa_validator_enabled": true
  },
  "permalink": null,
  "limits": "ChronoVerify returns investigative triage, not proof.",
  "source": "ChronoVerify (https://chronoverify.com)"
}
```

The verdict enum:

- `provenance_confirmed`: a trusted C2PA Content Credential validated against the official trust list.
- `consistent`: metadata holds up and no manipulation signal fired (consistent with an unedited capture, not proof).
- `inconclusive`: not enough signal to decide.
- `metadata_anomaly`: the metadata contradicts itself.
- `manipulation_indicated`: pixel forensics flagged possible editing for human review.

### `get_signed_report`

Generate a signed PDF audit report for one image: the chain-of-custody / compliance record (for example an EU AI Act Article 50 transparency record, an insurance or legal evidence file, or a newsroom audit trail). Takes one of `file_path` or `image_base64` (this endpoint does not fetch URLs) and an optional `out_path`. Writes the PDF and returns the path. **Requires** `CHRONOVERIFY_API_KEY`; metered as a premium report unit. The report carries an Ed25519 signature you can verify against the public key at `https://chronoverify.com/v1/key`.

## Example prompts

- "Verify the provenance of /Users/me/Downloads/photo.jpg"
- "When was the photo at this URL taken, and has it been edited? https://example.com/photo.jpg"
- "Validate the C2PA Content Credentials on this image and tell me the signer."
- "Verify this photo and give me a shareable link to the verdict."
- "Generate a signed provenance report for ./evidence/claim-001.jpg and save it to ./reports/"

## License

MIT
