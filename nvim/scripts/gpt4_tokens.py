#!/usr/bin/env python3
"""Count GPT-4 (cl100k) tokens on stdin. Prints one integer."""
from pathlib import Path
import sys
import urllib.request

import gigatoken as gt

CACHE = Path.home() / ".cache" / "gigatoken" / "cl100k_base.tiktoken"
URL = "https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken"

if not CACHE.exists():
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(URL, CACHE)

tok = gt.Tokenizer.from_tiktoken(str(CACHE))
sys.stdout.write(str(len(tok.encode(sys.stdin.buffer.read()))))
