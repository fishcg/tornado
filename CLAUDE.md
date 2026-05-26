# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start both services
npm run all

# Start individually
npm run tornado    # port 3011
npm run memory     # port 8880

# No test suite exists
```

## Architecture

This is a dual-service virtual companion system with persistent long-term memory.

### Two independent services

**Tornado** (`tornado/server.js`, port 3011) — chat & character system
- Monolithic Node.js native HTTP server (no Express/Fastify)
- All routes, auth, and business logic are inline in `server.js`
- Character personality is defined in `tornado/soul.md`
- SSE for real-time LLM streaming
- Features: roleplay, mood system, heart value (affection), achievements, image generation, proactive messaging

**Memory** (`src/server.js`, port 8880) — long-term memory system
- Fastify with layered architecture: routes → services → repositories → DB
- Watches `inbox/` directory via chokidar for automatic file ingestion (27 file types)
- Periodic memory consolidation (default 30 min)
- Entity relationship graph stored in DB

### Shared infrastructure
- Both services share one MySQL database and one `.env` file at the project root
- Tornado calls the Memory service via HTTP to query/store memories
- LLM abstraction in `src/llm/openai-client.js` supports DashScope/Qwen (Responses API) and DeepSeek (Chat Completions)

### Database
- Tornado tables: `sessions`, `messages`, `mood_avatars`, `character_cards`, `users`, `invite_codes`, `global_settings`, `achievements`, etc.
- Memory tables: `memories`, `consolidations`, `entity_relations`, `processed_files`
- Schema is auto-applied on startup in each service's `db.js`

### Auth
- Session-based with SHA256 password hashing
- Multi-user isolation via `user_id` foreign keys throughout