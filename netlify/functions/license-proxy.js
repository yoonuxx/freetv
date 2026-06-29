exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders() };
  }

  const url = (event.queryStringParameters || {}).url;
  if (!url) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No URL provided' }) };
  }

  try {
    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Content-Type': event.headers['content-type'] || 'application/octet-stream',
    };
    if (event.headers['authorization']) reqHeaders['Authorization'] = event.headers['authorization'];

    const body = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : event.body;

    const response = await fetch(url, {
      method: 'POST',
      headers: reqHeaders,
      body: body,
      redirect: 'follow',
    });

    if (!response.ok) {
      return { statusCode: 502, headers: corsHeaders(), body: JSON.stringify({ error: 'HTTP ' + response.status }) };
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    const resHeaders = corsHeaders();
    resHeaders['Content-Type'] = response.headers.get('content-type') || 'application/octet-stream';

    return { statusCode: 200, headers: resHeaders, body: base64, isBase64Encoded: true };
  } catch (err) {
    return { statusCode: 502, headers: corsHeaders(), body: JSON.stringify({ error: err.message }) };
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}
