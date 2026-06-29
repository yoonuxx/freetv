exports.handler = async function(event) {
  const url = (event.queryStringParameters || {}).url;

  if (!url) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No URL provided' }) };
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': '*/*',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: 'HTTP ' + response.status }) };
    }

    const text = await response.text();
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
      },
      body: text,
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
