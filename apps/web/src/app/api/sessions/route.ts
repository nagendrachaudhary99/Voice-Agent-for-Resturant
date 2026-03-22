import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "db";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    roomName: z.string().min(1).optional(),
  })
  .optional()
  .nullable();

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsedBody = bodySchema.safeParse(json);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }

  const roomName =
    parsedBody.data?.roomName ?? `room_${crypto.randomUUID()}`;

  const session = await db.agentSession.create({
    data: { roomName },
    select: { id: true, roomName: true, createdAt: true },
  });

  return NextResponse.json(session);
}

