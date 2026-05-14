import base64
import os
from typing import Optional
from anthropic import Anthropic
from prompts import SYSTEM_PROMPTS

client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

_sessions: dict[str, list[dict]] = {}


def get_or_create_session(session_id: str) -> list[dict]:
    if session_id not in _sessions:
        _sessions[session_id] = []
    return _sessions[session_id]


def clear_session(session_id: str) -> None:
    _sessions.pop(session_id, None)


def chat(
    session_id: str,
    language: str,
    user_text: str,
    attachment: Optional[dict] = None,
    text_context: Optional[str] = None,
) -> tuple[str, list[str]]:
    """
    Send user_text (+ optional file attachment + optional typed context) to Claude.
    Returns (tutor_reply, corrections).
    """
    history = get_or_create_session(session_id)
    system_prompt = SYSTEM_PROMPTS[language]

    # Prepend typed context (links, notes) to the spoken text if provided
    effective_text = user_text
    if text_context:
        effective_text = f"[Additional context from user: {text_context}]\n\n{user_text}"

    # Build the user message content
    if attachment:
        content = _build_content_with_attachment(effective_text, attachment)
    else:
        content = effective_text

    history.append({"role": "user", "content": content})

    response = client.messages.create(
        model="claude-haiku-4-5",
        max_tokens=1024,
        system=system_prompt,
        messages=history,
    )

    full_response = next(
        block.text for block in response.content if block.type == "text"
    )

    tutor_reply, corrections = _parse_response(full_response)

    # Store only the text in history (not the file bytes) to keep context lean
    history.append({"role": "assistant", "content": tutor_reply})

    return tutor_reply, corrections


def _build_content_with_attachment(user_text: str, attachment: dict) -> list:
    """Build a Claude multi-part content block for the user message."""
    content_type = attachment["content_type"]
    file_bytes = attachment["data"]
    filename = attachment["filename"]

    if content_type.startswith("image/"):
        return [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": content_type,
                    "data": base64.standard_b64encode(file_bytes).decode("utf-8"),
                },
            },
            {"type": "text", "text": user_text or "Please describe and discuss this image."},
        ]

    elif content_type == "application/pdf":
        return [
            {
                "type": "document",
                "source": {
                    "type": "base64",
                    "media_type": "application/pdf",
                    "data": base64.standard_b64encode(file_bytes).decode("utf-8"),
                },
                "title": filename,
            },
            {"type": "text", "text": user_text or "Please discuss the content of this document."},
        ]

    else:
        # Plain text / markdown — just inline it
        file_text = file_bytes.decode("utf-8", errors="replace")
        combined = f"[Attached file: {filename}]\n\n{file_text}\n\n{user_text}"
        return combined


def _parse_response(full_text: str) -> tuple[str, list[str]]:
    marker = "---CORRECTIONS---"
    if marker in full_text:
        parts = full_text.split(marker, 1)
        reply = parts[0].strip()
        corrections = [
            line.lstrip("•").strip()
            for line in parts[1].strip().splitlines()
            if line.strip().startswith("•")
        ]
    else:
        reply = full_text.strip()
        corrections = []
    return reply, corrections
