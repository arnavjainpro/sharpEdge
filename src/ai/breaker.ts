// Financial circuit breaker: hard-stops AI spend if call volume goes anomalous
// (e.g. a feed glitch replaying the same filing 50 times). Trips permanently
// until manually reset: monitoring continues, AI calls stop.

type TripHandler = (name: string, count: number, windowSec: number) => void;
let onTrip: TripHandler = () => {};
export function setTripHandler(fn: TripHandler) {
  onTrip = fn;
}

export class CircuitBreaker {
  private timestamps: number[] = [];
  tripped = false;
  trippedAt: number | null = null;

  constructor(
    public readonly name: string,
    private readonly maxCalls: number,
    private readonly windowMs: number
  ) {}

  // Returns true if the call is allowed. Records the attempt.
  allow(): boolean {
    if (this.tripped) return false;
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    this.timestamps.push(now);
    if (this.timestamps.length > this.maxCalls) {
      this.tripped = true;
      this.trippedAt = now;
      console.error(
        `[breaker] ${this.name} TRIPPED: ${this.timestamps.length} calls in ${this.windowMs / 1000}s (limit ${this.maxCalls})`
      );
      onTrip(this.name, this.timestamps.length, this.windowMs / 1000);
      return false;
    }
    return true;
  }

  reset() {
    this.tripped = false;
    this.trippedAt = null;
    this.timestamps = [];
    console.log(`[breaker] ${this.name} manually reset`);
  }

  status() {
    return { name: this.name, tripped: this.tripped, trippedAt: this.trippedAt };
  }
}

// Opus is the expensive engine: >10 calls/min means something is broken upstream.
export const opusBreaker = new CircuitBreaker("opus", 10, 60_000);
// Haiku is cheap but a runaway loop is still a bug worth halting.
export const haikuBreaker = new CircuitBreaker("haiku", 30, 60_000);
