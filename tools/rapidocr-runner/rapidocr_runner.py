import argparse
import contextlib
import io
import json
import sys
import time
from pathlib import Path


def safe_json_value(value):
    if value is None:
        return None

    if hasattr(value, "tolist"):
        return value.tolist()

    if isinstance(value, (list, tuple)):
        return [safe_json_value(item) for item in value]

    if isinstance(value, dict):
        return {str(k): safe_json_value(v) for k, v in value.items()}

    try:
        json.dumps(value, ensure_ascii=False)
        return value
    except TypeError:
        return str(value)


def build_result(success, text="", items=None, duration_ms=0, error=None):
    return {
        "success": bool(success),
        "engine": "rapidocr",
        "text": text or "",
        "items": items if items is not None else [],
        "durationMs": int(duration_ms or 0),
        "error": error,
    }


def get_sequence(value):
    if value is None:
        return []

    if hasattr(value, "tolist"):
        return value.tolist()

    if isinstance(value, (list, tuple)):
        return list(value)

    return []


def extract_text(raw):
    texts = []
    items = []

    if raw is None:
        return "", []

    # RapidOCR 新版本常见返回对象：raw.txts / raw.scores / raw.boxes
    if hasattr(raw, "txts"):
        txts = get_sequence(getattr(raw, "txts", None))
        scores = get_sequence(getattr(raw, "scores", None))
        boxes = get_sequence(getattr(raw, "boxes", None))

        for i, text in enumerate(txts):
            clean_text = str(text).strip()
            if not clean_text:
                continue

            score = scores[i] if i < len(scores) else None
            box = boxes[i] if i < len(boxes) else None

            texts.append(clean_text)
            items.append({
                "text": clean_text,
                "score": safe_json_value(score),
                "box": safe_json_value(box),
            })

        return "\n".join(texts).strip(), items

    # 兼容旧式 list / tuple 返回
    if isinstance(raw, (list, tuple)):
        for row in raw:
            text = ""
            score = None
            box = None

            if isinstance(row, (list, tuple)):
                if len(row) >= 1:
                    box = row[0]

                if len(row) >= 2:
                    second = row[1]
                    if isinstance(second, (list, tuple)):
                        text = str(second[0]).strip() if len(second) >= 1 else ""
                        score = second[1] if len(second) >= 2 else None
                    else:
                        text = str(second).strip()

                if len(row) >= 3:
                    score = row[2]
            else:
                text = str(row).strip()

            if text:
                texts.append(text)
                items.append({
                    "text": text,
                    "score": safe_json_value(score),
                    "box": safe_json_value(box),
                })

    return "\n".join(texts).strip(), items


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    args = parser.parse_args()

    start = time.time()
    image_path = Path(args.image)

    if not image_path.exists():
        print(json.dumps(build_result(
            success=False,
            error=f"图片不存在：{image_path}",
        ), ensure_ascii=True))
        return 2

    try:
        # RapidOCR 会输出 INFO 日志。这里把模型加载和识别期间的 stdout 重定向到 stderr，
        # 确保 stdout 只输出最终 JSON，方便 Electron 解析。
        with contextlib.redirect_stdout(sys.stderr):
            from rapidocr import RapidOCR
            engine = RapidOCR()
            raw = engine(str(image_path))

        text, items = extract_text(raw)
        duration_ms = int((time.time() - start) * 1000)

        if not text:
            print(json.dumps(build_result(
                success=True,
                text="",
                items=items,
                duration_ms=duration_ms,
                error=None,
            ), ensure_ascii=True))
            return 0

        print(json.dumps(build_result(
            success=True,
            text=text,
            items=items,
            duration_ms=duration_ms,
            error=None,
        ), ensure_ascii=True))
        return 0

    except Exception as exc:
        duration_ms = int((time.time() - start) * 1000)
        print(json.dumps(build_result(
            success=False,
            duration_ms=duration_ms,
            error=str(exc),
        ), ensure_ascii=True))
        return 3


if __name__ == "__main__":
    sys.exit(main())
