#!/usr/bin/env python3
"""A tiny, dependency-free media catalog and HTTP range server for mpv."""

from __future__ import annotations

import argparse
import concurrent.futures
import hmac
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import BinaryIO
from urllib.parse import parse_qs, quote, unquote, urlsplit


DEFAULT_EXTENSIONS = {
    ".3gp",
    ".avi",
    ".flv",
    ".m2ts",
    ".m4v",
    ".mkv",
    ".mov",
    ".mp4",
    ".mpeg",
    ".mpg",
    ".mts",
    ".ogm",
    ".ogv",
    ".ts",
    ".vob",
    ".webm",
    ".wmv",
}
RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
COPY_CHUNK_SIZE = 1024 * 1024
ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
PROJECT_ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


def load_env_file(path: Path) -> None:
    """Load a small, dependency-free subset of dotenv syntax.

    Existing process environment values win over values in the file. Supported
    lines are KEY=VALUE or export KEY=VALUE, with optional matching quotes.
    """

    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except OSError as error:
        raise ValueError(f"cannot read environment file {path}: {error}") from error

    for line_number, raw_line in enumerate(lines, start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise ValueError(f"{path}:{line_number}: expected KEY=VALUE")
        name, value = line.split("=", 1)
        name = name.strip()
        value = value.strip()
        if not ENV_NAME_RE.fullmatch(name):
            raise ValueError(f"{path}:{line_number}: invalid variable name {name!r}")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        os.environ.setdefault(name, value)


def preload_environment(argv: list[str] | None = None) -> Path | None:
    """Load --env-file before constructing defaults for the full parser."""

    pre_parser = argparse.ArgumentParser(add_help=False)
    pre_parser.add_argument("--env-file", type=Path)
    known, _ = pre_parser.parse_known_args(argv)
    configured = os.environ.get("STOPANDGO_ENV_FILE")
    env_file = known.env_file or (Path(configured) if configured else None)
    explicitly_configured = env_file is not None
    if env_file is None and PROJECT_ENV_FILE.is_file():
        env_file = PROJECT_ENV_FILE
    if env_file is None:
        return None
    env_file = env_file.expanduser().resolve()
    if not env_file.is_file():
        if explicitly_configured:
            raise SystemExit(f"environment file does not exist: {env_file}")
        return None
    try:
        load_env_file(env_file)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    return env_file


def env_number(
    name: str,
    default: int | float,
    convert: type[int] | type[float],
) -> int | float:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return convert(value)
    except ValueError as error:
        raise SystemExit(f"{name} must be a valid {convert.__name__}: {value!r}") from error


def redact_request_log(message: str) -> str:
    """Hide query-string credentials before writing an HTTP request log."""

    return re.sub(r"([?&]token=)[^&\s]+", r"\1[redacted]", message)


@dataclass(frozen=True)
class Settings:
    root: Path
    token: str | None
    public_base_url: str | None
    extensions: frozenset[str]
    probe: MediaProbe | None = None
    export_root: Path | None = None
    jobs: ExportJobs | None = None


class MediaProbe:
    """Cache ffprobe results until a file's size or modification time changes."""

    def __init__(self, command: str, timeout: float = 15.0) -> None:
        self.command = command
        self.timeout = timeout
        self._cache: dict[Path, tuple[tuple[int, int], dict[str, object] | None]] = {}
        self._lock = threading.Lock()

    def inspect(self, path: Path, size: int, mtime_ns: int) -> dict[str, object] | None:
        signature = (size, mtime_ns)
        with self._lock:
            cached = self._cache.get(path)
            if cached and cached[0] == signature:
                return cached[1]

        result = self._run(path)
        with self._lock:
            self._cache[path] = (signature, result)
        return result

    def _run(self, path: Path) -> dict[str, object] | None:
        try:
            completed = subprocess.run(
                [
                    self.command,
                    "-v",
                    "error",
                    "-show_entries",
                    "stream=codec_type,codec_name,width,height,color_transfer:format=duration",
                    "-of",
                    "json",
                    str(path),
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=self.timeout,
            )
            payload = json.loads(completed.stdout)
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            return None

        streams = payload.get("streams", [])
        video = next(
            (stream for stream in streams if stream.get("codec_type") == "video"),
            None,
        )
        if video is None:
            return None
        audio = next(
            (stream for stream in streams if stream.get("codec_type") == "audio"),
            None,
        )
        try:
            duration = round(float(payload.get("format", {}).get("duration", 0)))
        except (TypeError, ValueError):
            duration = 0
        return {
            "duration": max(0, duration),
            "width": int(video.get("width") or 0),
            "height": int(video.get("height") or 0),
            "video_codec": str(video.get("codec_name") or "").upper(),
            "audio_codec": str((audio or {}).get("codec_name") or "").upper(),
            "color_transfer": str(video.get("color_transfer") or "").lower(),
        }


class ExportJobs:
    def __init__(
        self,
        ffmpeg: str,
        export_root: Path,
        probe: MediaProbe | None,
    ) -> None:
        self.ffmpeg = ffmpeg
        self.export_root = export_root
        self.probe = probe
        self._executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=2, thread_name_prefix="stopandgo-export"
        )
        self._jobs: dict[str, dict[str, object]] = {}
        self._lock = threading.Lock()

    def submit_clip(
        self, path: Path, end: float, duration: float
    ) -> dict[str, object]:
        job_id = secrets.token_hex(8)
        title, _ = movie_title(path)
        filename = export_filename(title, "mp4")
        output = self.export_root / "clips" / filename
        job: dict[str, object] = {
            "id": job_id,
            "kind": "clip",
            "status": "queued",
            "filename": filename,
        }
        with self._lock:
            self._jobs[job_id] = job
        self._executor.submit(self._create_clip, job_id, path, output, end, duration)
        return dict(job)

    def get(self, job_id: str) -> dict[str, object] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return dict(job) if job else None

    def _update(self, job_id: str, **values: object) -> None:
        with self._lock:
            self._jobs[job_id].update(values)

    def _create_clip(
        self,
        job_id: str,
        source: Path,
        output: Path,
        end: float,
        duration: float,
    ) -> None:
        self._update(job_id, status="running")
        start = max(0.0, end - duration)
        actual_duration = max(0.1, end - start)
        video_filter = "format=yuv420p"
        temporary = output.with_name(f".{output.name}.{job_id}.partial")
        try:
            stat = source.stat()
            metadata = (
                self.probe.inspect(source, stat.st_size, stat.st_mtime_ns)
                if self.probe
                else None
            )
            if metadata and metadata.get("color_transfer") in {
                "smpte2084",
                "arib-std-b67",
            }:
                video_filter = (
                    "zscale=t=linear:npl=100,format=gbrpf32le,"
                    "zscale=p=bt709,tonemap=hable:desat=0,"
                    "zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
                )
            completed = subprocess.run(
                [
                    self.ffmpeg,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-ss",
                    f"{start:.3f}",
                    "-i",
                    str(source),
                    "-t",
                    f"{actual_duration:.3f}",
                    "-map",
                    "0:v:0",
                    "-map",
                    "0:a:0?",
                    "-sn",
                    "-dn",
                    "-vf",
                    video_filter,
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "20",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "160k",
                    "-movflags",
                    "+faststart",
                    "-f",
                    "mp4",
                    str(temporary),
                ],
                capture_output=True,
                text=True,
                timeout=300,
            )
            if (
                completed.returncode != 0
                or not temporary.is_file()
                or temporary.stat().st_size == 0
            ):
                detail = completed.stderr.strip().splitlines()[-1:] or ["ffmpeg failed"]
                raise RuntimeError(detail[0])
            os.replace(temporary, output)
        except Exception as error:  # job errors are reported through the API
            temporary.unlink(missing_ok=True)
            self._update(job_id, status="failed", error=str(error)[:300])
            return
        self._update(
            job_id,
            status="complete",
            server_path=str(output),
            size=output.stat().st_size,
        )


def export_filename(title: str, extension: str) -> str:
    safe = re.sub(r"[^\w .()-]+", "-", title, flags=re.UNICODE)
    safe = re.sub(r"\s+", " ", safe).strip(" .-") or "capture"
    timestamp = datetime.now().strftime("%Y-%m-%d %H.%M.%S")
    return f"{safe} - {timestamp}-{secrets.token_hex(2)}.{extension}"


def parse_extensions(value: str) -> frozenset[str]:
    extensions: set[str] = set()
    for raw in value.split(","):
        extension = raw.strip().lower()
        if not extension:
            continue
        extensions.add(extension if extension.startswith(".") else f".{extension}")
    if not extensions:
        raise argparse.ArgumentTypeError("at least one extension is required")
    return frozenset(extensions)


def file_url(
    base_url: str,
    relative_path: str,
    token: str | None,
    route: str = "media",
) -> str:
    encoded = quote(relative_path, safe="/")
    url = f"{base_url.rstrip('/')}/{route.strip('/')}/{encoded}"
    if token:
        url += f"?token={quote(token, safe='')}"
    return url


def movie_title(path: Path) -> tuple[str, str | None]:
    """Turn common release filenames into a readable title and optional year."""
    filename = path.stem
    parent = path.parent.name
    source = parent if not re.search(r"\b(?:19|20)\d{2}\b", filename) and re.search(
        r"\b(?:19|20)\d{2}\b", parent
    ) else filename
    cleaned = re.sub(r"[._]+", " ", source)
    cleaned = re.sub(r"\[[^]]*]", " ", cleaned)
    year_match = re.search(r"\b((?:19|20)\d{2})\b", cleaned)
    year = year_match.group(1) if year_match else None
    if year_match:
        cleaned = cleaned[: year_match.start()]
    else:
        cleaned = re.split(
            r"\b(?:2160p|1080p|720p|UHD|BluRay|WEBRip|WEB-DL|HDR|DV|HEVC|x26[45])\b",
            cleaned,
            maxsplit=1,
            flags=re.IGNORECASE,
        )[0]
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" -()") or path.stem
    if cleaned.islower():
        cleaned = cleaned.title()
    return cleaned, year


def catalog(settings: Settings, base_url: str) -> tuple[list[dict[str, object]], int]:
    return catalog_directory(settings, settings.root, base_url, "media")


def clip_catalog(
    settings: Settings,
    base_url: str,
) -> tuple[list[dict[str, object]], int]:
    if settings.export_root is None:
        return [], 0
    return catalog_directory(
        settings,
        settings.export_root / "clips",
        base_url,
        "clips",
        clips=True,
    )


def catalog_directory(
    settings: Settings,
    root: Path,
    base_url: str,
    route: str,
    clips: bool = False,
) -> tuple[list[dict[str, object]], int]:
    items: list[dict[str, object]] = []
    hidden = 0
    allowed_extensions = frozenset({".mp4"}) if clips else settings.extensions
    for path in root.rglob("*"):
        try:
            if path.is_symlink() or not path.is_file():
                continue
            if path.suffix.lower() not in allowed_extensions:
                continue
            stat = path.stat()
        except OSError:
            continue

        media = (
            settings.probe.inspect(path, stat.st_size, stat.st_mtime_ns)
            if settings.probe
            else {}
        )
        if media is None:
            hidden += 1
            continue

        relative = path.relative_to(root).as_posix()
        if clips:
            title = re.sub(
                r" - \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}-[0-9a-f]{4}$",
                "",
                path.stem,
            )
            year = None
        else:
            title, year = movie_title(path)
        items.append(
            {
                "name": path.name,
                "title": title,
                "year": year,
                "path": relative,
                "size": stat.st_size,
                "modified": datetime.fromtimestamp(
                    stat.st_mtime, tz=timezone.utc
                ).isoformat(),
                "url": file_url(base_url, relative, settings.token, route),
                "created": (
                    datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).strftime(
                        "%b %d %H:%M UTC"
                    )
                    if clips
                    else None
                ),
                **media,
            }
        )
    if clips:
        items.sort(key=lambda item: str(item["modified"]), reverse=True)
    else:
        items.sort(key=lambda item: (str(item["title"]).casefold(), str(item["path"])))
    return items, hidden


def resolve_media_path(root: Path, encoded_path: str) -> Path | None:
    return resolve_relative_path(root, unquote(encoded_path))


def resolve_relative_path(root: Path, relative_path: str) -> Path | None:
    pure = PurePosixPath(relative_path)
    if pure.is_absolute() or ".." in pure.parts:
        return None
    try:
        candidate = (root / Path(*pure.parts)).resolve()
        candidate.relative_to(root)
    except (OSError, RuntimeError, ValueError):
        return None
    if candidate.is_symlink() or not candidate.is_file():
        return None
    return candidate


def parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    """Return an inclusive byte range; raise ValueError for an invalid range."""
    if header is None:
        return None
    if size <= 0:
        raise ValueError("empty resource has no satisfiable ranges")
    match = RANGE_RE.fullmatch(header.strip())
    if not match or "," in header:
        raise ValueError("only a single byte range is supported")

    first, last = match.groups()
    if not first and not last:
        raise ValueError("empty range")
    if not first:
        suffix_length = int(last)
        if suffix_length <= 0:
            raise ValueError("invalid suffix range")
        return max(0, size - suffix_length), size - 1

    start = int(first)
    end = int(last) if last else size - 1
    if start >= size or start > end:
        raise ValueError("unsatisfiable range")
    return start, min(end, size - 1)


class MediaHandler(BaseHTTPRequestHandler):
    server_version = "StopAndGo/0.1"
    settings: Settings

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self._handle(send_body=True)

    def do_HEAD(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self._handle(send_body=False)

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlsplit(self.path)
        if not self._authorized(parsed.query):
            self._send_json(
                {"error": "unauthorized"}, status=HTTPStatus.UNAUTHORIZED
            )
            return
        if parsed.path == "/api/export/clip":
            self._create_clip()
            return
        if parsed.path == "/api/export/screenshot":
            self._save_screenshot(parsed.query)
            return
        self._send_json({"error": "not found"}, status=HTTPStatus.NOT_FOUND)

    def _handle(self, send_body: bool) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/healthz":
            self._send_json({"ok": True}, send_body=send_body)
            return
        if not self._authorized(parsed.query):
            self._send_json(
                {"error": "unauthorized"},
                status=HTTPStatus.UNAUTHORIZED,
                send_body=send_body,
            )
            return
        if parsed.path == "/api/files":
            base_url = self.settings.public_base_url or self._request_base_url()
            files, hidden = catalog(self.settings, base_url)
            self._send_json(
                {"files": files, "hidden": hidden}, send_body=send_body
            )
            return
        if parsed.path == "/api/clips":
            base_url = self.settings.public_base_url or self._request_base_url()
            files, hidden = clip_catalog(self.settings, base_url)
            self._send_json(
                {"files": files, "hidden": hidden}, send_body=send_body
            )
            return
        if parsed.path.startswith("/api/export/jobs/"):
            self._send_job(parsed.path.removeprefix("/api/export/jobs/"), send_body)
            return
        if parsed.path.startswith("/media/"):
            self._send_media(parsed.path.removeprefix("/media/"), send_body)
            return
        if parsed.path.startswith("/clips/") and self.settings.export_root:
            self._send_media(
                parsed.path.removeprefix("/clips/"),
                send_body,
                self.settings.export_root / "clips",
                frozenset({".mp4"}),
            )
            return
        self._send_json(
            {"error": "not found"},
            status=HTTPStatus.NOT_FOUND,
            send_body=send_body,
        )

    def _authorized(self, query: str) -> bool:
        expected = self.settings.token
        if not expected:
            return True
        authorization = self.headers.get("Authorization", "")
        supplied = authorization.removeprefix("Bearer ") if authorization.startswith("Bearer ") else ""
        if not supplied:
            supplied = parse_qs(query).get("token", [""])[0]
        return hmac.compare_digest(supplied, expected)

    def _request_base_url(self) -> str:
        forwarded_proto = self.headers.get("X-Forwarded-Proto", "").split(",", 1)[0]
        scheme = forwarded_proto.strip() or "http"
        host = self.headers.get("Host", "127.0.0.1")
        return f"{scheme}://{host}"

    def _read_body(self, maximum: int) -> bytes | None:
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0 or length > maximum:
            self._send_json(
                {"error": "invalid content length"},
                status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            )
            return None
        return self.rfile.read(length)

    def _create_clip(self) -> None:
        if not self.settings.jobs:
            self._send_json(
                {"error": "exports are disabled"},
                status=HTTPStatus.SERVICE_UNAVAILABLE,
            )
            return
        body = self._read_body(64 * 1024)
        if body is None:
            return
        try:
            request = json.loads(body)
            relative = request["path"]
            end = float(request["end"])
            duration = float(request.get("duration", 15))
            if not isinstance(relative, str) or not (1 <= duration <= 60) or end < 0:
                raise ValueError
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            self._send_json(
                {"error": "invalid clip request"}, status=HTTPStatus.BAD_REQUEST
            )
            return
        path = resolve_relative_path(self.settings.root, relative)
        if path is None or path.suffix.lower() not in self.settings.extensions:
            self._send_json(
                {"error": "media file not found"}, status=HTTPStatus.NOT_FOUND
            )
            return
        job = self.settings.jobs.submit_clip(path, end=end, duration=duration)
        self._send_json(job, status=HTTPStatus.ACCEPTED)

    def _save_screenshot(self, query: str) -> None:
        if not self.settings.export_root:
            self._send_json(
                {"error": "exports are disabled"},
                status=HTTPStatus.SERVICE_UNAVAILABLE,
            )
            return
        params = parse_qs(query)
        relative = params.get("path", [""])[0]
        source = resolve_relative_path(self.settings.root, relative)
        if source is None:
            self._send_json(
                {"error": "media file not found"}, status=HTTPStatus.NOT_FOUND
            )
            return
        if self.headers.get_content_type() != "image/png":
            self._send_json(
                {"error": "screenshot must be a PNG"},
                status=HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
            )
            return
        body = self._read_body(50 * 1024 * 1024)
        if body is None:
            return
        if len(body) < 8 or body[:8] != b"\x89PNG\r\n\x1a\n":
            self._send_json(
                {"error": "invalid PNG"}, status=HTTPStatus.BAD_REQUEST
            )
            return
        title, _ = movie_title(source)
        filename = export_filename(title, "png")
        output = self.settings.export_root / "screenshots" / filename
        try:
            with output.open("xb") as destination:
                destination.write(body)
        except OSError:
            self._send_json(
                {"error": "could not save screenshot"},
                status=HTTPStatus.INTERNAL_SERVER_ERROR,
            )
            return
        self._send_json(
            {
                "status": "complete",
                "filename": filename,
                "server_path": str(output),
                "size": len(body),
            },
            status=HTTPStatus.CREATED,
        )

    def _send_job(self, job_id: str, send_body: bool) -> None:
        job = self.settings.jobs.get(job_id) if self.settings.jobs else None
        if not job:
            self._send_json(
                {"error": "job not found"},
                status=HTTPStatus.NOT_FOUND,
                send_body=send_body,
            )
            return
        self._send_json(job, send_body=send_body)

    def _send_json(
        self,
        value: object,
        status: HTTPStatus = HTTPStatus.OK,
        send_body: bool = True,
    ) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def _send_media(
        self,
        encoded_path: str,
        send_body: bool,
        root: Path | None = None,
        extensions: frozenset[str] | None = None,
    ) -> None:
        path = resolve_media_path(root or self.settings.root, encoded_path)
        allowed_extensions = extensions or self.settings.extensions
        if path is None or path.suffix.lower() not in allowed_extensions:
            self._send_json(
                {"error": "file not found"},
                status=HTTPStatus.NOT_FOUND,
                send_body=send_body,
            )
            return

        try:
            size = path.stat().st_size
            selected_range = parse_range(self.headers.get("Range"), size)
        except ValueError:
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        except OSError:
            self._send_json(
                {"error": "file unavailable"},
                status=HTTPStatus.NOT_FOUND,
                send_body=send_body,
            )
            return

        start, end = selected_range or (0, size - 1)
        length = max(0, end - start + 1)
        self.send_response(
            HTTPStatus.PARTIAL_CONTENT if selected_range else HTTPStatus.OK
        )
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("Content-Disposition", f"inline; filename*=UTF-8''{quote(path.name)}")
        if selected_range:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()

        if not send_body or length == 0:
            return
        try:
            with path.open("rb") as source:
                self._copy_range(source, start, length)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _copy_range(self, source: BinaryIO, start: int, length: int) -> None:
        source.seek(start)
        remaining = length
        while remaining:
            chunk = source.read(min(COPY_CHUNK_SIZE, remaining))
            if not chunk:
                break
            self.wfile.write(chunk)
            remaining -= len(chunk)

    def log_message(self, fmt: str, *args: object) -> None:
        message = redact_request_log(fmt % args)
        sys.stderr.write(
            f"{self.log_date_time_string()} {self.client_address[0]} {message}\n"
        )


def make_handler(settings: Settings) -> type[MediaHandler]:
    class ConfiguredMediaHandler(MediaHandler):
        pass

    ConfiguredMediaHandler.settings = settings
    return ConfiguredMediaHandler


def build_parser(env_file: Path | None = None) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--env-file",
        type=Path,
        default=env_file,
        help="dotenv file (defaults to the project .env when present)",
    )
    root_default = os.environ.get("STOPANDGO_ROOT")
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(root_default) if root_default else None,
        help="media directory (or STOPANDGO_ROOT)",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("STOPANDGO_HOST", "127.0.0.1"),
        help="listen address (or STOPANDGO_HOST)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=env_number("STOPANDGO_PORT", 8765, int),
        help="listen port (or STOPANDGO_PORT)",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("STOPANDGO_TOKEN"),
        help="optional bearer token (or set STOPANDGO_TOKEN)",
    )
    parser.add_argument(
        "--public-base-url",
        default=os.environ.get("STOPANDGO_PUBLIC_BASE_URL"),
        help="URL clients use, e.g. https://media.example.ts.net",
    )
    extension_default = os.environ.get("STOPANDGO_EXTENSIONS")
    parser.add_argument(
        "--extensions",
        type=parse_extensions,
        default=(
            parse_extensions(extension_default)
            if extension_default
            else frozenset(DEFAULT_EXTENSIONS)
        ),
        help="comma-separated allowed extensions",
    )
    parser.add_argument(
        "--ffprobe",
        default=os.environ.get("STOPANDGO_FFPROBE") or shutil.which("ffprobe"),
        help="ffprobe executable used to hide invalid media",
    )
    parser.add_argument(
        "--no-validate",
        action="store_true",
        help="show files without validating them with ffprobe",
    )
    parser.add_argument(
        "--probe-timeout",
        type=float,
        default=env_number("STOPANDGO_PROBE_TIMEOUT", 15.0, float),
        help="seconds allowed to inspect each changed file",
    )
    export_default = os.environ.get("STOPANDGO_EXPORT_ROOT")
    parser.add_argument(
        "--export-root",
        type=Path,
        default=Path(export_default) if export_default else None,
        help="directory for server-side clips and screenshots",
    )
    parser.add_argument(
        "--ffmpeg",
        default=os.environ.get("STOPANDGO_FFMPEG") or shutil.which("ffmpeg"),
        help="ffmpeg executable used for server-side clips",
    )
    return parser


def main() -> None:
    env_file = preload_environment()
    args = build_parser(env_file).parse_args()
    if args.root is None:
        raise SystemExit(
            "media root is required: set STOPANDGO_ROOT in .env or pass --root"
        )
    root = args.root.expanduser().resolve()
    if not root.is_dir():
        raise SystemExit(f"media root is not a directory: {root}")
    if not args.no_validate and not args.ffprobe:
        raise SystemExit("ffprobe is required for validation (or use --no-validate)")
    export_root = args.export_root.expanduser().resolve() if args.export_root else None
    if export_root and not args.ffmpeg:
        raise SystemExit("ffmpeg is required when --export-root is configured")
    if export_root:
        (export_root / "clips").mkdir(parents=True, exist_ok=True)
        (export_root / "screenshots").mkdir(parents=True, exist_ok=True)
    probe = (
        None
        if args.no_validate
        else MediaProbe(args.ffprobe, timeout=args.probe_timeout)
    )
    settings = Settings(
        root=root,
        token=args.token or None,
        public_base_url=args.public_base_url,
        extensions=args.extensions,
        probe=probe,
        export_root=export_root,
        jobs=ExportJobs(args.ffmpeg, export_root, probe) if export_root else None,
    )
    server = ThreadingHTTPServer((args.host, args.port), make_handler(settings))
    server.daemon_threads = True
    host, port = server.server_address[:2]
    print(f"StopAndGo serving {root} on http://{host}:{port}", flush=True)
    if not settings.token:
        print("Warning: no application token configured", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
