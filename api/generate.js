// Vercel serverless function: /api/generate
// Keeps ANTHROPIC_API_KEY on the server. The frontend never sees it.
//
// Required env var (set in Vercel Project Settings -> Environment Variables):
//   ANTHROPIC_API_KEY   - your real key from https://console.anthropic.com
//
// Optional env vars:
//   APP_PASSCODE        - a shared passcode. If set, callers must send it in
//                          the "x-app-passcode" header or requests are rejected.
//                          If not set, the endpoint is open to anyone with the URL.
//   CLAUDE_MODEL         - defaults to "claude-sonnet-5". Set to
//                          "claude-haiku-4-5-20251001" for a cheaper/faster model.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  // --- Access control -----------------------------------------------------
  const APP_PASSCODE = process.env.APP_PASSCODE;
  if (APP_PASSCODE) {
    const provided = req.headers['x-app-passcode'];
    if (provided !== APP_PASSCODE) {
      res.status(401).json({ error: 'Missing or incorrect access code.' });
      return;
    }
  }

  // --- API key check -------------------------------------------------------
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'Server is missing ANTHROPIC_API_KEY. Set it in Vercel: Project Settings -> Environment Variables, then redeploy.'
    });
    return;
  }

  // --- Parse body ------------------------------------------------------------
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      res.status(400).json({ error: 'Invalid JSON body.' });
      return;
    }
  }
  const prompt = body && body.prompt;
  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'Missing "prompt" string in request body.' });
    return;
  }

  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

  // --- Call Anthropic --------------------------------------------------------
  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      const message = (data && data.error && data.error.message) || 'Anthropic API returned an error.';
      res.status(anthropicRes.status).json({ error: message });
      return;
    }

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to reach the Anthropic API: ' + err.message });
  }
};
