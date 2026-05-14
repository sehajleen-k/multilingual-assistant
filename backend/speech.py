import os
from elevenlabs.client import ElevenLabs

client = ElevenLabs(api_key=os.environ["ELEVENLABS_API_KEY"])

TTS_MODEL = "eleven_turbo_v2_5"

# "Rachel" — ElevenLabs' built-in default voice, available on all accounts.
# eleven_multilingual_v2 will render any language correctly with this voice.
DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"

# Per-language overrides. Leave as None to use DEFAULT_VOICE_ID.
# When you clone your Punjabi voice, paste the ID next to "punjabi".
LANGUAGE_VOICE_IDS: dict[str, str | None] = {
    "punjabi":    None,  # <- paste your cloned voice ID here when ready
    "hindi":      None,
    "portuguese": None,
    "spanish":    None,
}


def _get_voice_id(language: str) -> str:
    return LANGUAGE_VOICE_IDS.get(language) or DEFAULT_VOICE_ID


def transcribe(audio_bytes: bytes, language: str) -> str:
    """Transcribe audio bytes to text using ElevenLabs Scribe STT."""
    lang_codes = {
        "punjabi":    "pa",
        "hindi":      "hi",
        "portuguese": "pt",
        "spanish":    "es",
    }
    response = client.speech_to_text.convert(
        file=("audio.webm", audio_bytes, "audio/webm"),
        model_id="scribe_v1",
        language_code=lang_codes[language],
    )
    return response.text


def synthesize(text: str, language: str) -> bytes:
    """Convert text to speech and return audio bytes."""
    voice_id = _get_voice_id(language)
    audio_chunks = client.text_to_speech.convert(
        text=text,
        voice_id=voice_id,
        model_id=TTS_MODEL,
        output_format="mp3_44100_128",
    )
    return b"".join(audio_chunks)
