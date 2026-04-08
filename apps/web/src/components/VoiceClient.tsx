"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createLocalAudioTrack,
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";

type SessionResponse = {
  id: string;
  roomName: string;
  createdAt: string;
};

type TokenResponse = {
  token: string;
  url: string;
};

type TranscriptItem = {
  ts: number;
  from: string;
  text: string;
};

type ToolEvent = {
  ts: number;
  name: string;
  payload: unknown;
};

export default function VoiceClient() {
  const [status, setStatus] = useState<
    "idle" | "creating_session" | "connecting" | "connected" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [identity, setIdentity] = useState<string>("");
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);

  const roomRef = useRef<Room | null>(null);
  const localMicRef = useRef<MediaStreamTrack | null>(null);
  const audioContainerRef = useRef<HTMLDivElement | null>(null);

  const roomName = session?.roomName ?? "";

  useEffect(() => {
    const key = "lk_identity";
    const existing = window.localStorage.getItem(key);
    if (existing) {
      setIdentity(existing);
      return;
    }
    const id = `web_${crypto.randomUUID()}`;
    window.localStorage.setItem(key, id);
    setIdentity(id);
  }, []);

  const canStart = identity !== "" && (status === "idle" || status === "error");
  const canStop = status === "connected" || status === "connecting";

  const start = useCallback(async () => {
    setError(null);
    setTranscript([]);
    setToolEvents([]);

    try {
      setStatus("creating_session");
      const sessionRes = await fetch("/api/sessions", { method: "POST" });
      if (!sessionRes.ok) throw new Error("Failed to create session");
      const createdSession = (await sessionRes.json()) as SessionResponse;
      setSession(createdSession);

      setStatus("connecting");
      const tokenRes = await fetch("/api/livekit/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ room: createdSession.roomName, identity }),
      });
      if (!tokenRes.ok) throw new Error("Failed to mint LiveKit token");
      const { token, url } = (await tokenRes.json()) as TokenResponse;

      const room = new Room();
      roomRef.current = room;

      room.on(RoomEvent.DataReceived, (payload, participant) => {
        const decoded = new TextDecoder().decode(payload);
        try {
          const msg = JSON.parse(decoded) as unknown;
          if (
            typeof msg === "object" &&
            msg !== null &&
            // @ts-expect-error runtime guard below
            (msg.type === "transcript" || msg.type === "tool")
          ) {
            // @ts-expect-error runtime guard above
            if (msg.type === "tool") {
              setToolEvents((e) => [
                ...e,
                {
                  ts: Date.now(),
                  // @ts-expect-error runtime guard above
                  name: typeof msg.name === "string" ? msg.name : "tool",
                  payload: msg,
                },
              ]);
              return;
            }

            // transcript
            // @ts-expect-error runtime guard above
            if (typeof msg.text === "string") {
              setTranscript((t) => [
                ...t,
                {
                  ts: Date.now(),
                  from: participant?.identity ?? "unknown",
                  // @ts-expect-error runtime guard above
                  text: msg.text,
                },
              ]);
            }
            return;
          }
        } catch {
          // fall through to plain-text transcript line
        }
        setTranscript((t) => [
          ...t,
          {
            ts: Date.now(),
            from: participant?.identity ?? "unknown",
            text: decoded,
          },
        ]);
      });

      room.on(
        RoomEvent.TrackSubscribed,
        (
          track: RemoteTrack,
          _pub: RemoteTrackPublication,
          _participant: RemoteParticipant
        ) => {
          if (track.kind !== Track.Kind.Audio) return;
          const container = audioContainerRef.current;
          if (!container) return;
          const el = track.attach();
          el.setAttribute("data-lk-audio", "true");
          el.autoplay = true;
          container.appendChild(el);
        }
      );

      room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        if (track.kind !== Track.Kind.Audio) return;
        track.detach().forEach((el) => el.remove());
      });

      await room.connect(url, token);

      const mic = await createLocalAudioTrack();
      localMicRef.current = mic.mediaStreamTrack;
      await room.localParticipant.publishTrack(mic);

      setStatus("connected");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      setError(message);
      setStatus("error");
    }
  }, [identity]);

  const stop = useCallback(async () => {
    setError(null);
    setStatus("idle");

    try {
      localMicRef.current?.stop();
      localMicRef.current = null;

      const room = roomRef.current;
      roomRef.current = null;

      room?.disconnect();

      const container = audioContainerRef.current;
      if (container) {
        container.querySelectorAll('[data-lk-audio="true"]').forEach((n) => {
          n.remove();
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      setError(message);
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    return () => {
      void stop();
    };
  }, [stop]);

  const badge = useMemo(() => {
    switch (status) {
      case "idle":
        return "Idle";
      case "creating_session":
        return "Creating session…";
      case "connecting":
        return "Connecting…";
      case "connected":
        return "Connected";
      case "error":
        return "Error";
    }
  }, [status]);

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              Status: <span className="font-semibold">{badge}</span>
            </div>
            <div className="text-xs text-zinc-600 dark:text-zinc-400">
              Identity:{" "}
              <span className="font-mono">{identity || "loading..."}</span>
              {roomName ? (
                <>
                  {" "}
                  · Room: <span className="font-mono">{roomName}</span>
                </>
              ) : null}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              className="inline-flex h-10 items-center justify-center rounded-xl bg-zinc-900 px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-950"
              disabled={!canStart}
              onClick={() => void start()}
            >
              Start
            </button>
            <button
              className="inline-flex h-10 items-center justify-center rounded-xl border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
              disabled={!canStop}
              onClick={() => void stop()}
            >
              Stop
            </button>
          </div>
        </div>

        {error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-200">
            {error}
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Transcript (data messages)
            </div>
            <div className="h-56 overflow-auto rounded-lg bg-zinc-50 p-2 text-sm text-zinc-900 dark:bg-black/40 dark:text-zinc-100">
              {transcript.length === 0 ? (
                <div className="text-zinc-500 dark:text-zinc-400">
                  No transcript yet. Once the agent worker is running, it will
                  send transcript lines here.
                </div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {transcript.map((t) => (
                    <li key={t.ts} className="leading-snug">
                      <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                        {t.from}
                      </span>{" "}
                      <span>{t.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Tools / cart events
            </div>
            <div className="h-56 overflow-auto rounded-lg bg-zinc-50 p-2 text-xs text-zinc-900 dark:bg-black/40 dark:text-zinc-100">
              {toolEvents.length === 0 ? (
                <div className="text-zinc-500 dark:text-zinc-400">
                  No tool events yet. When the agent calls tools (menu/cart/order),
                  they’ll appear here.
                </div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {toolEvents.map((e) => (
                    <li key={e.ts} className="leading-snug">
                      <div className="font-mono text-zinc-600 dark:text-zinc-400">
                        {e.name}
                      </div>
                      <pre className="whitespace-pre-wrap break-words text-[11px]">
                        {JSON.stringify(e.payload, null, 2)}
                      </pre>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Audio
          </div>
          <div className="text-sm text-zinc-600 dark:text-zinc-400">
            Your mic is published when connected. Remote audio (agent speech)
            will autoplay here.
          </div>
          <div ref={audioContainerRef} className="mt-3" />
        </div>
      </div>
    </section>
  );
}

