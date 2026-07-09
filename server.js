const express = require('express');
const path = require('path');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 5000;

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function corsHeaders(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  res.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
}

app.use((req, res, next) => {
  corsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.raw({ type: '*/*', limit: '50mb' }));

// ---- /fetch-playlist ----
app.get('/fetch-playlist', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'No URL provided' });
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': DEFAULT_UA, 'Accept': '*/*' },
      redirect: 'follow',
    });
    if (!response.ok) return res.status(502).json({ error: 'HTTP ' + response.status });
    const text = await response.text();
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(text);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- /license-proxy ----
app.post('/license-proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'No URL provided' });
  try {
    const reqHeaders = {
      'User-Agent': DEFAULT_UA,
      'Content-Type': req.headers['content-type'] || 'application/octet-stream',
    };
    if (req.headers['authorization']) reqHeaders['Authorization'] = req.headers['authorization'];
    const hdrsParam = req.query.hdrs;
    if (hdrsParam) {
      try {
        const extraHeaders = JSON.parse(hdrsParam);
        for (const [key, value] of Object.entries(extraHeaders)) {
          if (key && value != null) reqHeaders[key] = String(value);
        }
      } catch (e) {}
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: reqHeaders,
      body: req.body,
      redirect: 'follow',
    });
    if (!response.ok) return res.status(502).json({ error: 'HTTP ' + response.status });
    const buffer = Buffer.from(await response.arrayBuffer());
    res.set('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
    res.send(buffer);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- /stalker-resolve ----
app.get('/stalker-resolve', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).json({ error: 'No URL provided' });
  try {
    const parsed = new URL(rawUrl);
    const mac = parsed.searchParams.get('mac');
    const streamId = parsed.searchParams.get('stream');
    if (!mac || !streamId) return res.status(400).json({ error: 'Missing mac or stream param' });

    const portalBase = parsed.origin;
    const cookieStr = `mac=${mac}; stb_lang=en; timezone=Europe/London`;
    const stalkerUA = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';

    const hsRes = await fetch(
      `${portalBase}/portal.php?action=handshake&type=stb&token=`,
      { headers: { 'User-Agent': stalkerUA, 'X-User-Agent': 'Model: MAG250; Link: WiFi', 'Cookie': cookieStr } }
    );
    const hsData = await hsRes.json();
    const token = hsData?.js?.token;
    if (!token) throw new Error('Handshake returned no token');

    const authHeaders = {
      'User-Agent': stalkerUA,
      'X-User-Agent': 'Model: MAG250; Link: WiFi',
      'Authorization': `Bearer ${token}`,
      'Cookie': cookieStr,
    };

    await fetch(`${portalBase}/portal.php?action=get_profile`, { headers: authHeaders });

    const cmd = `ffmpeg http://localhost/ch/${streamId}_`;
    const params = new URLSearchParams({
      type: 'itv', action: 'create_link', cmd,
      series: '', forced_storage: 'undefined', disable_ad: '0',
      download: '0', force_ch_link_check: '0', camel_case_cmd: '1',
    });
    const clRes = await fetch(`${portalBase}/server/load.php?${params}`, { headers: authHeaders });
    const clData = await clRes.json();
    const cmdStr = clData?.js?.cmd || '';
    const streamUrl = cmdStr.includes('ffmpeg ') ? cmdStr.split('ffmpeg ')[1].trim() : cmdStr.trim();
    if (!streamUrl) throw new Error('Portal returned empty stream URL');

    res.json({ url: streamUrl });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- /proxy ----
function rewriteM3U8(content, originalUrl, proxyBase, ua) {
  const base = originalUrl.replace(/[^/?#]*([?#].*)?$/, '');
  const uaSuffix = ua ? '&ua=' + encodeURIComponent(ua) : '';

  function resolveUrl(uri) {
    if (!uri) return uri;
    if (/^https?:\/\//i.test(uri)) return uri;
    if (uri.startsWith('//')) return 'https:' + uri;
    if (uri.startsWith('/')) {
      try { return new URL(originalUrl).origin + uri; } catch (e) { return uri; }
    }
    return base + uri;
  }

  function proxify(uri) {
    if (!uri) return uri;
    const absolute = resolveUrl(uri);
    return proxyBase + '?url=' + encodeURIComponent(absolute) + uaSuffix;
  }

  return content.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxify(uri)}"`);
    }
    if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/') || /^[^#\s]/.test(trimmed)) {
      return proxify(trimmed);
    }
    return line;
  }).join('\n');
}

app.get('/proxy', async (req, res) => {
  let url = req.query.url;
  if (!url) return res.status(400).json({ error: 'No URL provided' });
  const ua = req.query.ua;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const reqHeaders = {
      'User-Agent': ua || DEFAULT_UA,
      'Accept': '*/*',
    };
    if (req.headers['range']) reqHeaders['Range'] = req.headers['range'];
    if (req.headers['referer']) reqHeaders['Referer'] = req.headers['referer'];
    if (req.headers['origin']) reqHeaders['Origin'] = req.headers['origin'];

    const range = req.headers['range'];
    let response;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch(url, { headers: reqHeaders, redirect: 'follow', signal: controller.signal });
        if (response.ok || response.status === 206 || (range && response.status < 500)) break;
        if (response.status < 500 && response.status !== 429) break;
      } catch (e) {
        lastErr = e;
        response = null;
        if (e && e.name === 'AbortError') break;
      }
      if (attempt < 2) await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
    if (!response) throw lastErr || new Error('Upstream fetch failed');
    const contentType = response.headers.get('content-type') || '';

    res.status(response.status);
    res.set('Content-Type', contentType || 'application/octet-stream');
    const cr = response.headers.get('content-range');
    if (cr) res.set('Content-Range', cr);
    const ar = response.headers.get('accept-ranges');
    if (ar) res.set('Accept-Ranges', ar);

    const isM3U8 = contentType.includes('mpegurl') || contentType.includes('x-mpegURL') ||
                   url.split('?')[0].toLowerCase().match(/\.m3u8?$/);
    if (isM3U8) {
      const text = await response.text();
      clearTimeout(timeout);
      const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
      const host = req.headers['host'] || req.headers['x-forwarded-host'] || '';
      const proxyBase = `${proto}://${host}/proxy`;
      const rewritten = rewriteM3U8(text, url, proxyBase, ua);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewritten);
    }

    clearTimeout(timeout);
    if (response.body) {
      Readable.fromWeb(response.body).on('error', () => res.end()).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    clearTimeout(timeout);
    if (!res.headersSent) {
      const message = err && err.name === 'AbortError' ? 'Upstream timed out' : err.message;
      res.status(502).json({ error: message });
    } else {
      res.end();
    }
  }
});

app.use(express.static(path.join(__dirname), { index: 'index.html' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`FreeTV Player server running on port ${PORT}`);
});
