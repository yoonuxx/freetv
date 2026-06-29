function rewriteM3U8(content, originalUrl, proxyBase) {
  const base = originalUrl.replace(/[^/?#]*([?#].*)?$/, '');

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
    return proxyBase + '?url=' + encodeURIComponent(resolveUrl(uri));
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
    const stripped = url.pathname.replace(/^\/?proxy\//, '');
    targetUrl = stripped.replace(/^(https?):\/([^/])/, '$1://$2');
  }
  if (!targetUrl) {
    return new Response(JSON.stringify({ error: 'No URL provided' }), { status: 400 });
  }

  try {
    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
    };
    const range = request.headers.get('range');
    if (range) reqHeaders['Range'] = range;

    const upstream = await fetch(targetUrl, { headers: reqHeaders });

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    };

    const contentType = upstream.headers.get('content-type') || '';
    const isM3U8 = contentType.includes('mpegurl') ||
                   contentType.includes('x-mpegURL') ||
                   /\.m3u8?(\?|$)/i.test(targetUrl.split('#')[0]);

    if (isM3U8) {
      const text = await upstream.text();
      const host = request.headers.get('host') || url.host;
      const proxyBase = `https://${host}/proxy`;
      const rewritten = rewriteM3U8(text, targetUrl, proxyBase);
      return new Response(rewritten, {
        status: upstream.status,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-cache, no-store',
        },
      });
    }

    const resHeaders = { ...corsHeaders };
    resHeaders['Content-Type'] = contentType || 'application/octet-stream';
    const cr = upstream.headers.get('content-range');
    if (cr) resHeaders['Content-Range'] = cr;
    const ar = upstream.headers.get('accept-ranges');
    if (ar) resHeaders['Accept-Ranges'] = ar;
    const cl = upstream.headers.get('content-length');
    if (cl) resHeaders['Content-Length'] = cl;

    return new Response(upstream.body, {
      status: upstream.status,
      headers: resHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
