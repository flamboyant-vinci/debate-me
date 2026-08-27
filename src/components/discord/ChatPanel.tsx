"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/shared/types";
import { Avatar } from "./Shell";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Minimal inline markdown: **bold** and line breaks. Chat, not a document. */
function render(content: string) {
  return content.split("\n").map((line, i) => (
    <span key={i} className="block">
      {line.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
        part.startsWith("**") && part.endsWith("**") ? (
          <strong key={j} className="font-semibold text-bright">
            {part.slice(2, -2)}
          </strong>
        ) : (
          <span key={j}>{part}</span>
        ),
      )}
    </span>
  ));
}

export function ChatPanel({
  channelName,
  channelId,
  messages,
  onSend,
  placeholder,
  disabled,
  header,
}: {
  channelName: string;
  channelId: string;
  messages: ChatMessage[];
  onSend: (content: string) => void;
  placeholder?: string;
  disabled?: boolean;
  header?: React.ReactNode;
}) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const visible = messages.filter((m) => m.channelId === channelId);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [visible.length]);

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-chat">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-black/20 px-4 shadow-sm">
        <span className="text-xl text-muted">#</span>
        <span className="font-semibold text-bright">{channelName}</span>
        {header}
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {visible.length === 0 && (
          <p className="mt-8 text-center text-sm text-muted">
            Nothing here yet.
          </p>
        )}
        {visible.map((m, i) => {
          const prev = visible[i - 1];
          const grouped =
            prev && prev.authorId === m.authorId && m.ts - prev.ts < 5 * 60_000 && !m.system;

          if (m.system) {
            return (
              <div key={m.id} className="my-1 flex gap-2 px-1 py-0.5 text-sm text-muted">
                <span className="shrink-0 text-xs opacity-60">{formatTime(m.ts)}</span>
                <div className="italic">{render(m.content)}</div>
              </div>
            );
          }

          return (
            <div
              key={m.id}
              className={`group flex gap-3 px-1 hover:bg-black/10 ${grouped ? "py-0.5" : "mt-4 py-0.5"}`}
            >
              {grouped ? (
                <div className="w-10 shrink-0 text-right text-[10px] leading-6 text-muted opacity-0 group-hover:opacity-100">
                  {formatTime(m.ts)}
                </div>
              ) : (
                <Avatar name={m.authorName} color={m.authorColor} size={40} />
              )}
              <div className="min-w-0 flex-1">
                {!grouped && (
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium" style={{ color: m.authorColor }}>
                      {m.authorName}
                    </span>
                    <span className="text-[11px] text-muted">{formatTime(m.ts)}</span>
                  </div>
                )}
                <div className="text-[15px] leading-[1.4] break-words whitespace-pre-wrap text-normal">
                  {render(m.content)}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form
        className="px-4 pb-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          onSend(draft);
          setDraft("");
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={disabled}
          placeholder={disabled ? "You cannot talk here right now" : (placeholder ?? `Message #${channelName}`)}
          className="w-full rounded-lg bg-inputbg px-4 py-3 text-[15px] text-normal outline-none placeholder:text-muted disabled:opacity-50"
        />
      </form>
    </section>
  );
}
