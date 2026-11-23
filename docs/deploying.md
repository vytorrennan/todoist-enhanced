# Running the server

The app and its API are one Node process. It serves the built app from
`dist/`, answers `/api/v1/…`, and keeps everything in one SQLite file. There is
nothing else to deploy.

## First run

```bash
npm ci
npm run build          # the app, into dist/
npm run build:server   # the server, into dist-server/
PORT=8787 DATA_DIR=/var/lib/enhanced node dist-server/index.mjs
```

The first start creates `DATA_DIR/enhanced.db` and runs the schema migrations.
The log names the address, the data folder, and whether new accounts are open.
Stop it with Ctrl-C or `SIGTERM`; it finishes what it is doing and closes the
database.

`npm start` is the same as the last line, with the defaults (`127.0.0.1:8787`,
`./data`, `./dist`).

## Put it behind HTTPS

The server speaks plain HTTP. For anything reachable from another machine, put
a reverse proxy in front of it that terminates HTTPS and forwards to
`127.0.0.1:8787`, and set `TDE_SECURE_COOKIES=1` so the session cookie is only
sent over HTTPS. The proxy should pass `X-Forwarded-Proto` through (the server
checks it when it decides whether a cookie is Secure).

Example with Caddy:

```
enhanced.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

## Keeping it running

A systemd unit is enough:

```ini
[Service]
WorkingDirectory=/opt/enhanced
Environment=PORT=8787 HOST=127.0.0.1 DATA_DIR=/var/lib/enhanced TDE_SECURE_COOKIES=1 TDE_SIGNUP=closed
ExecStart=/usr/bin/node dist-server/index.mjs
Restart=on-failure
```

`TDE_SIGNUP=closed` stops strangers creating accounts; the people who already
have one keep signing in. Create the accounts you need first, then close it.

Who you invite is only as trustworthy as who can register. An email address is
not verified here, so whoever registers an address receives the invitations sent
to it. This is the trust model of a server you run for people you know: keep
signup closed on any instance where strangers can register.

## Configuration

See the table in the README. The ones most people change are `DATA_DIR`,
`HOST`, `TDE_SIGNUP`, and `TDE_SECURE_COOKIES`.

## Health and checks

```bash
curl -s http://127.0.0.1:8787/api/v1/health      # {"ok":true,"version":"…","seq":…}
curl -s http://127.0.0.1:8787/api/v1/auth/config  # {"signup":true,"version":"…"}
curl -sI http://127.0.0.1:8787/ | grep -i content-security-policy
```

## Backups

The database is one file in WAL mode. Copy it while the server runs with SQLite's
own backup, which is consistent even under writes:

```bash
sqlite3 /var/lib/enhanced/enhanced.db ".backup '/backups/enhanced-$(date +%F).db'"
```

Back up `DATA_DIR/files` at the same time: comments refer to those files by id.

## Upgrading

Stop the server, replace the code, `npm ci`, `npm run build`, `npm run
build:server`, and start it again. Migrations run on start and are applied
once, in order. A database written by a newer version is refused rather than
changed, so a rollback needs the backup taken before the upgrade.

## Limits

- One process, one database file. It suits one person or a small team; it is
  not a horizontally scaled service.
- Each person has a request budget (`TDE_REQUESTS_PER_MINUTE`). A client that
  exceeds it is told to wait with `Retry-After`, and the app honours that.
- Uploads are kept on disk up to `TDE_MAX_UPLOAD_MB` each.
