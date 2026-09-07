# OpenCode read shunt

This plugin reduces large `read` results before OpenCode adds them to main model context.

It uses OpenCode's internal `generate.text` API. It does not manage provider authentication.

## Design

The plugin follows the bulk-reader design in
[Spotify's Shunt article](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90):

- A hook enforces routing for large, broad reads.
- Reads with `offset` or `limit` keep exact content.
- A low-cost worker gets the file and current question in one stateless call.
- The main model gets only the worker response.
- A 30-second timeout returns the original result.

OpenCode runs this hook after local file I/O but before the next model request.
Thus, the full file does not enter the main model context.

This package handles one file per call. It does not intercept shell reads or generate code.

## Install

Install the plugin from GitHub:

```bash
opencode2 plugin add github:p5/opencode-read-shunt-plugin
```

Confirm that OpenCode loaded the plugin:

```bash
opencode2 plugin list
```

## Safety rules

Default configuration processes only reads from agent `explore`. OpenCode defines `explore` as read-only.
Use another agent for debugging, editing, architecture, security, and code review.

The plugin bypasses these reads:

- Reads with `offset` or `limit`.
- Reads below both size thresholds.
- `AGENTS.md` and `SKILL.md` files.
- Results where the complete replacement is not smaller than original model-visible content.

Any error or timeout returns original result.

## Configuration

To change options, add this plugin object to `opencode.json`:

```json
{
  "plugins": [
    {
      "package": "github:p5/opencode-read-shunt-plugin",
      "options": {
        "thresholdChars": 12000,
        "thresholdLines": 350,
        "maxSummaryChars": 4000,
        "generationTimeoutMs": 30000,
        "allowedAgents": ["explore"],
        "model": {
          "providerID": "google-vertex",
          "id": "gemini-2.5-flash"
        }
      }
    }
  ]
}
```

For local development, use the absolute package directory as the `package` value.

## Savings log

Each shunt writes one console line. It also appends JSON to:

`~/.local/state/opencode/read-shunt.jsonl`

Each replacement reports current and session estimates. Estimates cover avoided main-context input only.
OpenCode's internal generation API does not report worker usage here. Logs do not prove net cost savings.

## Evals

The provider-free eval suite runs with `bun test`. CI runs this suite for each change.

The live eval uses a real main model and the configured worker model. It spends tokens.

```bash
READ_SHUNT_EVAL_MODEL="google-vertex/claude-sonnet-4-6@default#low" bun run eval:live
```

The live eval checks the hook marker and 3 exact names in the final response.
