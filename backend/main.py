import base64
import os
from typing import Optional
from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, UploadFile, Form, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

import speech
import tutor
import analyzer

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

SUPPORTED_LANGUAGES = {"punjabi", "hindi", "portuguese", "spanish"}

SUPPORTED_MIME_TYPES = {
    # Images
    "image/jpeg", "image/png", "image/gif", "image/webp",
    # Documents
    "application/pdf",
    # Text
    "text/plain", "text/markdown",
}


@app.post("/turn")
async def turn(
    audio: UploadFile,
    session_id: str = Form(...),
    language: str = Form(...),
    attachment: Optional[UploadFile] = File(default=None),
    text_context: Optional[str] = Form(default=None),
):
    if language not in SUPPORTED_LANGUAGES:
        raise HTTPException(status_code=400, detail=f"Unsupported language: {language}")

    audio_bytes = await audio.read()

    # 1. Transcribe user's speech
    try:
        user_text = speech.transcribe(audio_bytes, language)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")

    if not user_text.strip():
        raise HTTPException(status_code=400, detail="No speech detected in audio.")

    # 2. Read attachment if present
    attachment_data = None
    if attachment and attachment.filename:
        content_type = attachment.content_type or ""
        # Normalise text/* types
        if attachment.filename.endswith((".md", ".txt")):
            content_type = "text/plain"

        if content_type not in SUPPORTED_MIME_TYPES:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file type: {content_type}. Supported: images, PDFs, text files."
            )

        file_bytes = await attachment.read()
        attachment_data = {
            "filename": attachment.filename,
            "content_type": content_type,
            "data": file_bytes,
        }

    # 3. Get Claude's reply + corrections
    try:
        tutor_text, corrections = tutor.chat(
            session_id, language, user_text,
            attachment=attachment_data,
            text_context=text_context or None,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Claude error: {e}")

    # 4. Synthesize tutor reply to audio
    try:
        audio_bytes_out = speech.synthesize(tutor_text, language)
        audio_b64 = base64.b64encode(audio_bytes_out).decode("utf-8")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"TTS failed: {e}")

    return JSONResponse({
        "user_transcript": user_text,
        "tutor_text": tutor_text,
        "corrections": corrections,
        "audio_b64": audio_b64,
    })


@app.post("/doc/analyze")
async def doc_analyze(
    session_id: str = Form(...),
    language: str = Form(...),
    analysis_types: str = Form(...),  # comma-separated: "summary,vocab,analysis"
    text: Optional[str] = Form(default=None),
    url: Optional[str] = Form(default=None),
    file: Optional[UploadFile] = File(default=None),
):
    if language not in SUPPORTED_LANGUAGES:
        raise HTTPException(status_code=400, detail=f"Unsupported language: {language}")

    # Fresh session for each new document
    tutor.clear_session(session_id)

    doc_text = None
    attachment_data = None

    if url and url.strip():
        try:
            doc_text = analyzer.fetch_url_text(url.strip())
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Could not fetch URL: {e}")
    elif file and file.filename:
        file_bytes = await file.read()
        content_type = file.content_type or ""
        if file.filename.endswith((".md", ".txt")):
            content_type = "text/plain"
        if content_type == "application/pdf":
            attachment_data = {"data": file_bytes, "filename": file.filename, "content_type": "application/pdf"}
        elif content_type == "text/plain":
            doc_text = file_bytes.decode("utf-8", errors="replace")
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported file type: {content_type}")
    elif text and text.strip():
        doc_text = text.strip()
    else:
        raise HTTPException(status_code=400, detail="No document provided.")

    types = [t.strip() for t in analysis_types.split(",") if t.strip()] or ["summary"]

    try:
        analysis_text = analyzer.analyze(
            session_id, language, types,
            doc_text=doc_text,
            attachment=attachment_data,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Analysis failed: {e}")

    try:
        audio_bytes_out = speech.synthesize(analysis_text, language)
        audio_b64 = base64.b64encode(audio_bytes_out).decode("utf-8")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"TTS failed: {e}")

    return JSONResponse({"analysis_text": analysis_text, "audio_b64": audio_b64})


@app.post("/reset")
async def reset(session_id: str = Form(...)):
    tutor.clear_session(session_id)
    return {"status": "ok"}


# Serve frontend from /
frontend_path = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")
