import OpenAI from "openai";

import { db } from "db";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIM = 1536;

function toVectorLiteral(embedding: number[]): string {
  if (embedding.length !== EMBEDDING_DIM) {
    throw new Error(
      `Unexpected embedding dimension: ${embedding.length} (expected ${EMBEDDING_DIM})`
    );
  }

  const safe = embedding.map((v) => {
    if (!Number.isFinite(v)) throw new Error("Invalid embedding value");
    return v;
  });
  return `[${safe.join(",")}]`;
}

function openaiClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  return new OpenAI({ apiKey });
}

export async function embedText(text: string): Promise<number[]> {
  const client = openaiClient();
  const res = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  const vec = res.data[0]?.embedding;
  if (!vec) throw new Error("No embedding returned");
  return vec;
}

export async function saveMemoryChunk(args: {
  sessionId: string | null;
  content: string;
  metadata?: unknown;
}): Promise<{ chunkId: string } | null> {
  const { sessionId, content, metadata } = args;
  if (!content.trim()) return null;

  try {
    const chunk = await db.memoryChunk.create({
      data: {
        sessionId: sessionId ?? null,
        content,
        metadata: metadata as any,
      },
      select: { id: true },
    });
    return { chunkId: chunk.id };
  } catch {
    return null;
  }
}

export async function saveMemoryEmbedding(args: {
  chunkId: string;
  embedding: number[];
}): Promise<void> {
  const { chunkId, embedding } = args;
  const id = crypto.randomUUID();
  const vec = toVectorLiteral(embedding);

  await db.$executeRawUnsafe(
    'INSERT INTO "MemoryEmbedding" ("id", "createdAt", "chunkId", "model", "embedding") VALUES ($1, NOW(), $2, $3, $4::vector(1536))',
    id,
    chunkId,
    EMBEDDING_MODEL,
    vec
  );
}

export async function searchMemory(args: {
  embedding: number[];
  topK?: number;
}): Promise<Array<{ chunkId: string; content: string; distance: number }>> {
  const { embedding, topK = 5 } = args;
  const vec = toVectorLiteral(embedding);

  const rows = (await db.$queryRawUnsafe(
    'SELECT mc.id as "chunkId", mc.content as "content", (me.embedding <-> $1::vector(1536)) as "distance" FROM "MemoryEmbedding" me JOIN "MemoryChunk" mc ON mc.id = me."chunkId" ORDER BY me.embedding <-> $1::vector(1536) LIMIT $2',
    vec,
    topK
  )) as Array<{ chunkId: string; content: string; distance: number }>;

  return rows;
}

