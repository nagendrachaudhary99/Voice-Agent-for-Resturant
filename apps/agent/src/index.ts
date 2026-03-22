import "dotenv/config";

import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  inference,
  llm,
  voice,
} from "@livekit/agents";
import * as livekit from "@livekit/agents-plugin-livekit";
import * as silero from "@livekit/agents-plugin-silero";
import { fileURLToPath } from "node:url";

import { db } from "db";

import { embedText, saveMemoryChunk, saveMemoryEmbedding, searchMemory } from "./memory.js";

function textFromChatContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (typeof c === "string" ? c : ""))
    .filter(Boolean)
    .join("");
}

async function tryGetSessionIdByRoomName(roomName: string): Promise<string | null> {
  try {
    const session = await db.agentSession.findUnique({
      where: { roomName },
      select: { id: true },
    });
    return session?.id ?? null;
  } catch {
    return null;
  }
}

async function trySaveMessage(args: {
  sessionId: string | null;
  role: "user" | "assistant" | "system";
  content: string;
}) {
  const { sessionId, role, content } = args;
  if (!sessionId) return;
  if (!content.trim()) return;
  try {
    await db.message.create({
      data: { sessionId, role, content },
      select: { id: true },
    });
  } catch {
    // ignore if DB isn't configured yet
  }
}

class MemoryAgent extends voice.Agent {
  constructor(private readonly memorySessionId: string | null) {
    super({
      instructions:
        "You are a friendly voice assistant. Keep answers concise and ask clarifying questions when needed.",
    });
  }

  override async onUserTurnCompleted(chatCtx: llm.ChatContext, newMessage: llm.ChatMessage) {
    const userText = textFromChatContent(newMessage.content);
    if (!userText.trim()) return;

    let embedding: number[];
    try {
      embedding = await embedText(userText);
    } catch {
      return;
    }

    // Save this utterance as a memory chunk (simple default). In a real app you'd
    // only store extracted facts / preferences.
    const saved = await saveMemoryChunk({
      sessionId: null,
      content: userText,
      metadata: { source: "user_utterance" },
    });
    if (saved) {
      try {
        await saveMemoryEmbedding({ chunkId: saved.chunkId, embedding });
      } catch {
        // ignore if DB not ready
      }
    }

    let memories: Array<{ content: string; distance: number }> = [];
    try {
      memories = await searchMemory({ embedding, topK: 5 });
    } catch {
      return;
    }

    const lines = memories
      .filter((m) => m.content.trim())
      .slice(0, 5)
      .map((m) => `- ${m.content}`)
      .join("\n");

    if (!lines) return;

    chatCtx.addMessage({
      role: "system",
      content: `Relevant memory (use only if helpful):\n${lines}`,
    });
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    await ctx.waitForParticipant();

    const roomName = ctx.room.name ?? "unknown_room";
    const sessionId = await tryGetSessionIdByRoomName(roomName);

    const agent = new MemoryAgent(sessionId);

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad! as silero.VAD,
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      // Use LiveKit Inference Gateway defaults (no OpenAI quota required).
      stt: new inference.STT({
        model: "deepgram/nova-3",
        language: "en",
        fallback: ["assemblyai/universal-streaming", "cartesia/ink-whisper"],
      }),
      llm: new inference.LLM({ model: "openai/gpt-4.1-mini" }),
      tts: new inference.TTS({
        model: "cartesia/sonic-3",
        voice: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc",
        fallback: ["rime/arcana"],
      }),
      useTtsAlignedTranscript: true,
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, async (ev) => {
      if (!ev.isFinal) return;
      const lp = ctx.room.localParticipant;
      if (!lp) return;
      const payload = new TextEncoder().encode(
        JSON.stringify({ type: "transcript", role: "user", text: ev.transcript })
      );
      await lp.publishData(payload, { reliable: true });
      await trySaveMessage({ sessionId, role: "user", content: ev.transcript });
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, async (ev) => {
      if (ev.item.type !== "message") return;
      if (ev.item.role !== "assistant") return;
      const text = textFromChatContent(ev.item.content);
      if (!text.trim()) return;
      const lp = ctx.room.localParticipant;
      if (!lp) return;
      const payload = new TextEncoder().encode(
        JSON.stringify({ type: "transcript", role: "assistant", text })
      );
      await lp.publishData(payload, { reliable: true });
      await trySaveMessage({ sessionId, role: "assistant", content: text });
    });

    await session.start({ agent, room: ctx.room });
    session.say("Hi! I’m connected. How can I help?");
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));

