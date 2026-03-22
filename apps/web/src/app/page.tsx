import VoiceClient from "@/components/VoiceClient";

export default function Home() {
  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
            Voice agent playground
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Create a session, join a LiveKit room, and talk. The agent worker
            will join the same room.
          </p>
        </header>

        <VoiceClient />
      </main>
    </div>
  );
}
