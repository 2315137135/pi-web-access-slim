# pi-web-access-slim

This branch is a prompt-surface fork of `nicobailon/pi-web-access` based on
`v0.25.0`.

The runtime search, extraction, and storage implementations remain
upstream-owned. This fork narrows only the tools exposed to the agent:

- `web_search` always follows the configured/default provider route.
- Provider enumerations are removed from agent-visible search schemas.
- Video analysis, frame extraction, and video-model parameters are removed from
  the agent-visible `web_fetch` schema and prompt metadata.
- Slash commands remain available for explicit user operation.

User configuration should set `youtube.enabled` and `video.enabled` to `false`
when those runtime paths are unavailable.
