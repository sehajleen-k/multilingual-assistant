import base64
import os
from typing import Optional

import httpx
from bs4 import BeautifulSoup
from anthropic import Anthropic

from tutor import get_or_create_session, _parse_response
from prompts import SYSTEM_PROMPTS

client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])


def fetch_url_text(url: str) -> str:
    """Fetch a URL and extract main readable text."""
    headers = {"User-Agent": "Mozilla/5.0 (compatible; language-tutor/1.0)"}
    resp = httpx.get(url, timeout=15, follow_redirects=True, headers=headers)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
        tag.decompose()
    lines = [l.strip() for l in soup.get_text(separator="\n").splitlines() if l.strip()]
    return "\n".join(lines)[:40000]  # cap at 40k chars


def _build_instruction(analysis_types: list[str]) -> str:
    parts = []
    if "summary" in analysis_types:
        parts.append("a clear, engaging summary")
    if "vocab" in analysis_types:
        parts.append("5–8 key vocabulary words or phrases from the text with brief in-context explanations")
    if "analysis" in analysis_types:
        parts.append("a thoughtful analysis of the main themes, arguments, or ideas")
    joined = "; ".join(parts) if parts else "a clear summary"
    return (
        f"The user has shared a document to study. Please provide {joined} — "
        "entirely in the target language, as if narrating a language-learning podcast episode. "
        "Be engaging and natural. After your main response, briefly note any culturally interesting "
        "references or linguistic features worth knowing as a learner."
    )


def analyze(
    session_id: str,
    language: str,
    analysis_types: list[str],
    doc_text: Optional[str] = None,
    attachment: Optional[dict] = None,  # {data: bytes, filename: str, content_type: str}
) -> str:
    """Run initial doc analysis, store exchange in session, return reply text."""
    history = get_or_create_session(session_id)
    system_prompt = SYSTEM_PROMPTS[language]
    instruction = _build_instruction(analysis_types)

    if attachment and attachment["content_type"] == "application/pdf":
        content = [
            {
                "type": "document",
                "source": {
                    "type": "base64",
                    "media_type": "application/pdf",
                    "data": base64.standard_b64encode(attachment["data"]).decode("utf-8"),
                },
                "title": attachment["filename"],
            },
            {"type": "text", "text": instruction},
        ]
    else:
        content = f"{instruction}\n\n---\n{doc_text}\n---"

    history.append({"role": "user", "content": content})

    response = client.messages.create(
        model="claude-haiku-4-5",
        max_tokens=2048,
        system=system_prompt,
        messages=history,
    )

    full_reply = next(block.text for block in response.content if block.type == "text")
    reply, _ = _parse_response(full_reply)
    history.append({"role": "assistant", "content": reply})
    return reply
