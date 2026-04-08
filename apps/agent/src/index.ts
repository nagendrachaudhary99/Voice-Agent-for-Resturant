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
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";

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

type CartLine = {
  lineId: string;
  code: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  modifiers?: Record<string, unknown> | null;
  notes?: string | null;
};

function formatMoney(cents: number) {
  const dollars = (cents / 100).toFixed(2);
  return `$${dollars}`;
}

function computeTotals(lines: CartLine[]) {
  const subtotalCents = lines.reduce(
    (sum, l) => sum + l.unitPriceCents * l.quantity,
    0
  );
  const taxCents = 0;
  const totalCents = subtotalCents + taxCents;
  return { subtotalCents, taxCents, totalCents };
}

function toE164OrNull(phone: string): string | null {
  const cleaned = phone.trim();
  // Minimal E.164 check. Expect +<country><number>, 8-15 digits total.
  if (!/^\+[1-9]\d{7,14}$/.test(cleaned)) return null;
  return cleaned;
}

async function publishJson(room: JobContext["room"], obj: unknown) {
  const lp = room.localParticipant;
  if (!lp) return;
  const payload = new TextEncoder().encode(JSON.stringify(obj));
  await lp.publishData(payload, { reliable: true });
}

class MemoryAgent extends voice.Agent {
  private readonly cart: CartLine[] = [];
  private customerPhoneE164: string | null = null;

  constructor(
    private readonly memorySessionId: string | null,
    tools: llm.ToolContext
  ) {
    super({
      instructions:
        [
          "You are a phone ordering assistant for a restaurant.",
          "Your job is to help callers place pickup or delivery orders, answer menu questions,",
          "and take reservations if supported.",
          "",
          "Rules:",
          "- Be brief, clear, and fast.",
          "- Never invent menu items or prices.",
          "- Use tools for menu lookup, availability, cart changes, customer lookup, and order saving.",
          "- Confirm each item with quantity and modifiers.",
          "- Before finalizing, summarize the full order, total, and ETA.",
          "- Collect the customer phone number and save it with the order.",
          "- If the caller sounds frustrated, be calmer and more direct.",
          "- If the request is ambiguous, ask one concise question.",
        ].join("\n"),
      tools,
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

  addToCart(line: Omit<CartLine, "lineId">) {
    this.cart.push({ ...line, lineId: randomUUID() });
  }

  removeFromCart(lineId: string) {
    const idx = this.cart.findIndex((l) => l.lineId === lineId);
    if (idx === -1) return false;
    this.cart.splice(idx, 1);
    return true;
  }

  getCart() {
    return [...this.cart];
  }

  setPhone(phoneE164: string) {
    this.customerPhoneE164 = phoneE164;
  }

  getPhone() {
    return this.customerPhoneE164;
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

    const tools: llm.ToolContext = {
      menu_search: llm.tool({
        description: "Search menu items by name/category. Returns a short list.",
        parameters: z.object({
          query: z.string().min(1),
          limit: z.number().int().min(1).max(20).optional(),
        }),
        execute: async ({ query, limit = 10 }) => {
          const items = await db.menuItem.findMany({
            where: {
              OR: [
                { name: { contains: query, mode: "insensitive" } },
                { category: { contains: query, mode: "insensitive" } },
              ],
            },
            take: limit,
            orderBy: { name: "asc" },
            select: {
              code: true,
              name: true,
              category: true,
              description: true,
              priceCents: true,
              isAvailable: true,
              prepTimeMin: true,
            },
          });
          await publishJson(ctx.room, { type: "tool", name: "menu_search", query, count: items.length });
          return items.map((i) => ({
            ...i,
            price: formatMoney(i.priceCents),
          }));
        },
      }),

      menu_get_item: llm.tool({
        description: "Get a single menu item by code.",
        parameters: z.object({ code: z.string().min(1) }),
        execute: async ({ code }) => {
          const item = await db.menuItem.findUnique({
            where: { code },
            select: {
              code: true,
              name: true,
              category: true,
              description: true,
              priceCents: true,
              isAvailable: true,
              prepTimeMin: true,
            },
          });
          await publishJson(ctx.room, { type: "tool", name: "menu_get_item", code, found: Boolean(item) });
          if (!item) return { error: "NOT_FOUND" };
          return { ...item, price: formatMoney(item.priceCents) };
        },
      }),

      availability_check: llm.tool({
        description: "Check whether a menu item is currently available.",
        parameters: z.object({ code: z.string().min(1) }),
        execute: async ({ code }) => {
          const item = await db.menuItem.findUnique({
            where: { code },
            select: { code: true, name: true, isAvailable: true },
          });
          await publishJson(ctx.room, { type: "tool", name: "availability_check", code, available: item?.isAvailable ?? null });
          if (!item) return { error: "NOT_FOUND" };
          return { code: item.code, name: item.name, isAvailable: item.isAvailable };
        },
      }),
    };

    const agent = new MemoryAgent(sessionId, tools);

    // Cart tools depend on the per-agent state.
    agent.toolCtx.cart_add = llm.tool({
      description:
        "Add a menu item to the cart by code with quantity and optional modifiers.",
      parameters: z.object({
        code: z.string().min(1),
        quantity: z.number().int().min(1).max(20),
        modifiers: z.record(z.string(), z.any()).optional(),
        notes: z.string().max(500).optional(),
      }),
      execute: async ({ code, quantity, modifiers, notes }) => {
        const item = await db.menuItem.findUnique({
          where: { code },
          select: { code: true, name: true, priceCents: true, isAvailable: true },
        });
        if (!item) return { error: "NOT_FOUND" };
        if (!item.isAvailable) return { error: "NOT_AVAILABLE", code, name: item.name };

        const safeModifiers =
          modifiers !== undefined ? JSON.parse(JSON.stringify(modifiers)) : null;

        agent.addToCart({
          code: item.code,
          name: item.name,
          quantity,
          unitPriceCents: item.priceCents,
          modifiers: safeModifiers,
          notes: notes ?? null,
        });

        const cart = agent.getCart();
        const totals = computeTotals(cart);
        await publishJson(ctx.room, { type: "tool", name: "cart_add", code, quantity, totals });
        return {
          ok: true,
          added: { code: item.code, name: item.name, quantity },
          totals,
        };
      },
    });

    agent.toolCtx.cart_remove = llm.tool({
      description: "Remove a line item from the cart by lineId.",
      parameters: z.object({ lineId: z.string().min(1) }),
      execute: async ({ lineId }) => {
        const ok = agent.removeFromCart(lineId);
        const cart = agent.getCart();
        const totals = computeTotals(cart);
        await publishJson(ctx.room, { type: "tool", name: "cart_remove", lineId, ok, totals });
        return { ok, totals };
      },
    });

    agent.toolCtx.cart_summary = llm.tool({
      description: "Get a human-readable summary of the current cart and totals.",
      parameters: z.object({}),
      execute: async () => {
        const cart = agent.getCart();
        const totals = computeTotals(cart);
        const lines = cart.map((l) => ({
          lineId: l.lineId,
          code: l.code,
          name: l.name,
          quantity: l.quantity,
          unitPrice: formatMoney(l.unitPriceCents),
          modifiers: l.modifiers ?? undefined,
          notes: l.notes ?? undefined,
        }));
        await publishJson(ctx.room, { type: "tool", name: "cart_summary", totals, linesCount: lines.length });
        return {
          items: lines,
          subtotal: formatMoney(totals.subtotalCents),
          total: formatMoney(totals.totalCents),
          totals,
        };
      },
    });

    agent.toolCtx.customer_set_phone = llm.tool({
      description:
        "Set and validate the customer's phone number in E.164 format (e.g. +14155552671).",
      parameters: z.object({ phoneE164: z.string().min(1) }),
      execute: async ({ phoneE164 }) => {
        const normalized = toE164OrNull(phoneE164);
        if (!normalized) return { error: "INVALID_PHONE", hint: "Use E.164 like +14155552671" };
        agent.setPhone(normalized);
        await publishJson(ctx.room, { type: "tool", name: "customer_set_phone", phoneE164: normalized });
        return { ok: true, phoneE164: normalized };
      },
    });

    agent.toolCtx.order_save = llm.tool({
      description:
        "Save the current cart as an order. Requires customer phone number to be set first.",
      parameters: z.object({
        type: z.enum(["pickup", "delivery", "reservation"]),
        deliveryAddress: z.string().max(500).optional(),
        specialInstructions: z.string().max(1000).optional(),
      }),
      execute: async ({ type, deliveryAddress, specialInstructions }) => {
        const phone = agent.getPhone();
        if (!phone) return { error: "MISSING_PHONE", hint: "Collect phone number first." };

        const cart = agent.getCart();
        if (cart.length === 0) return { error: "EMPTY_CART" };

        const totals = computeTotals(cart);

        const customer = await db.customer.upsert({
          where: { phoneE164: phone },
          create: { phoneE164: phone },
          update: {},
          select: { id: true, phoneE164: true },
        });

        const order = await db.order.create({
          data: {
            type,
            status: "confirmed",
            sessionId: sessionId ?? null,
            customerId: customer.id,
            deliveryAddress: deliveryAddress ?? null,
            specialInstructions: specialInstructions ?? null,
            subtotalCents: totals.subtotalCents,
            taxCents: totals.taxCents,
            totalCents: totals.totalCents,
            items: {
              create: cart.map((l) => ({
                menuItem: { connect: { code: l.code } },
                name: l.name,
                unitPriceCents: l.unitPriceCents,
                quantity: l.quantity,
                modifiers: (l.modifiers ?? undefined) as any,
                notes: l.notes ?? undefined,
              })),
            },
          },
          select: { id: true, type: true, status: true, totalCents: true, createdAt: true },
        });

        await publishJson(ctx.room, {
          type: "tool",
          name: "order_save",
          orderId: order.id,
          total: formatMoney(order.totalCents ?? totals.totalCents),
        });

        return {
          ok: true,
          orderId: order.id,
          total: formatMoney(order.totalCents ?? totals.totalCents),
        };
      },
    });

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

