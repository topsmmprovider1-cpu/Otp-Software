// Minimal in-memory fixed-window rate limiter.
// Buckets are keyed by IP (optionally scoped by api key / user id) per route group.

const buckets = new Map();

const sweep = () => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
};
const timer = setInterval(sweep, 60 * 1000);
if (timer && typeof timer.unref === 'function') timer.unref();

// key for a per-IP bucket, optionally scoped to the authenticated user / api key
const ipKey = (req) => req.ip || req.socket?.remoteAddress || 'unknown';
const userKey = (req) => ipKey(req) + ':' + (req.userId || req.user?.id || 'anon') + ':' + (req.apiKey?.id || '');

function rateLimit(opts) {
  opts = opts || {};
  const windowMs = opts.windowMs || 60 * 1000;
  const max = opts.max || 100;
  const message = opts.message || 'Too many requests. Please slow down and try again later.';
  const status = opts.status || 429;
  const scope = opts.scope ? ':' + opts.scope : '';
  const keyFn = opts.keyFn || userKey;
  const v1 = !!opts.v1;

  return (req, res, next) => {
    const k = keyFn(req) + scope;
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(k, b);
    }
    b.count++;
    if (b.count > max) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((b.resetAt - now) / 1000)));
      return res.status(status).json(v1
        ? { success: false, error: message }
        : { error: message });
    }
    next();
  };
}

module.exports = { rateLimit, ipKey, userKey };