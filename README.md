# Voice Agent for Restaurant (Next.js + LiveKit + Postgres Memory)

This repo is a **full voice agent** you can talk to from a browser:

- **Next.js web app** joins a LiveKit room, publishes your mic, plays remote audio, and shows transcript.
- **LiveKit Agent worker (Node.js)** joins the same room as a bot participant and speaks back.
- **Postgres + pgvector memory (Prisma)** stores sessions/messages + vector memory (RAG).

## Repo structure

- `apps/web`: Next.js UI
- `apps/agent`: LiveKit Agents worker
- `packages/db`: Prisma schema + shared DB client
- `docker-compose.yml`: optional local Postgres (requires Docker)

## Prerequisites

- Node.js 20+ (this repo was developed with Node 24)
- pnpm 10+
- A LiveKit Cloud project (URL + API key/secret)
- A Postgres database (local, Supabase, Neon, etc.)
  - Must support `pgvector` (the `vector` extension)

## Security notes (important)

- **Do not commit `.env` files.** This repo ignores them via `.gitignore`.
- If you ever pasted keys into logs/chat, **rotate** them in LiveKit and OpenAI immediately.

## Environment setup

You will create three local env files:

- `apps/web/.env.local`
- `apps/agent/.env`
- `packages/db/.env`

Use `apps/web/.env.example` and `apps/agent/.env.example` as templates.

### 1) `apps/web/.env.local`

```bash
NEXT_PUBLIC_LIVEKIT_URL="wss://YOUR_PROJECT.livekit.cloud"

# Server-only
LIVEKIT_URL="wss://YOUR_PROJECT.livekit.cloud"
LIVEKIT_API_KEY="..."
LIVEKIT_API_SECRET="..."

# Used by embeddings in long-term memory (RAG)
OPENAI_API_KEY="..."

# Postgres connection (see database section below)
DATABASE_URL="postgresql://..."
```

### 2) `apps/agent/.env`

```bash
LIVEKIT_URL="wss://YOUR_PROJECT.livekit.cloud"
LIVEKIT_API_KEY="..."
LIVEKIT_API_SECRET="..."

# Used by embeddings in long-term memory (RAG)
OPENAI_API_KEY="..."

DATABASE_URL="postgresql://..."
```

### 3) `packages/db/.env`

```bash
DATABASE_URL="postgresql://..."
```

## Database setup (Postgres + pgvector)

### Option A: Supabase (recommended if Docker/local Postgres isn’t available)

1) Create a Supabase project
2) Enable pgvector in **Supabase SQL Editor**:

```sql
create extension if not exists vector;
```

3) Use a connection string in `DATABASE_URL`.

If your network blocks outbound port **5432**, use Supabase **Connection Pooler** (port **6543**).

Example (pooler):

```text
postgresql://USER:PASSWORD@aws-...pooler.supabase.com:6543/postgres?sslmode=require&pgbouncer=true
```

Note: if your password contains special characters like `@`, URL-encode them (e.g. `@` → `%40`).

### Option B: Local Postgres (Docker)

If Docker is installed, you can run local Postgres with pgvector:

```bash
docker compose up -d
```

Then use:

```text
postgresql://postgres:postgres@localhost:5432/voice_agent?schema=public
```

### Create tables (Prisma)

From repo root:

```bash
pnpm install

# Create/update tables
pnpm --filter db exec prisma db push --schema prisma/schema.prisma

# Generate Prisma client
pnpm --filter db exec prisma generate --schema prisma/schema.prisma
```

## One-time agent model download

LiveKit’s turn detector needs local model files. Run once:

```bash
pnpm --filter agent download-files
```

## Run the app

You need **two terminals**.

### Terminal 1: Web UI

```bash
pnpm dev:web
```

Open the printed URL (usually `http://localhost:3000`).

### Terminal 2: Agent worker

```bash
pnpm dev:agent
```

Now in the browser:

- Click **Start**
- Speak into your mic
- You should see transcript lines and hear the agent speak back

## Memory (RAG) notes

- Conversation messages are persisted in Postgres (sessions + messages).
- Long-term memory uses **pgvector** embeddings and similarity search.
- Embeddings currently use `OPENAI_API_KEY`. If your OpenAI quota is exhausted, the agent can still talk, but memory embedding/retrieval will not work until you add billing or swap embeddings to another provider.

## Common issues / troubleshooting

### “Hydration failed…”

Hard refresh the page (Cmd+Shift+R). Ensure you’re running the latest dev server (no old server on another port).

### Web UI shows connected but no speech

- Ensure the agent is running (`pnpm dev:agent`)
- Check the agent logs for provider errors
- Browser may block autoplay audio: click anywhere on the page or allow autoplay

### Prisma can’t reach Supabase (P1001)

Your network may block port 5432. Use the **pooler** URL (6543) or switch networks/VPN.

### GitHub push blocked (secrets)

Never commit `.env` files or real keys. Only commit `.env.example` with empty values.

## Useful scripts (repo root)

- `pnpm dev:web`: start Next.js app
- `pnpm dev:agent`: start agent worker
- `pnpm --filter db exec prisma db push --schema prisma/schema.prisma`: create/update DB tables
- `pnpm --filter agent download-files`: download required agent model files

