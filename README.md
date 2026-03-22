# Next.js LiveKit voice agent (Postgres memory)

Monorepo:
- `apps/web`: Next.js UI (joins LiveKit room, mic, transcript)
- `apps/agent`: LiveKit agent worker (OpenAI STT/LLM/TTS)
- `packages/db`: Postgres + pgvector memory (Prisma)

