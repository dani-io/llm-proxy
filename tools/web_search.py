"""web_search tool — wraps SearXNG JSON API"""
import httpx
from config import SEARXNG_URL, SEARCH_MAX_RESULTS


TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": (
            "Search the web for current information. Use this when the user "
            "asks about recent events, prices, facts, or anything you don't "
            "know from training data. Returns a list of top results with "
            "title, url, and snippet."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "The search query. Be specific and use keywords "
                        "(e.g. 'Zafar Trading Tehran products'). "
                        "Persian queries are supported."
                    ),
                },
            },
            "required": ["query"],
        },
    },
}


async def execute(query: str) -> str:
    """
    Run search against SearXNG. Returns formatted results as string
    for LLM context injection.
    """
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"{SEARXNG_URL}/search",
            params={"q": query, "format": "json"},
        )
        resp.raise_for_status()
        data = resp.json()

    results = data.get("results", [])[:SEARCH_MAX_RESULTS]

    if not results:
        return f"No results found for: {query}"

    lines = [f'Search results for: "{query}"', ""]
    for i, r in enumerate(results, 1):
        title = r.get("title", "").strip()
        url = r.get("url", "").strip()
        content = r.get("content", "").strip()
        # Clip snippet for LLM context sanity
        if len(content) > 300:
            content = content[:300] + "..."
        lines.append(f"[{i}] {title}")
        lines.append(f"    URL: {url}")
        if content:
            lines.append(f"    {content}")
        lines.append("")

    return "\n".join(lines)
