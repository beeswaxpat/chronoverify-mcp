# chronoverify-mcp

An [MCP](https://modelcontextprotocol.io) server for [ChronoVerify](https://chronoverify.com). It gives any MCP-compatible AI agent (Claude Desktop, Cursor, Cline, and others) one tool, `verify_image`, to check a photo's capture time and provenance: C2PA Content Credentials, EXIF and XMP metadata, and classical pixel forensics, fused into one verdict (`provenance_confirmed`, `consistent`, `inconclusive`, `metadata_anomaly`, or `manipulation_indicated`) with a 0 to 100 confidence.

Provenance-first, not a deepfake detector. Results are investigative triage to support human review, not proof.

> **Get an API key** (the first 100 verifications each month are included): https://chronoverify.com/pricing . Without a key, the server uses the free, rate-limited public path.

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

Omit the `env` block to use the free public path.

## The tool

`verify_image` takes exactly one of:

- `url`: a publicly reachable image URL (the server fetches it),
- `file_path`: an absolute path to a local image, or
- `image_base64`: base64-encoded image bytes.

It returns the verdict, the confidence, the capture time and device when present, the C2PA status, and the SHA-256 of the file.

## Example prompts

- "Verify the provenance of /Users/me/Downloads/photo.jpg"
- "When was the photo at this URL taken, and has it been edited? https://example.com/photo.jpg"

## License

MIT
