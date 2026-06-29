exports.handler = async function(event) {
  const rawUrl = (event.queryStringParameters || {}).url;
  if (!rawUrl) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'No URL provided' }) };
  }

  const parsed = new URL(rawUrl);
  const mac      = parsed.searchParams.get('mac');
  const streamId = parsed.searchParams.get('stream');
  if (!mac || !streamId) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Missing mac or stream param' }) };
  }

  const portalBase = parsed.origin;
  const cookieStr  = `mac=${mac}; stb_lang=en; timezone=Europe/London`;
  const stalkerUA  = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';

  try {
    // Step 1: Handshake
    const hsRes = await fetch(
      `${portalBase}/portal.php?action=handshake&type=stb&token=`,
      { headers: { 'User-Agent': stalkerUA, 'X-User-Agent': 'Model: MAG250; Link: WiFi', 'Cookie': cookieStr } }
    );
    const hsData = await hsRes.json();
    const token  = hsData?.js?.token;
    if (!token) throw new Error('Handshake returned no token');

    const authHeaders = {
      'User-Agent':    stalkerUA,
      'X-User-Agent':  'Model: MAG250; Link: WiFi',
      'Authorization': `Bearer ${token}`,
      'Cookie':        cookieStr,
    };

    // Step 2: get_profile
    await fetch(`${portalBase}/portal.php?action=get_profile`, { headers: authHeaders });

    // Step 3: create_link
    const cmd    = `ffmpeg http://localhost/ch/${streamId}_`;
    const params = new URLSearchParams({
      type: 'itv', action: 'create_link', cmd,
      series: '', forced_storage: 'undefined', disable_ad: '0',
      download: '0', force_ch_link_check: '0', camel_case_cmd: '1',
    });
    const clRes  = await fetch(`${portalBase}/server/load.php?${params}`, { headers: authHeaders });
    const clData = await clRes.json();
    const cmdStr = clData?.js?.cmd || '';
    const streamUrl = cmdStr.includes('ffmpeg ') ? cmdStr.split('ffmpeg ')[1].trim() : cmdStr.trim();

    if (!streamUrl) throw new Error('Portal returned empty stream URL');

    return { statusCode: 200, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
             body: JSON.stringify({ url: streamUrl }) };
  } catch (err) {
    return { statusCode: 502, headers: corsHeaders(), body: JSON.stringify({ error: err.message }) };
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': '*',
  };
}
