/** Milliseconds, or a string such as "500ms", "60s" or "2m". */
export type Duration = number | `${number}${"ms" | "s" | "m"}`;

const UNITS = { ms: 1, s: 1_000, m: 60_000 } as const;

function parse(duration: Duration): number {
  if (typeof duration === "number") return duration;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(duration);
  return match === null ? Number.NaN : Number(match[1]) * UNITS[match[2] as keyof typeof UNITS];
}

export function toMs(duration: Duration, what: string): number {
  const ms = parse(duration);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`${what} must be a positive duration, got ${JSON.stringify(duration)}`);
  }
  return ms;
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
