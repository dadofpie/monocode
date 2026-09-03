/** Bundled MonoCode skill: look things up online with zero setup. */
export const WEB_SEARCH_SKILL_NAME = "web-search";

export const WEB_SEARCH_SKILL_DESCRIPTION =
  "Search the web and extract page content with zero setup via keyless APIs. Use when the user asks to look something up online, check docs, research an error message, compare packages, verify a version, or ground an answer with sources.";

export const WEB_SEARCH_SKILL_BODY = `---
name: web-search
description: Search the web and extract page content with zero setup via keyless APIs. Use when the user asks to look something up online, check docs, research an error message, compare packages, verify a version, or ground an answer with sources.
---

# Web Search

Look things up online with zero setup. Prefer the keyless APIs below and never ask the user for a key unless every vendor fails.

## Search

1. Tavily keyless first — the snippets are already ranked for LLM use:

\`\`\`sh
curl -s -X POST https://api.tavily.com/search \\
  -H 'Content-Type: application/json' \\
  -H 'X-Tavily-Access-Mode: keyless' \\
  -d '{"query": "<query>", "max_results": 5, "include_answer": false}'
\`\`\`

2. If that is rate-limited, fall over to a keyless fallback instead of retrying:
   - stable facts: \`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=<query>&format=json\`
   - error messages and how-tos: \`https://api.stackexchange.com/2.3/search/excerpts?q=<query>&site=stackoverflow&pagesize=5\`
   - quick facts: \`https://api.duckduckgo.com/?q=<query>&format=json\`
3. Cite the URL behind each claim.

## Extract

Tavily keyless extract first, plain curl when that fails:

\`\`\`sh
curl -s -X POST https://api.tavily.com/extract \\
  -H 'Content-Type: application/json' \\
  -H 'X-Tavily-Access-Mode: keyless' \\
  -d '{"urls": ["<url>"]}'
\`\`\`

Quote short passages and summarize the rest. Do not paste whole pages into the transcript.

## Limits

- Keyless Tavily covers \`/search\` and \`/extract\` only and is rate-limited. For heavier use, set \`TAVILY_API_KEY\` and add \`-H "Authorization: Bearer $TAVILY_API_KEY"\` — the key wins over the keyless header with no other change.
- If every vendor fails, say which vendors failed and stop. Do not retry in a loop.
`;
