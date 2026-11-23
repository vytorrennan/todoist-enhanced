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

The database is one file in WAL mode. Back it up while the server runs, with
SQLite's own backup, which is consistent even under writes. Copy the database
first and the files second:

```bash
mkdir -p /backups/2026-11-23
sqlite3 /var/lib/enhanced/enhanced.db ".backup '/backups/2026-11-23/enhanced.db'"
cp -r /var/lib/enhanced/files /backups/2026-11-23/files
```

Comments refer to uploaded files by id. A file is written before the comment that
carries it is saved, and a comment's file is never deleted afterwards, so the
folder copied second holds every file the database copied first refers to. (A
CSV import's upload is removed once it is imported; no comment refers to it.)

## Restoring

Restore into a stopped server, so no write lands between the two copies:

1. Stop the server.
2. Replace the database and the files. Remove the old `-wal` and `-shm` files
   first: they belong to the database being replaced, and SQLite would apply them
   to the restored one.

   ```bash
   rm -f /var/lib/enhanced/enhanced.db-wal /var/lib/enhanced/enhanced.db-shm
   cp /backups/2026-11-23/enhanced.db /var/lib/enhanced/enhanced.db
   rm -rf /var/lib/enhanced/files
   cp -r /backups/2026-11-23/files /var/lib/enhanced/files
   ```

3. Start the server, then check the database and the server:

   ```bash
   sqlite3 /var/lib/enhanced/enhanced.db "PRAGMA integrity_check;"  # ok
   curl -s http://127.0.0.1:8787/api/v1/health
   ```

A restore takes the database back to the moment of the backup. Anything saved
after it is lost, and so is any sign-out made after it: the sessions in the
backup are signed in again until they expire.

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
