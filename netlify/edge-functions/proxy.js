function rewriteM3U8(content, originalUrl, proxyBase, ua) {
  const base = originalUrl.replace(/[^/?#]*([?#].*)?$/, '');
  const uaSuffix = ua ? '&ua=' + encodeURIComponent(ua) : '';

  function resolveUrl(uri) {
    if (/^https?:\/\//i.test(uri)) return uri;
    if (uri.startsWith('//')) return 'https:' + uri;
    if (uri.startsWith('/')) {
      const m = originalUrl.match(/^(https?:\/\/[^/]+)/i);
      return m ? m[1] + uri : uri;
    }
    return base + uri;
  }

  function proxify(uri) {
    // Preserve the caller-supplied User-Agent on every nested segment/key/map
    // request. Some upstream CDNs (e.g. certain sports channels) reject
    // requests unless the exact device/app UA is used, so dropping it here
    // would silently break playback for those channels specifically.
    return proxyBase + '?url=' + encodeURIComponent(resolveUrl(uri)) + uaSuffix;
  }

  const lines = content.split('\n');
  const result = [];
  let nextIsUri = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { result.push(line); nextIsUri = false; continue; }

    if (trimmed.startsWith('#EXT-X-KEY') || trimmed.startsWith('#EXT-X-MAP')) {
      result.push(trimmed.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxify(u)}"`));
      nextIsUri = false;
      continue;
    }

    if (trimmed.startsWith('#')) {
      if (trimmed.startsWith('#EXT-X-STREAM-INF') || trimmed.startsWith('#EXT-X-MEDIA') ||
          trimmed.startsWith('#EXTINF') || trimmed.startsWith('#EXT-X-PART') ||
          trimmed.startsWith('#EXT-X-PRELOAD-HINT')) {
        nextIsUri = true;
      }
      result.push(line);
      continue;
    }

    if (nextIsUri || /^[^#\s]/.test(trimmed)) {
      result.push(proxify(trimmed));
      nextIsUri = false;
    } else {
      result.push(line);
      nextIsUri = false;
    }
  }

  return result.join('\n');
}

export default async function(request, context) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      },
    });
  }

  let targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return new Response(JSON.stringify({ error: 'No URL provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  };

  // Per-channel User-Agent override (from the M3U's #EXTVLCOPT/KODIPROP
  // http-user-agent). Some CDNs (e.g. certain sports channels) reject
  // requests unless the exact device/app UA is used, so this must win over
  // our default desktop UA when the client supplies one.
  const ua = url.searchParams.get('ua');

  // Guard every upstream fetch with a hard timeout. Without this, a stalled
  // connection to a flaky/overloaded CDN (common on "4K" sports channels)
  // keeps the isolate's socket + memory pinned indefinitely. Over time those
  // stuck requests pile up on the same warm Netlify Edge isolate and it stops
  // serving anything until it's finally recycled — this is what produces the
  // "works for a while, then dies" pattern instead of a clean, immediate error.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const reqHeaders = {
      'User-Agent': ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
    };
    const range = request.headers.get('range');
    if (range) reqHeaders['Range'] = range;

    const upstream = await fetch(targetUrl, { headers: reqHeaders, signal: controller.signal });

    const contentType = upstream.headers.get('content-type') || '';
    const isM3U8 = contentType.includes('mpegurl') ||
                   contentType.includes('x-mpegURL') ||
                   /\.m3u8?(\?|$)/i.test(targetUrl.split('#')[0]);

    if (isM3U8) {
      const text = await upstream.text();
      clearTimeout(timeout);
      const host = request.headers.get('host') || url.host;
      const proxyBase = `https://${host}/proxy`;
      const rewritten = rewriteM3U8(text, targetUrl, proxyBase, ua);
      return new Response(rewritten, {
        status: upstream.status,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-cache, no-store',
        },
      });
    }

    // Stream binary segments straight through instead of buffering the whole
    // thing into an ArrayBuffer. Large 4K segments (multi-MB each) buffered
    // repeatedly on a warm/reused isolate accumulate memory pressure until
    // the isolate is killed by the platform — streaming avoids holding the
    // full payload in memory at any point and also lowers time-to-first-byte.
    const resHeaders = { ...corsHeaders };
    resHeaders['Content-Type'] = contentType || 'application/octet-stream';
    const cr = upstream.headers.get('content-range');
    if (cr) resHeaders['Content-Range'] = cr;
    const ar = upstream.headers.get('accept-ranges');
    if (ar) resHeaders['Accept-Ranges'] = ar;
    const cl = upstream.headers.get('content-length');
    if (cl) resHeaders['Content-Length'] = cl;

    // Clear the abort timer once the response body starts streaming; the
    // fetch itself already resolved, we just don't want to abort mid-stream.
    clearTimeout(timeout);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: resHeaders,
    });
  } catch (err) {
    clearTimeout(timeout);
    const message = err && err.name === 'AbortError' ? 'Upstream timed out' : (err && err.message) || 'Proxy error';
    return new Response(JSON.stringify({ error: message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
