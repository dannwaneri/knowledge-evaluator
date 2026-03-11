import { Hono } from 'hono';
import type { Ai } from '@cloudflare/workers-types';
type Env = {
  AI: Ai;
  NOTION_TOKEN: string;
  REVIEW_QUEUE_ID: string;
  KNOWLEDGE_MEMORY_ID: string;
};

const app = new Hono<{ Bindings: Env }>();

// ── Scoring ───────────────────────────────────────────────────────────────────

interface EvalResult {
  score: number;
  signals: string[];
  summary: string;
}

async function evaluateKnowledge(ai: Ai, text: string): Promise<EvalResult> {
  const response = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [
      {
        role: 'system',
        content: 'You are a knowledge quality evaluator. You MUST respond with ONLY a valid JSON object, no other text, no markdown, no explanation.',
      },
      {
        role: 'user',
        content: `Score this conversation excerpt on three signals and respond with ONLY this JSON structure:
{"usage": 0 or 1, "validation": 0 or 1, "specificity": 0 or 1, "summary": "one sentence"}

USAGE: Is there a concrete technique, tool, command, or pattern being used? (1=yes, 0=no)
VALIDATION: Is the approach confirmed to work? (1=yes, 0=no)
SPECIFICITY: Is it specific enough to be actionable? (1=yes, 0=no)

Excerpt: ${text}`,
      },
    ],
    max_tokens: 256,
  }) as { response?: unknown };

  console.log('[AI RAW]', JSON.stringify(response));

  let parsed: { usage: number; validation: number; specificity: number; summary: string };
  try {
    const r = response as { response?: unknown };
    const inner = r.response;
    if (typeof inner === 'object' && inner !== null) {
      parsed = inner as typeof parsed;
    } else if (typeof inner === 'string') {
      const jsonMatch = inner.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : '{}');
    } else {
      return { score: 0, signals: [], summary: text.slice(0, 100) };
    }
  } catch (e) {
    console.log('[PARSE ERROR]', e);
    return { score: 0, signals: [], summary: text.slice(0, 100) };
  }

  const signals: string[] = [];
  if (parsed.usage) signals.push('usage');
  if (parsed.validation) signals.push('validation');
  if (parsed.specificity) signals.push('specificity');

  const score = signals.length / 3;

  return { score, signals, summary: parsed.summary };
}

// ── Notion helpers ────────────────────────────────────────────────────────────

async function writeToNotion(
  token: string,
  databaseId: string,
  title: string,
  score: number,
  signals: string[],
  source: string,
  rawContext: string,
  status?: string
) {
  const properties: Record<string, unknown> = {
    Name: { title: [{ text: { content: title } }] },
    Score: { number: score },
    Signals: { multi_select: signals.map(s => ({ name: s })) },
    Source: { rich_text: [{ text: { content: source } }] },
  };

  if (status) {
    properties['Status'] = { select: { name: status } };
    properties['Raw Context'] = { rich_text: [{ text: { content: rawContext.slice(0, 2000) } }] };
    properties['Created'] = { date: { start: new Date().toISOString() } };
  } else {
    properties['Provenance'] = { rich_text: [{ text: { content: rawContext.slice(0, 2000) } }] };
    properties['Promoted At'] = { date: { start: new Date().toISOString() } };
  }

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Notion write failed: ${err}`);
  }

  return res.json();
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/', (c) => c.json({ status: 'knowledge-evaluator running' }));

app.post('/evaluate', async (c) => {
  const body = await c.req.json<{ text: string; source?: string }>();

  if (!body.text) {
    return c.json({ error: 'text is required' }, 400);
  }

  const source = body.source || 'manual';
  const result = await evaluateKnowledge(c.env.AI, body.text);

  let destination: string;
  let notionPageId: string | undefined;

  if (result.score >= 0.67) {
    // High confidence → Knowledge Memory (auto-promoted)
    destination = 'knowledge_memory';
    const page = await writeToNotion(
      c.env.NOTION_TOKEN,
      c.env.KNOWLEDGE_MEMORY_ID,
      result.summary,
      result.score,
      result.signals,
      source,
      body.text
    ) as { id: string };
    notionPageId = page.id;
  } else if (result.score >= 0.33) {
    // Ambiguous → Review Queue (human judges)
    destination = 'review_queue';
    const page = await writeToNotion(
      c.env.NOTION_TOKEN,
      c.env.REVIEW_QUEUE_ID,
      result.summary,
      result.score,
      result.signals,
      source,
      body.text,
      'Pending'
    ) as { id: string };
    notionPageId = page.id;
  } else {
    // Low confidence → discard
    destination = 'discarded';
  }

  return c.json({
    score: Math.round(result.score * 100),
    signals: result.signals,
    summary: result.summary,
    destination,
    notion_page_id: notionPageId,
  });
});

// Query Review Queue for pending items — Notion as active judgment surface
app.get('/pending', async (c) => {
  const res = await fetch(
    `https://api.notion.com/v1/databases/${c.env.REVIEW_QUEUE_ID}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: {
          property: 'Status',
          select: { equals: 'Pending' },
        },
        sorts: [{ property: 'Created', direction: 'descending' }],
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    return c.json({ error: err }, 500);
  }

  const data = await res.json() as {
    results: Array<{
      id: string;
      properties: Record<string, {
        title?: Array<{ plain_text: string }>;
        number?: number;
        select?: { name: string };
        multi_select?: Array<{ name: string }>;
        rich_text?: Array<{ plain_text: string }>;
        date?: { start: string };
      }>;
    }>;
  };

  const pending = data.results.map((page) => ({
    id: page.id,
    name: page.properties.Name?.title?.[0]?.plain_text ?? '',
    score: Math.round((page.properties.Score?.number ?? 0) * 100),
    signals: page.properties.Signals?.multi_select?.map((s) => s.name) ?? [],
    source: page.properties.Source?.rich_text?.[0]?.plain_text ?? '',
    created: page.properties.Created?.date?.start ?? '',
    raw_context: page.properties['Raw Context']?.rich_text?.[0]?.plain_text ?? '',
  }));

  return c.json({
    count: pending.length,
    items: pending,
  });
});

export default app;