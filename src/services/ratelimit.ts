export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

/**
 * Extracts client IP securely from the CF-Connecting-IP header.
 * Prevents IP spoofing via X-Forwarded-For.
 */
export function getClientIp(headers: Headers): string {
  const cfIp = headers.get('cf-connecting-ip');
  if (cfIp) return cfIp.trim();
  return 'unknown-ip';
}

/**
 * Sliding/Fixed window rate limiter implemented on top of Cloudflare KV.
 * Supports configurable window duration and namespace prefix.
 */
export async function checkRateLimit(
  kv: KVNamespace,
  clientIp: string,
  maxRequests: number = 15,
  windowSeconds: number = 60,
  prefix: string = 'ratelimit'
): Promise<RateLimitResult> {
  if (!clientIp || clientIp === '127.0.0.1' || clientIp === 'localhost') {
    return {
      allowed: true,
      limit: maxRequests,
      remaining: maxRequests,
      resetSeconds: windowSeconds,
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const currentWindow = Math.floor(now / windowSeconds);
  const windowKey = `${prefix}:${clientIp}:${currentWindow}`;
  const ttl = Math.max(120, windowSeconds * 2);

  const currentCountStr = await kv.get(windowKey);
  const currentCount = currentCountStr ? parseInt(currentCountStr, 10) : 0;

  const secondsIntoWindow = now % windowSeconds;
  const resetSeconds = windowSeconds - secondsIntoWindow;

  if (currentCount >= maxRequests) {
    return {
      allowed: false,
      limit: maxRequests,
      remaining: 0,
      resetSeconds,
    };
  }

  // Increment counter
  const newCount = currentCount + 1;
  await kv.put(windowKey, newCount.toString(), { expirationTtl: ttl });

  return {
    allowed: true,
    limit: maxRequests,
    remaining: Math.max(0, maxRequests - newCount),
    resetSeconds,
  };
}
