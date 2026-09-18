const crypto = require('crypto');
const XLSX = require('xlsx');

// Numeric-only order id — pure digits (no prefix/letters), e.g. 41649726941215
function genOrderId() {
  const ts = Date.now().toString();
  const rnd = crypto.randomInt(0, 1000).toString().padStart(3, '0');
  return ts + rnd;
}

// Split a line like "+12089778478----https://api.sms8.net/api/record?token=abc"
// into { number, api_url }. Returns null if no separator found.
function splitNumberApiLine(line) {
  const s = String(line || '').trim();
  if (!s || !s.includes('----')) return null;
  const i = s.indexOf('----');
  const number = s.slice(0, i).trim();
  const apiUrl = s.slice(i + 4).trim();
  if (!number) return null;
  return { number, api_url: apiUrl };
}

// Parse a delimited line/row set into number rows.
// Auto-detect delimiter: | , ; TAB   (in that priority based on first data line).
// Optional header row is skipped.
// Expected columns: number, country, platform, price, api_url
function parseNumberRows(lines) {
  const rows = [];
  const errors = [];
  // split multiline text
  const all = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
  let delim = null;

  const detectDelim = (line) => {
    for (const d of ['|', ',', ';', '\t']) {
      if (line.includes(d)) return d;
    }
    return null;
  };

  const cleanCells = (cells) => cells.map((c) => String(c == null ? '' : c).trim());

  for (const raw of all) {
    const line = String(raw || '').trim();
    if (!line) continue;

    // number----url format (no country/platform) → handled outside this parser;
    // report a clear error here so the user adds via "New Service" instead.
    if (line.includes('----')) {
      const sep = splitNumberApiLine(line);
      if (sep) {
        errors.push('number----url format requires a platform & country — add these numbers via "＋ New Service" instead.');
        continue;
      }
    }

    if (!delim) delim = detectDelim(line) || ',';
    let cells = cleanCells(line.split(delim));
    // support empty trailing cells
    cells = cells.filter((c, i) => i < 5 || c);

    // skip header row (first cell must START with a known header word)
    if (/^(number|country|platform|price|api|url|mobile|phone|service)\b/i.test(cells[0] || '') && !/^\d/.test(cells[1] || '')) {
      continue;
    }
    const [number, country, platform, price, apiUrl] = cells;
    if (!number || !country || !platform) {
      if (line) errors.push(`Bad line: ${line}`);
      continue;
    }
    rows.push({
      number: number.trim(),
      country: country.trim(),
      platform: platform.trim(),
      price: parseFloat(price) || 0,
      api_url: (apiUrl || '').trim(),
    });
  }
  return { rows, errors };
}

// Parse an uploaded file buffer (.txt/.csv/.xlsx) into number rows
function parseNumberFile(filename, buffer) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'xlsx' || ext === 'xls') {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    const lines = json.map((r) => r.join('|'));
    return parseNumberRows(lines);
  }
  // txt / csv
  return parseNumberRows(buffer.toString('utf8'));
}

// ---- device fingerprint + label ----
// Stable-ish fingerprint derived from user agent + accept-language (+ optional client id).
function deviceFingerprint(ua, acceptLang, extra) {
  const raw = [String(ua || '').toLowerCase(), String(acceptLang || '').toLowerCase(), String(extra || '')].join('::');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

// Human-friendly device label from a user-agent string.
function deviceLabel(ua) {
  const s = String(ua || 'Unknown device');
  const m = {};
  const has = (re) => re.test(s);
  if (has(/android/i)) m.os = 'Android';
  else if (has(/iphone/i) || has(/ipad/i) || has(/ipod/i)) m.os = 'iOS';
  else if (has(/windows/i)) m.os = 'Windows';
  else if (has(/mac os/i)) m.os = 'macOS';
  else if (has(/linux/i)) m.os = 'Linux';
  else m.os = 'Device';
  if (has(/edg/i)) m.browser = 'Edge';
  else if (has(/opr\//i) || has(/opera/i)) m.browser = 'Opera';
  else if (has(/crios/i)) m.browser = 'Chrome (iOS)';
  else if (has(/chrome/i)) m.browser = 'Chrome';
  else if (has(/firefox/i)) m.browser = 'Firefox';
  else if (has(/safari/i)) m.browser = 'Safari';
  else if (has(/postman/i)) m.browser = 'Postman';
  else m.browser = 'Browser';
  return `${m.browser} · ${m.os}`;
}

// Build complete pulling URL with dynamic number and token injection
function buildPullUrl(apiUrl, number, options = {}) {
  if (!apiUrl) return '';
  let url = String(apiUrl).trim();
  if (!url) return '';

  if (options.token) {
    const token = String(options.token).trim();
    if (token) {
      url = url.replace(/\{token\}/gi, encodeURIComponent(token));
      url = url.replace(/\{api_key\}/gi, encodeURIComponent(token));
      url = url.replace(/\{key\}/gi, encodeURIComponent(token));
      url = url.replace(/\{secret\}/gi, encodeURIComponent(token));
    }
  }

  if (number) {
    const rawNum = String(number).trim();
    const cleanDigits = rawNum.replace(/\D/g, '');
    const withPlus = '+' + cleanDigits;

    if (url.includes('{number}')) url = url.replace(/\{number\}/g, cleanDigits);
    if (url.includes('{phone}')) url = url.replace(/\{phone\}/g, cleanDigits);
    if (url.includes('{mobile}')) url = url.replace(/\{mobile\}/g, cleanDigits);
    if (url.includes('{num}')) url = url.replace(/\{num\}/g, cleanDigits);
    if (url.includes('{raw_number}')) url = url.replace(/\{raw_number\}/g, rawNum);
    if (url.includes('{full_number}')) url = url.replace(/\{full_number\}/g, encodeURIComponent(withPlus));

    if (!url.includes(cleanDigits) && !url.includes(encodeURIComponent(withPlus)) && !url.includes(rawNum)) {
      const hasQuery = url.includes('?');
      const sep = hasQuery ? '&' : '?';
      if (!/[?&](phone|number|mobile|num|record_id)=/i.test(url)) {
        url = url + sep + 'phone=' + cleanDigits;
      }
    }
  }
  return url;
}

// Sanitize OTP messages to strip raw supplier API URLs, tokens, and keys
function sanitizeOtpMessage(str) {
  if (!str) return '';
  let s = String(str);
  s = s.replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]');
  s = s.replace(/(token|key|secret|api_key|auth|password)=[^&\s"'<>]+/gi, '$1=[REDACTED]');
  return s.trim();
}

module.exports = {
  genOrderId, splitNumberApiLine, parseNumberRows, parseNumberFile,
  deviceFingerprint, deviceLabel, sanitizeOtpMessage, buildPullUrl,
};