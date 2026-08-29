#!/usr/bin/env python3
"""Extract PDF text with stable page markers for evidence-grounded evaluation."""

import argparse
from pathlib import Path

from pypdf import PdfReader


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    reader = PdfReader(str(args.pdf))
    chunks = []
    for index, page in enumerate(reader.pages, 1):
        chunks.append(f"\n\n===== PAGE {index} =====\n\n{page.extract_text() or ''}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes("".join(chunks).encode("utf-8", errors="replace"))
    print(f"pages={len(reader.pages)} output={args.output}")


if __name__ == "__main__":
    main()
