# knowledge-evaluator

A Cloudflare Worker that scores conversation excerpts using Workers AI and routes them based on confidence — automatically promoting high-signal knowledge to Notion and surfacing ambiguous items for human review.

Built for the [Notion MCP Challenge](https://dev.to/t/notionchallenge).

## How it works

```
Conversation excerpt
        ↓
Workers AI (Llama 3.3 70B) scores 3 signals
        ↓
Score ≥ 0.67 → Knowledge Memory (auto-promoted via Notion REST)
Score 0.33–0.67 → Review Queue (Pending, awaiting human judgment)
Score < 0.33 → Discarded
        ↓
Claude Desktop queries Review Queue via @notionhq/notion-mcp-server
        ↓
Human approves or rejects in Notion
```

Notion isn't a log — it's the decision surface.

## The three signals

| Signal | Question |
|--------|----------|
| **Usage** | Is there a concrete technique, command, or pattern being applied? |
| **Validation** | Is it confirmed to work? |
| **Specificity** | Is it actionable, not just vague advice? |

Each signal is binary (0 or 1). Score = signals fired / 3.

## Live demo

Endpoint: `https://knowledge-evaluator.fpl-test.workers.dev`

```bash
curl -X POST https://knowledge-evaluator.fpl-test.workers.dev/evaluate \
  -H "Content-Type: application/json" \
  -d '{"text": "Use db.prepare().bind().all() for D1 batch queries.", "source": "dev-chat"}'
```

Full write-up: [DEV.to article](https://dev.to/dannwaneri/i-built-a-knowledge-evaluator-that-uses-notion-to-judge-whats-worth-remembering-2mlf)  
Demo video: [YouTube](https://youtu.be/ElpR79l0N6s)  
MCP demo: [YouTube](https://youtu.be/-H-uUJ5uVxI)

## Stack

- **Cloudflare Workers** — runtime
- **Workers AI** (Llama 3.3 70B fp8) — evaluator
- **Hono** — routing
- **Notion REST API** — writes to Review Queue + Knowledge Memory
- **@notionhq/notion-mcp-server** — MCP query layer (reads)

## Deploy your own

### 1. Clone and install

```bash
git clone https://github.com/dannwaneri/knowledge-evaluator
cd knowledge-evaluator
npm install
```

### 2. Create two Notion databases

**Review Queue** — properties:
- Name (title)
- Status (select: Pending, Approved, Rejected)
- Score (number, percent)
- Signals (multi-select: usage, validation, specificity)
- Raw Context (rich text)
- Source (rich text)
- Created (date)

**Knowledge Memory** — properties:
- Name (title)
- Score (number, percent)
- Signals (multi-select)
- Source (rich text)
- Provenance (rich text)
- Promoted At (date)

### 3. Create a Notion integration

Go to [notion.so/profile/integrations](https://notion.so/profile/integrations), create an internal integration, and connect it to both databases.

### 4. Set secrets

```bash
wrangler secret put NOTION_TOKEN
wrangler secret put REVIEW_QUEUE_ID
wrangler secret put KNOWLEDGE_MEMORY_ID
```

### 5. Deploy

```bash
wrangler deploy
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check |
| POST | `/evaluate` | Score a knowledge item and route it |
| GET | `/pending` | Query Notion for items awaiting review |

### POST /evaluate

```json
{
  "text": "Your conversation excerpt here",
  "source": "optional-source-label"
}
```

Response:

```json
{
  "score": 67,
  "signals": ["usage", "specificity"],
  "summary": "One sentence summary from the model",
  "destination": "review_queue",
  "notion_page_id": "page-id"
}
```

## Bidirectional MCP

The Worker writes to Notion via REST. To read pending items back via MCP, add `@notionhq/notion-mcp-server` to your Claude Desktop config:

```json
{
  "mcpServers": {
    "notionApi": {
      "command": "npx",
      "args": ["-y", "@notionhq/notion-mcp-server"],
      "env": {
        "NOTION_TOKEN": "your-token"
      }
    }
  }
}
```

Then ask Claude: *"Query my Notion Review Queue and show me all items with Status Pending"*

---

*Extracted from [Foundation](https://github.com/dannwaneri/chat-knowledge) — a federated knowledge system built on Cloudflare Workers.*