# Read Shunt for OpenCode, Codex, and Pi

This plugin reduces large read results before OpenCode, Codex, or Pi adds them to main model context.

Each host has an isolated adapter:

- OpenCode uses its native tool hooks and internal `generate.text` API.
- Codex uses a `PostToolUse` Bash hook and a stateless `codex exec` worker.
- Pi uses its native `tool_result` extension event and model registry.
- Shared policy selects candidates, creates replacements, and calculates savings.

Each host adapter imports only its host packages. Shared modules do not import host packages.

## Design

The plugin follows the bulk-reader design in
[Spotify's Shunt article](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90):

- A host hook detects large, broad reads.
- A Bash hook blocks direct `cat`, `head`, `tail`, `less`, and `more` reads of large files.
- Reads with `offset` or `limit` keep exact content.
- A low-cost worker gets the content and current question in one stateless call.
- The main model gets only the worker response.
- A 30-second timeout returns the original result.

Each host runs its hook after local file I/O but before the next model request.
The full content does not enter the main model context.

This package handles one file per call. It does not generate code.

## Install for OpenCode

Install the plugin from GitHub:

```bash
opencode2 plugin add github:p5/read-shunt-plugin
```

Confirm that OpenCode loaded the plugin:

```bash
opencode2 plugin list
```

## Install for Codex

Codex support requires `bun` and the `codex` CLI. It reuses Codex authentication.

```bash
codex plugin marketplace add p5/read-shunt-plugin
codex plugin add read-shunt-plugin@read-shunt-plugin
```

Start Codex. Open `/hooks`. Review and trust the hook.

The default worker is `gpt-5.6-luna`. Override it before starting Codex:

```bash
export READ_SHUNT_CODEX_MODEL="gpt-5.6-sol"
```

The worker uses `--ignore-user-config`. This prevents nested plugin and hook execution.
It still uses existing Codex authentication.
The worker runs in an empty temporary directory. Codex CLI does not provide a no-tools option.
The read-only sandbox can still permit absolute reads outside that directory.

## Install for Pi

Install the extension from GitHub:

```bash
pi install git:github.com/p5/read-shunt-plugin
```

Start a new Pi session. Pi loads `extensions/read-shunt.ts` from the package.

The default worker is `google-vertex/gemini-2.5-flash`. It uses Pi authentication.

## Safety rules

OpenCode processes only reads from agent `explore` by default. OpenCode defines `explore` as read-only.
Use another agent for debugging, editing, architecture, security, and code review.

The plugin bypasses these reads:

- Reads with `offset` or `limit`.
- Reads below both size thresholds.
- `AGENTS.md` and `SKILL.md` files.
- Results where the complete replacement is not smaller than original model-visible content.

The OpenCode Bash hook allows pipelines and output redirects.

The Codex adapter shunts only simple `cat`, `less`, and `more` commands.
It bypasses `head`, `tail`, `sed`, `rg`, pipelines, redirects, and compound commands.

The Pi adapter shunts native `read` results and simple `cat`, `less`, or `more` results.
It bypasses ranged reads, errors, images, pipelines, redirects, compound commands, and multiple files.

Any worker error or timeout returns the original read result.

## OpenCode configuration

To change options, add this plugin object to `opencode.json`:

```json
{
  "plugins": [
    {
      "package": "github:p5/read-shunt-plugin",
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

## Codex configuration

Add global settings to the plugin data file `config.json`.
Codex sets the plugin data directory when it runs the hook.

Add project settings to `.codex/read-shunt.json`:

```json
{
  "thresholdChars": 12000,
  "thresholdLines": 350,
  "maxSummaryChars": 4000,
  "generationTimeoutMs": 30000,
  "model": "gpt-5.6-luna",
  "reasoningEffort": "low",
  "codexCommand": "codex"
}
```

Project settings replace global settings. Environment variables replace both JSON files.

Set environment variables before you start Codex:

| Variable | Default |
| --- | --- |
| `READ_SHUNT_CODEX_MODEL` | `gpt-5.6-luna` |
| `READ_SHUNT_CODEX_REASONING_EFFORT` | `low` |
| `READ_SHUNT_CODEX_COMMAND` | `codex` |
| `READ_SHUNT_THRESHOLD_CHARS` | `12000` |
| `READ_SHUNT_THRESHOLD_LINES` | `350` |
| `READ_SHUNT_MAX_SUMMARY_CHARS` | `4000` |
| `READ_SHUNT_TIMEOUT_MS` | `30000` |
| `READ_SHUNT_STATS_FILE` | Host state directory |

Codex caps the worker timeout at 40 seconds. The outer hook stops after 45 seconds.

## Pi configuration

Add global settings to `~/.pi/agent/read-shunt.json`.
Add project settings to `.pi/read-shunt.json`:

```json
{
  "thresholdChars": 12000,
  "thresholdLines": 350,
  "maxSummaryChars": 4000,
  "generationTimeoutMs": 30000,
  "model": {
    "provider": "google-vertex",
    "id": "gemini-2.5-flash"
  },
  "reasoningEffort": "low"
}
```

Project settings replace global settings. Environment variables replace both JSON files.

| Variable | Default |
| --- | --- |
| `READ_SHUNT_PI_PROVIDER` | `google-vertex` |
| `READ_SHUNT_PI_MODEL` | `gemini-2.5-flash` |
| `READ_SHUNT_PI_REASONING_EFFORT` | `low` |
| `READ_SHUNT_THRESHOLD_CHARS` | `12000` |
| `READ_SHUNT_THRESHOLD_LINES` | `350` |
| `READ_SHUNT_MAX_SUMMARY_CHARS` | `4000` |
| `READ_SHUNT_TIMEOUT_MS` | `30000` |
| `READ_SHUNT_STATS_FILE` | `~/.local/state/pi/read-shunt/read-shunt.jsonl` |

## Savings log

Each shunt writes one console line. It also appends JSON to:

- OpenCode: `~/.local/state/opencode/read-shunt.jsonl`
- Codex: plugin data directory `read-shunt.jsonl`
- Pi: `~/.local/state/pi/read-shunt/read-shunt.jsonl`

Each replacement reports current and session estimates. Estimates cover avoided main-context input only.
Concurrent Codex hooks can overwrite a session update. Codex session totals are best-effort estimates.
OpenCode and Codex logs do not include worker usage. Pi logs include worker tokens and cost.
Result-size estimates do not prove net cost savings.

## Evals

The provider-free eval suite runs with `bun test`. CI runs this suite for each change.

A live Codex smoke test used `gpt-5.6-luna` on 28,413 characters.
The replacement had 3,138 characters and reduced the main context by 88.95%.
The hook estimated that it kept 6,319 tokens out of the main context.
The worker completed in 7.6 seconds. The hook did not receive worker token usage.

An installed Codex lifecycle test used `cat bun.lock` in 2 ephemeral sessions.
The model saw the marker only when the plugin returned the shunted result.
Input usage fell from 43,882 tokens to 25,217 tokens, a 42.53% reduction.
The event stream still contained raw command output for telemetry.

A Pi lifecycle test used the native `read` tool on `bun.lock` with Pi 0.80.7.
The adapter reduced 51,237 result characters to 512 characters, a 99.00% reduction.
The final answer preserved all three required package names.
The worker call cost $0.00183978. It completed in 2.6 seconds.

The live eval uses a real main model and the configured worker model. It spends tokens.

```bash
READ_SHUNT_EVAL_MODEL="google-vertex/claude-sonnet-4-6@default#low" bun run eval:live
```

The live eval checks the hook marker and 3 exact names in the final response.
