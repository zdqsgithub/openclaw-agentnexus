# AgentNexus OpenClaw Runtime

This directory defines the AgentNexus-specific cloud runtime profile for the
`zdqsgithub/openclaw-agentnexus` fork.

The goal is to keep upstream OpenClaw close to source while maintaining a small,
explicit adapter layer for AgentNexus single-tenant cloud deployment.

## Contract

- OpenAI-compatible chat endpoint: `/v1/chat/completions`
- Model list endpoint: `/v1/models`
- Liveness endpoint: `/healthz`
- Default model: `moonshotai/kimi-k2.6`
- Fallback model: `moonshotai/kimi-k2.5`
- Required secret: `OPENROUTER_API_KEY`
- Runtime port: `18789`

## Deployment Profiles

- `Dockerfile.agentnexus` is the canonical AgentNexus runtime image.
- `railway.json` points Railway at `Dockerfile.agentnexus`.
- Railway service creation should also set
  `RAILWAY_DOCKERFILE_PATH=Dockerfile.agentnexus` because `railway add --repo`
  can trigger the first build before later variable updates.

## Maintenance Rules

- Do not reintroduce BuildKit-only `RUN --mount=type=bind` into
  `Dockerfile.agentnexus`.
- Do not rely on provider-specific IPv6 behavior. The launcher handles the
  Fly.io/OpenRouter dual-stack issue when `OPENCLAW_DISABLE_DNS_PINNING=1`.
- Keep AgentNexus behavior controlled by env vars instead of invasive core
  rewrites where possible.
- After syncing upstream, run the AgentNexus Railway and Fly smoke tests before
  promoting the fork.
