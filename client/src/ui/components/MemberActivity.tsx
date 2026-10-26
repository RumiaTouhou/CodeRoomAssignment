import { LogIn, LogOut, RotateCcw } from "lucide-react";

interface MemberActivityProps {
  readonly items: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly kind: "joined" | "left" | "returned";
  }[];
}

export function MemberActivity({ items }: MemberActivityProps) {
  if (items.length === 0) return null;
  return (
    <div role="status" aria-label="Member activity" className="shrink-0 border-b border-line/70 bg-paper">
      <div className="mx-auto flex w-full max-w-[880px] flex-wrap gap-x-4 gap-y-1 px-3 py-1.5 text-[11.5px] text-ink-faint sm:px-4">
        {items.slice(-3).map((item) => {
          const Icon = item.kind === "left" ? LogOut : item.kind === "returned" ? RotateCcw : LogIn;
          return <span key={item.id} className="flex min-w-0 max-w-full items-center gap-1.5"><Icon className="h-3 w-3 shrink-0" aria-hidden="true" /><span className="truncate">{item.displayName} {item.kind}</span></span>;
        })}
      </div>
    </div>
  );
}
