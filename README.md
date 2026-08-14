# StopAndGo

StopAndGo is a small mpv extension for browsing and playing videos stored on another machine. It has two parts:

- a dependency-free Python server that scans a directory and streams files with HTTP byte-range support;
- an mpv Lua script that opens a remote library picker with `Ctrl+b`.
- export helpers that create 15-second clips and screenshots on the server.

Byte ranges matter: unlike `ssh server 'cat movie.mkv' | mpv -`, mpv can seek without reading the whole file up to the new position.

## Recommended layout

```text
Mac / mpv  ── HTTPS over Tailscale ──▶  Tailscale Serve
                                                │
                                                ▼
                                     StopAndGo on 127.0.0.1
                                                │
                                                ▼
                                         Downloads directory
```

Tailscale and mpv are not alternatives. Tailscale provides the private network connection; mpv is still the video player. If Tailscale is not wanted, use the SSH-tunnel setup below.

## 1. Run the server

The server requires Python 3.10 or newer and no packages. Keep machine-specific
paths, addresses, and the application token in a local `.env`:

```sh
cp .env.example .env
chmod 600 .env
${EDITOR:-vi} .env
python3 server/stopandgo_server.py
```

The project automatically loads its root `.env`. You can instead pass
`--env-file /path/to/file`; ordinary environment variables override the file,
and explicit command-line options override both. The real `.env` is ignored by
Git, while `.env.example` documents the available settings without real values.

The catalog is scanned again each time it is opened, so newly downloaded files appear without restarting the service. Symlinks and non-video extensions are not served.

For an always-on server cloned at `~/stopandgo`, install the included user
service after creating `.env`:

```sh
mkdir -p ~/.config/systemd/user
cp config/stopandgo-user.service ~/.config/systemd/user/stopandgo.service
systemctl --user daemon-reload
systemctl --user enable --now stopandgo
```

The user unit assumes the repository is at `~/stopandgo`. For a system-wide
installation, copy the project to `/opt/stopandgo`, put its environment file at
`/etc/stopandgo.env`, adapt [the system service example](config/stopandgo.service.example), and run:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now stopandgo
```

### Private access with Tailscale (recommended)

Keep StopAndGo bound to localhost and proxy it privately:

```sh
tailscale serve --bg 8765
tailscale serve status
```

Use the HTTPS URL printed by `tailscale serve status` as `--public-base-url` and in the mpv config. Tailscale Serve remains limited to your tailnet and its access rules; do not use Tailscale Funnel for a private movie library.

An extra StopAndGo token is normally unnecessary in this layout because the backend listens only on localhost and Tailscale controls access. If the tailnet has other users who should not see this service, restrict it with tailnet grants.

### Private access without Tailscale

Keep the server on `127.0.0.1`, omit `--public-base-url`, and create a tunnel from the Mac:

```sh
ssh -N -L 8765:127.0.0.1:8765 your-server
```

Set the mpv API URL to `http://127.0.0.1:8765/api/files`. This retains full seeking because only the HTTP connection travels inside SSH. A macOS LaunchAgent or `autossh` can make the tunnel persistent later.

### Direct HTTP and tokens

If the server must listen on a network interface, generate a strong token and
put it in `.env` along with the server's private address:

```sh
openssl rand -hex 32
# Set STOPANDGO_TOKEN, STOPANDGO_HOST, and STOPANDGO_PUBLIC_BASE_URL in .env.
python3 server/stopandgo_server.py
```

The token is access control, not encryption. Do not expose this server to the public internet, and do not use an unencrypted route over an untrusted network.

## 2. Install the mpv script on the Mac

Run:

```sh
./macos/install-client.sh
```

Then edit `~/.config/mpv/script-opts/stopandgo.conf`:

```ini
api_url=https://your-server.your-tailnet.ts.net/api/files
clips_api_url=
token=
key=Ctrl+b
```

If the server was started with a token, put the same value in `token`. Start mpv, press `Ctrl+b`, select with the arrow keys, and press Enter. Press `Tab` or `c` to switch between the movie library and completed server clips, `r` to rescan, or Esc to close the picker. `clips_api_url` can normally stay blank because it is inferred from `api_url`.

During playback, press `5` to queue an exact 15-second MP4 clip on the server, or `s` to capture the current mpv frame with subtitles and upload it as a PNG. The server stores them in the `clips` and `screenshots` folders below `STOPANDGO_EXPORT_ROOT`. Configure the keys, server URL, token, or duration in `~/.config/mpv/script-opts/clip-last.conf`.

To open directly into the library without first choosing a video, double-click `macos/open-library.command`. It launches a fresh mpv window in idle mode and opens the picker automatically; an alias to that file can be placed in the Dock.

The macOS installer also creates `~/Applications/MPV Library.app`. It appears separately from the original mpv in Spotlight and Raycast and launches directly into the remote library.

The script uses the system `curl`. mpv's macOS app bundle includes `/usr/bin` in its command path, so the built-in macOS copy is visible.

## 3. Finder “Open in mpv”

This part does not need an mpv plugin. Install an **mpv.app bundle** in `/Applications`; a command-line-only Homebrew formula does not provide Finder application registration. Once installed, right-click any video and choose **Open With → mpv**. To make mpv the default, use **Get Info → Open with → mpv → Change All**.

For a separately named Finder action:

1. Open Automator and create a **Quick Action**.
2. Set “Workflow receives current” to **files or folders** in **Finder**.
3. Add **Run Shell Script**, set “Pass input” to **as arguments**, and use:

   ```sh
   /usr/bin/open -a mpv "$@"
   ```

4. Save it as **Open in mpv**.

It will appear in Finder's **Quick Actions** menu. A true custom top-level context-menu entry requires shipping and signing a Finder Sync app extension, which is disproportionate for this use case.

## Windows client

The server does not change. On Windows 10 or 11, install Tailscale and sign in to the same tailnet, install `mpv.exe`, and copy this project to the PC. Then run PowerShell from the project directory:

```powershell
.\windows\install.ps1
```

It prompts for the server URL and securely prompts for the StopAndGo application token. You can also pass `-ServerUrl "http://your-server:8765"` and `-MpvPath "C:\path\to\mpv.exe"`. The installer uses `%APPDATA%\mpv` unless a `portable_config` directory exists beside `mpv.exe`, registers the original mpv in Explorer's **Open with** menu, and creates a separate searchable **MPV Library** Start-menu shortcut. The keys and server-side export behavior are the same as on macOS.

## API

- `GET /healthz` — unauthenticated health check
- `GET /api/files` — JSON catalog
- `GET /api/clips` — JSON catalog of completed server clips, newest first
- `GET` or `HEAD /media/<relative-path>` — video stream with one HTTP byte range per request
- `GET` or `HEAD /clips/<relative-path>` — completed clip stream with byte-range support
- `POST /api/export/clip` — queue a server-side ffmpeg clip
- `POST /api/export/screenshot` — upload an mpv-rendered PNG
- `GET /api/export/jobs/<id>` — check clip progress

When configured, authentication accepts `Authorization: Bearer <token>`. Media URLs include the token as a query parameter because mpv/FFmpeg must issue its own range requests.

## Test

```sh
python3 -m unittest discover -s tests -v
```

## Publishing to GitHub

The repository ignores `.env`, generated archives, Python caches, logs, and
common editor files. Before each push, use `git status --ignored` to confirm
that local configuration remains ignored. A Tailscale `100.x` address is not an
authentication secret and is unreachable without tailnet access, but keeping it
out of the repository avoids publishing network metadata and makes the project
portable. The application token is a credential and must never be committed.
