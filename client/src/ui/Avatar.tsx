import type { PublicUser } from "../contract.js";
import { initialsOf, seedHash } from "./format.js";

interface AvatarProps {
  readonly user: PublicUser;
  readonly size?: "sm" | "md";
}

/** Initials and avatarSeed determine the avatar appearance. */
export function Avatar({ user, size = "md" }: AvatarProps) {
  const hue = Math.round(seedHash(user.avatarSeed) * 360);
  const box = size === "sm" ? "h-6 w-6 text-[10px]" : "h-8 w-8 text-[11px]";
  return (
    <span
      aria-hidden="true"
      className={`${box} cr-label flex shrink-0 select-none items-center justify-center rounded-full`}
      style={{
        backgroundColor: `oklch(0.9 0.045 ${hue})`,
        color: `oklch(0.38 0.07 ${hue})`,
      }}
    >
      {initialsOf(user.displayName)}
    </span>
  );
}
