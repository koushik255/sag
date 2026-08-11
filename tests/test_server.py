from __future__ import annotations

import json
import os
import sys
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).parents[1] / "server"))

from stopandgo_server import (  # noqa: E402
    MediaHandler,
    Settings,
    ThreadingHTTPServer,
    load_env_file,
    make_handler,
    movie_title,
    parse_range,
    redact_request_log,
    resolve_media_path,
)


class EnvironmentTests(unittest.TestCase):
    def test_loads_dotenv_without_overwriting_process_environment(self) -> None:
        first = "STOPANDGO_TEST_FROM_FILE"
        existing = "STOPANDGO_TEST_EXISTING"
        old_first = os.environ.pop(first, None)
        old_existing = os.environ.get(existing)
        os.environ[existing] = "from-process"
        try:
            with TemporaryDirectory() as directory:
                path = Path(directory) / ".env"
                path.write_text(
                    f'{first}="from file"\nexport {existing}=from-file\n',
                    encoding="utf-8",
                )
                load_env_file(path)
            self.assertEqual(os.environ[first], "from file")
            self.assertEqual(os.environ[existing], "from-process")
        finally:
            os.environ.pop(first, None)
            if old_first is not None:
                os.environ[first] = old_first
            if old_existing is None:
                os.environ.pop(existing, None)
            else:
                os.environ[existing] = old_existing

    def test_rejects_invalid_dotenv_line(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text("not-an-assignment\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "expected KEY=VALUE"):
                load_env_file(path)


class LoggingTests(unittest.TestCase):
    def test_redacts_media_token_from_request_log(self) -> None:
        message = '"GET /media/Movie.mkv?token=secret-value HTTP/1.1" 206 -'
        self.assertEqual(
            redact_request_log(message),
            '"GET /media/Movie.mkv?token=[redacted] HTTP/1.1" 206 -',
        )


class RangeTests(unittest.TestCase):
    def test_standard_range(self) -> None:
        self.assertEqual(parse_range("bytes=2-5", 10), (2, 5))

    def test_open_ended_range(self) -> None:
        self.assertEqual(parse_range("bytes=7-", 10), (7, 9))

    def test_suffix_range(self) -> None:
        self.assertEqual(parse_range("bytes=-3", 10), (7, 9))

    def test_rejects_unsatisfiable_range(self) -> None:
        with self.assertRaises(ValueError):
            parse_range("bytes=10-", 10)

    def test_rejects_range_for_empty_file(self) -> None:
        with self.assertRaises(ValueError):
            parse_range("bytes=0-", 0)


class PathTests(unittest.TestCase):
    def test_rejects_traversal(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            self.assertIsNone(resolve_media_path(root, "../secret.mkv"))


class TitleTests(unittest.TestCase):
    def test_cleans_release_name(self) -> None:
        title, year = movie_title(
            Path("The.Dark.Knight.2008.IMAX.2160p.HEVC-Group.mkv")
        )
        self.assertEqual(title, "The Dark Knight")
        self.assertEqual(year, "2008")

    def test_uses_descriptive_parent_for_generic_filename(self) -> None:
        title, year = movie_title(
            Path("Thank You For Smoking (2005) [1080p]") / "video.mp4"
        )
        self.assertEqual(title, "Thank You For Smoking")
        self.assertEqual(year, "2005")


class ServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = TemporaryDirectory()
        self.root = Path(self.tempdir.name).resolve()
        (self.root / "Movie.mkv").write_bytes(b"0123456789")
        (self.root / "ignore.txt").write_text("nope")
        self.exports = self.root / "exports"
        (self.exports / "screenshots").mkdir(parents=True)
        settings = Settings(
            root=self.root,
            token="test-token",
            public_base_url=None,
            extensions=frozenset({".mkv"}),
            export_root=self.exports,
        )
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(settings))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tempdir.cleanup()

    def test_catalog_and_range_request(self) -> None:
        request = Request(
            f"{self.base_url}/api/files", headers={"Authorization": "Bearer test-token"}
        )
        with urlopen(request) as response:
            body = json.load(response)
        self.assertEqual([item["path"] for item in body["files"]], ["Movie.mkv"])
        self.assertTrue(body["files"][0]["url"].endswith("Movie.mkv?token=test-token"))

        media_request = Request(
            body["files"][0]["url"], headers={"Range": "bytes=2-5"}
        )
        with urlopen(media_request) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.headers["Content-Range"], "bytes 2-5/10")
            self.assertEqual(response.read(), b"2345")

    def test_requires_token(self) -> None:
        with self.assertRaises(HTTPError) as raised:
            urlopen(f"{self.base_url}/api/files")
        self.assertEqual(raised.exception.code, 401)
        raised.exception.close()

    def test_saves_authenticated_png_screenshot(self) -> None:
        png = b"\x89PNG\r\n\x1a\n" + b"test-image-data"
        request = Request(
            f"{self.base_url}/api/export/screenshot?path={quote('Movie.mkv')}",
            data=png,
            method="POST",
            headers={
                "Authorization": "Bearer test-token",
                "Content-Type": "image/png",
            },
        )
        with urlopen(request) as response:
            body = json.load(response)
        self.assertEqual(response.status, 201)
        output = Path(body["server_path"])
        self.assertEqual(output.parent, self.exports / "screenshots")
        self.assertEqual(output.read_bytes(), png)


if __name__ == "__main__":
    unittest.main()
