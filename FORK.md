# pi-web-access-slim

This branch is a prompt-surface fork of `nicobailon/pi-web-access` based on
`v0.25.0`.

The runtime search, extraction, storage, source-check, curator, and summary
implementations remain upstream-owned. This fork narrows only the tools exposed
to the agent:

- `web_search` always follows the configured/default provider route.
- `web_search` always follows the configured workflow; the agent cannot request
  browser curation for an individual call.
- Provider enumerations are removed from agent-visible search schemas.
- Video analysis, frame extraction, and video-model parameters are removed from
  the agent-visible `fetch_content` schema and prompt metadata.
- Slash commands and curator UI remain available for explicit user operation.

User configuration should set `workflow` to `auto-summary` when summaries are
wanted without browser confirmation, and should set `youtube.enabled` and
`video.enabled` to `false` when those runtime paths are unavailable.
