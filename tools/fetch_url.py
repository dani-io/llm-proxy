"""fetch_url tool — HTTP GET + trafilatura extraction to clean text"""
import httpx
import trafilatura
from config import FETCH_TIMEOUT


TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "fetch_url",
        "description": (
            "Fetch the content of a URL and return clean text. Use this "
            "AFTER web_search when you need to read the full content of "
            "a specific page (e.g. company website 'About' page, "
            "product listing, article). Do NOT use for images/PDFs."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The full URL to fetch (must start with http:// or https://).",
                },
            },
            "required": ["url"],
        },
    },
}


MAX_CONTENT_CHARS = 8000  # LLM context sanity


async def execute(url: str) -> str:
    """
    Fetch URL, extract clean text using trafilatura,
    return truncated content for LLM context.
    """
    if not url.startswith(("http://", "https://")):
        return f"Error: invalid URL scheme. Must start with http:// or https://. Got: {url}"

    try:
        async with httpx.AsyncClient(
            timeout=FETCH_TIMEOUT,
            follow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 (llm-proxy fetch_url)"},
        ) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            html = resp.text
    except httpx.HTTPError as e:
        return f"Error fetching {url}: {type(e).__name__}: {e}"

    # trafilatura is sync — safe to call in async context (fast)
    text = trafilatura.extract(
        html,
        include_comments=False,
        include_tables=True,
        no_fallback=False,
        output_format="markdown",
    )

    if not text:
        return f"Could not extract readable content from {url} (may be JS-heavy or empty)."

    if len(text) > MAX_CONTENT_CHARS:
        text = text[:MAX_CONTENT_CHARS] + f"\n\n[... truncated at {MAX_CONTENT_CHARS} chars]"

    return f"Content from {url}:\n\n{text}"
