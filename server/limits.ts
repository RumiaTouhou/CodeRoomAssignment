export interface ServerRateLimits {
  readonly session: number;
  readonly connection: number;
  readonly frame: number;
  readonly message: number;
  readonly reaction: number;
  readonly typing: number;
  readonly search: number;
}

export const DEFAULT_RATE_LIMITS: ServerRateLimits = {
  session: 10,
  connection: 30,
  frame: 60,
  message: 8,
  reaction: 20,
  typing: 20,
  search: 20,
};

interface Bucket {
  count: number;
  readonly endsAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  consume(key: string, limit: number, windowMs: number, now: number): number | null {
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.endsAt <= now) {
      if (!bucket && this.buckets.size >= 4096) {
        this.prune(now);
        if (this.buckets.size >= 4096) return windowMs;
      }
      bucket = { count: 0, endsAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= limit) return Math.max(1, bucket.endsAt - now);
    bucket.count += 1;
    return null;
  }

  prune(now: number): void {
    for (const [key, bucket] of this.buckets) if (bucket.endsAt <= now) this.buckets.delete(key);
  }
}
