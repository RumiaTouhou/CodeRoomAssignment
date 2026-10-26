/** Native controls for manual playback of the bundled sound assets. */
export function SoundAudition() {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-ink-invert/15 bg-ink px-3 py-2 text-ink-invert">
      <span className="cr-label text-[9.5px] text-ink-invert/50">
        Dev-only asset audition — not part of the product UI
      </span>
      <label className="flex items-center gap-2 text-[11.5px] text-ink-invert/70">
        <span className="font-mono text-[10.5px]">NewMsg.wav · incoming</span>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio controls preload="none" src="/sounds/NewMsg.wav" className="h-7 w-52" />
      </label>
      <label className="flex items-center gap-2 text-[11.5px] text-ink-invert/70">
        <span className="font-mono text-[10.5px]">EnterRoom.wav · joined / returned</span>
        <audio controls preload="none" src="/sounds/EnterRoom.wav" className="h-7 w-52" />
      </label>
      <label className="flex items-center gap-2 text-[11.5px] text-ink-invert/70">
        <span className="font-mono text-[10.5px]">LeaveRoom.wav · left</span>
        <audio controls preload="none" src="/sounds/LeaveRoom.wav" className="h-7 w-52" />
      </label>
      <label className="flex items-center gap-2 text-[11.5px] text-ink-invert/70">
        <span className="font-mono text-[10.5px]">MyMsgSent.wav · outgoing (reserved)</span>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio controls preload="none" src="/sounds/MyMsgSent.wav" className="h-7 w-52" />
      </label>
    </div>
  );
}
