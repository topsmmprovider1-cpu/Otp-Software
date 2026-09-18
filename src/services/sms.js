const { sanitizeOtpMessage, buildPullUrl } = require('../helpers');

// Regex: matches 4-8 contiguous digits, OR two adjacent 3-digit groups separated by a space (e.g. "751 333")
const OTP_RE = /\b(\d{4,8}|\d{3} \d{3})\b/g;

function normalizeOtp(raw) {
  if (!raw) return null;
  const val = String(raw).replace(/\s+/g, '');
  if (/^\d{4,8}$/.test(val)) return val;
  return null;
}

function extractOtpFromAny(json, text) {
  // ---- helpers ----
  const getDigits = (val) => {
    if (val == null) return null;
    const str = String(val).trim();
    if (!str) return null;
    // Try stripping spaces (e.g. "751 333")
    const stripped = str.replace(/\s+/g, '');
    if (/^\d{4,8}$/.test(stripped)) return stripped;
    // Scan string with pattern
    const matches = [...str.matchAll(OTP_RE)].map((m) => m[1].replace(/\s+/g, ''));
    for (const m of matches) {
      if (/^\d{4,8}$/.test(m) && !/^(202[4-9]|203[0-9])$/.test(m) && !['200', '404', '500'].includes(m)) {
        return m;
      }
    }
    return null;
  };

  // ---- search structured JSON ----
  if (json && typeof json === 'object') {
    const data = json.data || json;

    // Priority 1: dedicated OTP fields
    const priority = [
      data.code, data.otp, data.sms, data.sms_code, data.verify_code,
      data.verification_code, data.data?.code, data.data?.otp, data.data?.sms,
    ];
    for (const c of priority) {
      if (c != null && c !== '') {
        const code = getDigits(c);
        if (code) return code;
      }
    }

    // If code field is explicitly empty and msg says "no code" → definitely no OTP
    const noOtpSignal =
      (data.code === '' && (json.msg && /no\s+(verification|code|otp|sms)/i.test(json.msg))) ||
      (json.msg && /no\s+(verification|code|otp|sms)/i.test(json.msg) && !json.msg.toLowerCase().includes('ok'));
    if (noOtpSignal) return null;

    // Priority 2: message/msg fields (only if they seem to contain an actual SMS body)
    const msgFields = [data.message, data.msg, json.message, json.msg];
    for (const m of msgFields) {
      if (typeof m === 'string' && m && !/no\s+(verification|code|otp|sms)/i.test(m) && m.length < 200) {
        const code = getDigits(m);
        if (code) return code;
      }
    }
  }

  // ---- fallback: scan raw text ----
  if (text && typeof text === 'string') {
    if (/no\s+(verification|code|otp|sms)/i.test(text) &&
        !/\b(ok|success|received)\b/i.test(text)) return null;
    // Remove date/time values before scanning
    const cleaned = text
      .replace(/"[^"]*(?:date|time)[^"]*"\s*:\s*"[^"]*"/gi, '')
      .replace(/\d{4}-\d{2}-\d{2}/g, '')
      .replace(/\d{2}:\d{2}:\d{2}/g, '');
    const matches = [...cleaned.matchAll(OTP_RE)].map((m) => m[1].replace(/\s+/g, ''));
    for (const m of matches) {
      if (/^\d{4,8}$/.test(m) && !['200', '404', '500', '201'].includes(m)) {
        if (!/^(202[0-9]|203[0-9])$/.test(m)) return m;
      }
    }
  }
  return null;
}

async function fetchSms(apiUrl, number = '', options = {}) {
  const targetUrl = buildPullUrl(apiUrl, number, options);
  if (!targetUrl) return { ok: false, otp: '', message: 'No API URL configured for this service/number', raw: null };
  try {
    const timeoutMs = options.timeoutMs || 12000;
    const res = await fetch(targetUrl, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', ...(options.headers || {}) } });
    if (!res.ok) return { ok: false, otp: '', message: `HTTP ${res.status}`, raw: null, error: `HTTP ${res.status}` };
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }

    const otp = extractOtpFromAny(json, text);

    // extract human-readable SMS message for logging
    let msg = 'Waiting for OTP';
    if (json) {
      const data = json.data || json;
      if (typeof data.code === 'string' && data.code) msg = data.code;
      else if (typeof data.msg === 'string' && data.msg) msg = data.msg;
      else if (typeof json.msg === 'string' && json.msg) msg = json.msg;
      else if (typeof data.sms === 'string' && data.sms) msg = data.sms;
      else if (typeof data.message === 'string' && data.message) msg = data.message;
    }

    return {
      ok: !!otp,
      otp: otp || '',
      message: sanitizeOtpMessage(msg),
      raw: text,
    };
  } catch (err) {
    return { ok: false, otp: '', message: 'Connection error', raw: null, error: err.message };
  }
}

module.exports = { fetchSms, extractOtpFromAny };