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
//
// This uses Anthropic's structured tool-calling instead of asking the model
// to hand-write JSON as plain text. Free-text JSON can break if the source
// document contains an unescaped quote or a raw line break (that's what
// caused the "Expected ',' or ']'" / "Unterminated string" errors); tool
// calling has the API itself construct and validate the object against a
// JSON Schema, so there's no text-parsing step on our end at all.

const SCHEMAS = {
  brief: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      tagline: { type: 'string' },
      geo: { type: 'string' },
      objectivesIntro: { type: 'string', description: 'Optional framing paragraph before the numbered objectives list; empty string if none.' },
      objectives: { type: 'array', items: { type: 'string' } },
      respondents: { type: 'string' },
      respondentSegments: {
        type: 'array',
        description: 'Only populate if 2+ distinct named respondent segments are described; otherwise empty array.',
        items: {
          type: 'object',
          properties: { segment: { type: 'string' }, sampleSize: { type: 'string' } },
          required: ['segment', 'sampleSize']
        }
      },
      method: { type: 'array', items: { type: 'string' } },
      costRangeText: { type: 'string', description: 'Empty string if no pricing info is available and none should be suggested.' },
      deliver: { type: 'array', items: { type: 'string' }, description: 'Only items the source actually mentions; empty array if none mentioned.' },
      nextSteps: { type: 'array', items: { type: 'string' } }
    },
    required: ['title', 'tagline', 'geo', 'objectivesIntro', 'objectives', 'respondents', 'respondentSegments', 'method', 'costRangeText', 'deliver', 'nextSteps']
  },
  quote: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      tagline: { type: 'string' },
      geo: { type: 'string' },
      objectives: { type: 'array', items: { type: 'string' } },
      costItems: {
        type: 'array',
        items: {
          type: 'object',
          properties: { activity: { type: 'string' }, budget: { type: 'string' }, desc: { type: 'string' } },
          required: ['activity', 'budget', 'desc']
        }
      },
      taxRate: { type: 'number' },
      milestones: {
        type: 'array',
        items: {
          type: 'object',
          properties: { phase: { type: 'string' }, duration: { type: 'string' }, desc: { type: 'string' } },
          required: ['phase', 'duration', 'desc']
        }
      },
      nextSteps: { type: 'array', items: { type: 'string' } }
    },
    required: ['title', 'tagline', 'geo', 'objectives', 'costItems', 'taxRate', 'milestones', 'nextSteps']
  },
  invoice: {
    type: 'object',
    properties: {
      invDate: { type: 'string' },
      billName: { type: 'string' },
      billCompany: { type: 'string' },
      invDesc: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { item: { type: 'string' }, units: { type: 'string' }, cost: { type: 'string' } },
          required: ['item', 'units', 'cost']
        }
      },
      vatExempt: { type: 'boolean' },
      vatExemptNote: { type: 'string' },
      depositPercent: { type: 'number', description: '0 if no deposit is mentioned.' },
      notes: { type: 'string' }
    },
    required: ['invDate', 'billName', 'billCompany', 'invDesc', 'items', 'vatExempt', 'vatExemptNote', 'depositPercent', 'notes']
  },
  proposal: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      org: { type: 'string' },
      subtitle: { type: 'string' },
      execSummary: { type: 'string' },
      objectives: {
        type: 'array',
        items: { type: 'object', properties: { title: { type: 'string' }, desc: { type: 'string' } }, required: ['title', 'desc'] }
      },
      scope: { type: 'string' },
      methodology: {
        type: 'array',
        items: { type: 'object', properties: { title: { type: 'string' }, desc: { type: 'string' } }, required: ['title', 'desc'] }
      },
      technology: {
        type: 'array',
        items: { type: 'object', properties: { title: { type: 'string' }, desc: { type: 'string' } }, required: ['title', 'desc'] }
      },
      phases: {
        type: 'array',
        items: {
          type: 'object',
          properties: { phase: { type: 'string' }, title: { type: 'string' }, desc: { type: 'string' } },
          required: ['phase', 'title', 'desc']
        }
      },
      deliverables: {
        type: 'array',
        items: { type: 'object', properties: { category: { type: 'string' }, desc: { type: 'string' } }, required: ['category', 'desc'] }
      },
      nextSteps: { type: 'array', items: { type: 'string' } }
    },
    required: ['title', 'org', 'subtitle', 'execSummary', 'objectives', 'scope', 'methodology', 'technology', 'phases', 'deliverables', 'nextSteps']
  }
};

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
  const useWebSearch = !!(body && body.useWebSearch);
  const mode = (body && body.mode) || 'brief';
  const schema = SCHEMAS[mode] || SCHEMAS.brief;

  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

  // Output budgets per template. The Proposal schema is the largest (7
  // sections, several with multiple title+desc sub-items), so it needs far
  // more headroom than a one-page Invoice — a shared low limit was silently
  // truncating Proposal responses mid-generation. All current Claude models
  // allow well over 100k output tokens, so these are generous on purpose;
  // at $10/million output tokens the cost difference is fractions of a cent.
  const MAX_TOKENS_BY_MODE = { brief: 2500, quote: 3000, invoice: 1500, proposal: 5000 };
  let maxTokens = MAX_TOKENS_BY_MODE[mode] || 2500;
  if (useWebSearch) maxTokens += 1500; // search results consume extra tokens

  const extractTool = {
    name: 'extract_document_data',
    description: 'Return the structured project data extracted/drafted from the source text, matching the required schema exactly.',
    input_schema: schema
  };

  const requestBody = {
    model: model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
    tools: [extractTool]
  };
  // Force the model to call the extraction tool rather than just chatting —
  // this is what guarantees a schema-valid object back, with no chance of
  // malformed JSON syntax. Skipped when web search is enabled: forcing a
  // specific tool call can prevent the model from first calling web_search,
  // so that path allows the model to choose its own order of tool calls.
  if (!useWebSearch) {
    requestBody.tool_choice = { type: 'tool', name: 'extract_document_data' };
  } else {
    requestBody.tools.push({ type: 'web_search_20250305', name: 'web_search' });
  }
  // Sonnet 5 runs adaptive "thinking" by default, and max_tokens is a hard
  // cap on thinking + visible output combined. For a fixed-schema extraction
  // task, thinking adds latency/cost without helping quality, so disable it
  // to make sure the full budget goes to the actual response.
  if (model === 'claude-sonnet-5') {
    requestBody.thinking = { type: 'disabled' };
  }

  // --- Call Anthropic --------------------------------------------------------
  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody)
    });

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      const message = (data && data.error && data.error.message) || 'Anthropic API returned an error.';
      res.status(anthropicRes.status).json({ error: message });
      return;
    }

    if (data.stop_reason === 'max_tokens') {
      res.status(422).json({
        error: 'The AI response was cut off before it finished (the source text was too long/detailed to fully structure in one pass). Try pasting a shorter excerpt, or split the RFP into sections and generate separately.'
      });
      return;
    }

    const toolUseBlock = (data.content || []).find(b => b.type === 'tool_use' && b.name === 'extract_document_data');
    if (!toolUseBlock) {
      res.status(422).json({
        error: 'The AI responded without returning structured data this time. Try again' + (useWebSearch ? ', or uncheck the pricing-suggestion option and retry' : '') + '.'
      });
      return;
    }

    res.status(200).json({ result: toolUseBlock.input });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reach the Anthropic API: ' + err.message });
  }
};
