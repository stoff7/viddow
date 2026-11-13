"""Framing for the browser's binary Native Messaging channel."""
import json
import struct

MAX_MESSAGE_BYTES = 1024 * 1024


def read_exact(stream, length, *, eof_ok=False):
    chunks = bytearray()
    while len(chunks) < length:
        chunk = stream.read(length - len(chunks))
        if not chunk:
            if eof_ok and not chunks:
                return None
            raise ValueError("Оборванное Native Messaging-сообщение")
        chunks.extend(chunk)
    return bytes(chunks)


def read_message(stream):
    header = read_exact(stream, 4, eof_ok=True)
    if header is None:
        return None
    (length,) = struct.unpack("<I", header)
    if not 0 < length <= MAX_MESSAGE_BYTES:
        raise ValueError("Недопустимый размер Native Messaging-сообщения")
    message = json.loads(read_exact(stream, length).decode("utf-8"))
    if not isinstance(message, dict):
        raise ValueError("Native Messaging ожидает JSON-объект")
    return message


def configure_stdio():
    """Run before reading even the first header; pythonw has no usable stdio."""
    import os
    import sys
    if sys.stdin is None or sys.stdout is None:
        raise RuntimeError("Native Messaging требует Python с stdin/stdout (не pythonw)")
    if os.name == "nt":
        import msvcrt
        for stream in (sys.stdin, sys.stdout):
            msvcrt.setmode(stream.fileno(), os.O_BINARY)
