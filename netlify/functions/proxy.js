exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders() };
  }

  // Support both /proxy?url=... and /proxy/https:/example.com/...
  let url = (event.queryStringParameters || {}).url;
  if (!url) {
    const stripped = event.path.replace(/^\/?\.?netlify\/functions\/proxy\/?/, '').replace(/^\/?proxy\//, '');
    url = stripped.replace(/^(https?):\/([^/])/, '$1://$2');
  }
  if (!url) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No URL provided' }) };
  }

  try {
    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
    };
    if (event.headers['range'])   reqHeaders['Range']   = event.headers['range'];
    if (event.headers['referer']) reqHeaders['Referer'] = event.headers['referer'];
    if (event.headers['origin'])  reqHeaders['Origin']  = event.headers['origin'];

    const response = await fetch(url, { headers: reqHeaders, redirect: 'follow' });
    const contentType = response.headers.get('content-type') || '';

    const resHeaders = corsHeaders();
    resHeaders['Content-Type'] = contentType || 'application/octet-stream';
    const ct = response.headers.get('content-range');
    if (ct) resHeaders['Content-Range'] = ct;
    const ar = response.headers.get('accept-ranges');
    if (ar) resHeaders['Accept-Ranges'] = ar;

    // Rewrite M3U8 playlists so all segment/manifest URLs are routed through this proxy.
    // This fixes streams whose manifests use relative URLs or plain HTTP URLs — HLS.js
    // would otherwise try to load those segments directly (mixed-content block on HTTPS).
    const isM3U8 = contentType.includes('mpegurl') || contentType.includes('x-mpegURL') ||
                   url.split('?')[0].toLowerCase().match(/\.m3u8?$/);
    if (isM3U8) {
      const text = await response.text();
      const proto = (event.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
      const host  = event.headers['host'] || event.headers['x-forwarded-host'] || '';
      const proxyBase = `${proto}://${host}/proxy`;
      const rewritten = rewriteM3U8(text, url, proxyBase);
      resHeaders['Content-Type'] = 'application/vnd.apple.mpegurl';
      return { statusCode: response.status, headers: resHeaders, body: rewritten };
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    return { statusCode: response.status, headers: resHeaders, body: base64, isBase64Encoded: true };
  } catch (err) {
    return { statusCode: 502, headers: corsHeaders(), body: JSON.stringify({ error: err.message }) };
  }
};

// Rewrite all URLs in an M3U8 so they are fetched through the proxy.
// Handles: relative paths, absolute HTTP/HTTPS URLs, and URI= attributes in tags.
function rewriteM3U8(content, originalUrl, proxyBase) {
  const base = originalUrl.replace(/[^/?#]*([?#].*)?$/, '');

  function resolveUrl(uri) {
    if (!uri) return uri;
    if (/^https?:\/\//i.test(uri)) return uri;
    if (uri.startsWith('//')) return 'https:' + uri;
    if (uri.startsWith('/')) {
      try { return new URL(originalUrl).origin + uri; } catch(e) { return uri; }
    }
    return base + uri;
  }

  function proxify(uri) {
    if (!uri) return uri;
    const absolute = resolveUrl(uri);
    return proxyBase + '?url=' + encodeURIComponent(absolute);
  }

  return content.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith('#')) {
      // Rewrite URI="..." attributes inside tags (e.g. #EXT-X-MAP, #EXT-X-KEY)
      return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxify(uri)}"`);
    }

    // Non-comment lines that look like URLs (relative or absolute)
    if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/') || /^[^#\s]/.test(trimmed)) {
      return proxify(trimmed);
    }

    return line;
  }).join('\n');
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  };
}
