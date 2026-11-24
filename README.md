<div align="center">

# Enhanced for Todoist, standalone

**A self-hosted planner for your week, with the Enhanced for Todoist front end.** It needs no Todoist account and no subscription. Your tasks live in a SQLite database on a server you run, and the app sends its data only to that server.

_This is an independent fork. It is not created by, affiliated with, or supported by Todoist, and it does not connect to Todoist._

</div>

---

## What this fork changes

- **No Todoist account.** Accounts, sign-in, sync and sharing run on the server included in this repository.
- **Your data on your server.** It lives in one SQLite file. A test suite runs the backup and restore procedure end to end.
- **The official Todoist MCP works with it.** An assistant can use the official `@todoist/mcp` against this server. See [MCP integration](#mcp-integration-and-configuration).
- **The same front end.** The planning screens, features and keyboard shortcuts come from the original Enhanced for Todoist app.

## Contents

- [Screenshots](#screenshots)
- [Quick start](#quick-start)
- [MCP integration and configuration](#mcp-integration-and-configuration)
- [Features](#features)
- [The basics you expect from a task app](#the-basics-you-expect-from-a-task-app)
- [Authentication and security](#authentication-and-security)
- [Architecture and data storage](#architecture-and-data-storage)
- [Backups and recovery](#backups-and-recovery)
- [Development and testing](#development-and-testing)
- [Known limitations](#known-limitations)
- [Acknowledgments and license](#acknowledgments-and-license)

## Screenshots

![My week](docs/default-my-week.png)

*My week, with the load pill and the totals across the top.*

![The daily review](docs/review.png)

*The daily review. One question at a time, answered from inside the step.*

![The insights dashboard](docs/insights-dashboard.png)

*Looking back over a period, with the focus score.*

![The task composer](docs/composer.png)

*The composer reads a date, a project, a priority and a tag from what was typed.*

![Things to settle](docs/thingstosettle-noestimates.png)

*Things to settle. Contradictions are listed with the options that match each intent.*

## Quick start

Clone this repository. Build the app and the server, then start the server. It serves the app and its API from one address.

You need Node 22 and npm. The version is pinned in `.nvmrc`.

    npm install
    npm run build          # the app, into dist/
    npm run build:server   # the server, into dist-server/
    npm start              # http://127.0.0.1:8787

Open the address, press **Create account**, and you are in. Press **Explore with demo data** to look around a made-up workspace without an account. Demo mode loads a few images from Unsplash.

The server serves the app and its API from one address, so there is nothing else to deploy. Before other machines can reach it, put it behind HTTPS, for example with a reverse proxy, and set `TDE_SECURE_COOKIES=1`.

### Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8787` | The port the server listens on |
| `HOST` | `127.0.0.1` | The address it listens on. `0.0.0.0` answers other machines |
| `DATA_DIR` | `./data` | Where `enhanced.db` (the database) and uploaded files are kept |
| `STATIC_DIR` | `./dist` | The built app to serve, when it exists |
| `TDE_SIGNUP` | `open` | `closed` stops anyone creating a new account. Addresses are not verified, so an invitation reaches whoever registers the address. Close sign-up on any instance strangers can reach |
| `TDE_SECURE_COOKIES` | `0` | `1` marks the session cookie Secure (HTTPS only) |
| `TDE_MAX_UPLOAD_MB` | `25` | The largest file a comment can carry |
| `TDE_REQUESTS_PER_MINUTE` | `600` | Requests allowed per person before a `429` with `Retry-After` |

## MCP integration and configuration

This server works with the official Todoist MCP, [`@todoist/mcp`](https://www.npmjs.com/package/@todoist/mcp) 17.3.8. An assistant that speaks MCP can read and change tasks, projects, sections, labels and filters on your server.

The MCP package needs **Node 24 and npm 11** or later. The app itself runs on Node 22.

### 1. Get a token

Sign in through the API. The reply has a `token`, which lasts 30 days:

    curl -s http://127.0.0.1:8787/api/v1/auth/login \
      -H 'content-type: application/json' \
      -d '{"email":"you@example.com","password":"YOUR_PASSWORD"}'

Keep the token secret. Anyone who has it can act as you. Signing out revokes it.

### 2. Run the MCP

    TODOIST_BASE_URL=http://127.0.0.1:8787 \
    TODOIST_API_KEY="YOUR_SERVER_TOKEN" \
    npx -y -p @todoist/mcp@17.3.8 todoist-mcp

The version is pinned because the compatibility described here was tested against 17.3.8. Without the pin, `npx` may fetch a newer release, and that release is not covered by these tests.

- `TODOIST_API_KEY` is the token from step 1.
- `TODOIST_BASE_URL` is the server's address alone. Do not add `/api/v1`. The MCP adds it.
- `127.0.0.1` means this machine. If the MCP runs on another machine, replace it with an address that reaches the server: the server's LAN address, or its domain name. Start the server with `HOST=0.0.0.0` so it listens on that interface, or put it behind a reverse proxy.
- Use HTTPS for anything beyond one machine. The token travels with every request. Set `TDE_SECURE_COOKIES=1` so the session cookie is sent only over HTTPS.

### What the MCP suite covers

The suite in `mcp-e2e/` runs the official package over its stdio transport, the way an assistant does. It covers:

- **Tasks.** Create, read, update, complete and delete. It also reads due phrases such as `2030-01-15` and `every monday` the way the app does.
- **Projects.** Create, nest, rename and delete. Find by name, with `*` for a wildcard and `\*` for a literal asterisk.
- **Sections.** Create, list, find by name within a project, and delete.
- **Labels.** List personal labels with their settings, page through them, and find them by name. Shared labels are the names on active tasks in a shared project. Personal names are included unless the caller sends `omit_personal=true`.
- **Filters.** Save, find, rename and delete. Day filters work with `due:` and `date:`.
- **Accounts and errors.** Sign-in is required, and a signed-out token stops working. One person's data never appears in another's lists. Missing fields, unknown tools, partial batches and double completions are reported as failures.

The suite does not cover comments, reminders, folders, workspaces, or most label and section writes. See [Known limitations](#known-limitations).

## Features

Everything here is stored as ordinary rows on your server. An estimate is a label, or a duration in the task's own field. "Anytime this week" is a label. The rest is projects, sections, priorities and dates. Your data sits in a SQLite file you can open, copy and back up.

- **Today, Anytime this week, Someday.** A planner asks which day a task belongs to, and most work has no good answer. It belongs to *this week*, and picking Tuesday for it is a guess you spend the week correcting. So there are three commitments instead of one. Today is what you have dated. Anytime this week is what you have committed to without pinning it to an afternoon. Someday is what you are not committing to yet. It is out of the week but not out of the app, and it comes back at the weekly review, so it never quietly becomes a graveyard. Tasks that have sat there for months are gathered at the top of the page in a group called Gathering dust. The threshold is three months by default, and you can set it anywhere from 1 to 12 in Settings. Each task in that group has three actions: This week, Keep and Delete. A task you keep stays in Someday and comes back only after another full delay. The device remembers that, and nothing else is recorded for it.

- **Eisenhower matrix.** The same tasks, sorted into four quadrants instead of a list: urgent and important, important but not urgent, urgent but not important, and neither. Urgency comes from the due date, and you choose how close counts as urgent. Importance comes from priority, either P1 alone or P1 and P2. You can switch to a flat list, filter by workspace, and decide whether Someday tasks count.

- **Daily and weekly review.** Each takes a few minutes and asks one question at a time, with a clear end. The daily review walks through what is late, your mail, the Inbox, what you committed to this week without naming a day, what has no estimate, and what today weighs against the hours you have. You answer each step from inside it, so you never leave the review to act on what it just told you. The weekly review closes the week and opens the next. It shows what you finished, the week in numbers, what is late, and which projects have gone quiet.

- **Task durations.** Write down how long a task takes, as `25`, `1h15` or `90 min`. Every page then shows how many tasks it holds, how much time they add up to, and what share of your capacity for that day or week they use. That share appears as a load pill: green, amber or over. A day filled to 140% shows that before you start it, not at six in the evening. A parent whose open subtasks all have a duration takes their sum, and the sum is written to the task itself. If one subtask has no duration, the parent keeps its own, or shows the partial sum as computed. Anything still unestimated is counted separately and listed in one place, so you can fill them in one pass. A duration set in the task's own field counts too. When both are present, the source chosen in Settings wins. Tags are the default, and editing a tag estimate keeps the calendar duration. The server checks every native estimate write against its data. A dropped or refused duration switches back to tags and recovers the estimate. If that check cannot run, it stays queued for the next sync. Durations in days are ignored, and estimates of 24 hours or more keep their exact minute value. Settings offers a conversion preview for open tasks, including subtasks. It shows skipped conflicts and a result for each batch. Converting timed durations to tags keeps their calendar blocks, and untimed durations are cleared. Conversion never deletes account labels or completed tasks.

- **I have time.** A pill sits next to the load figure on My week, projects, tags, the Inbox and Someday. Pick how long you have, from 5 minutes to an hour, or type any duration. A panel on the right lists the tasks that fit, by due date: overdue, today, tomorrow, this week, or no date. It looks in the page you are on, or everywhere. It never guesses at a task with no estimate. It counts those tasks and offers to estimate them. It leaves the page behind it exactly as it was. Nothing is changed, and nothing is remembered after a reload.

- **Checklists.** Lines like `- [ ] item` in a task's description show as small checkboxes in the task panel, with "3 of 7" beside the description. Ticking one changes only that line, so the same text still reads as plain text anywhere else. Editing works by rows rather than syntax. Enter adds the next item. Enter on an empty item leaves the list. Backspace at the start of an item turns it into plain text. Typing `[]` and a space starts a list, in the panel and in the new task window. Task rows never show the checklist lines.

- **Folders.** Group projects inside a folder, as most task apps do. A folder is a collapsible row that you can expand or collapse on its own, in your personal projects and in any team workspace. Drop a project onto a folder to file it inside.

- **Quick tasks on top of the list.** Anything short enough to do rather than plan goes into its own bucket at the top of the week. Quick means under five minutes, or tagged `quick`. The bucket sits at the top because that is when it helps: the five minutes before a meeting are the five minutes those tasks are for. A task tagged quick but estimated at forty minutes is not quick. It stays out, and it is reported as a contradiction. The same group leads a project, a tag, the Inbox and Someday. It holds the tasks that are late, due today or undated. A quick task due next month stays where it is. Each row says which section or project it comes from, and nothing is listed twice. On a board, the bucket is a blue first column for looking at, not for dropping tasks on. One switch in Settings turns it off everywhere.

- **Visible subtasks.** Subtasks appear under their parent in the list, indented, so you do not have to open the task to see them. The parent shows how many are done, and its estimate is the sum of theirs. Drag a row a little to the right over another row to put it inside that row. Pull a subtask out to the left to make it a task of its own again. The task composer works the same way. Add subtasks inline while you write the parent. Each one is its own editable row, and they are all created together when you save.

- **Project icons.** Pick an icon for a project from a searchable catalog, next to the colour picker. The icon is saved with the project, so it follows the project between devices, not just this browser.

- **Dashboard.** A board that changes with the period you pick. A day shows the hours you finished things in. A week adds its shape and a comparison with the week before. A quarter and a year show month by month. Edit layout lets you arrange the cards with the mouse or the keyboard. Reset to default puts them back. The focus score weights what you finished by its priority. That is the question worth asking about a finished week: did the effort go where it mattered, or into whatever was easiest to close?

- **Better logbook.** Shows what you finished, grouped by day. You can filter by several projects and priorities at once, not one at a time. It shares the period control with the dashboard, so the two always cover the same window.

- **Custom themes.** Ten accent colours, plus one you pick yourself. Each is drawn in light and in dark, and checked for contrast rather than chosen by eye. Dark mode is the same theme, not a lesser version of it. Choose light, dark, or whatever the device is set to.

- **Things to settle.** The app lists contradictions it should not resolve on its own. Examples are a task both dated and labelled for the week, two estimates on one task, or a quick task estimated at forty minutes. Each comes with the options that match each possible intent. Nothing changes until you choose one.

- **The keyboard, and a phone.** Arrows move through the list. Enter opens a task. `E` finishes it, and `T` schedules it. `G` followed by a letter goes somewhere, and typing anything else starts a search. These are the usual keys for task apps, and `?` shows the list. On a phone, swipe a task aside for its actions, and hold it for the rest.

## The basics you expect from a task app

- **Drag and drop.** Drag a task onto a day, a project, a tag, a section, a board column, or another task. In the sidebar, drag projects to reorder them, or a little to the right to nest them. Drop a task onto a row and it takes that row's place. The order is saved with the task. Every destination has one fixed meaning. Every drop says what it did, and every drop can be undone.

- **List, board and calendar views.** Sorting and filtering sit behind one Display control, and each page remembers its own setting. Calendar offers 3 days, week and month, an undated-tasks sidebar, drag and drop, and resizing in 15-minute steps. Tag estimates stay in tags. Recurring forecasts are read-only. Completed history shows on the day it was completed. Saved filters show the open tasks that match their query.

- **Natural language in the task composer.** Type a line such as `Call Marc tomorrow at 9h p1 #Work @quick (25)`. The date, project, priority, tag and estimate are marked inside the field as you type. They also fill the fields underneath, so you see what the app understood before you commit. Click a mark, or press Backspace against it, to turn that reading back into ordinary text. Recurring dates use the usual grammar: `every monday`, `every 3 days`, `every!`. The server works out each next date.

- **Projects, sections, tags and favourites.** Each has its own page, nested and ordered by dragging. The Inbox and Upcoming sit where you would expect them. A section has a menu with these actions: edit, move to another project, duplicate with its tasks, copy its link, archive, and delete.

- **Search.** Press `⌘K`, or just start typing. Search covers tasks, projects, sections, tags and every view in the app, so it is the fastest way to get anywhere.

- **Multi-select.** `⌘`-click items, then use the bar at the foot of the window to give them all a date, a project, a tag or a priority.

- **Markdown in descriptions.** Descriptions render in the list and in the task panel.

- **And the rest.** Undo (`⌘Z`) works for a move, a completion, a deletion or a drop, and a deleted task comes back with its subtasks. Changes made offline are queued and sent when you reconnect. You can install the app on your device. It is available in English and French, with settings for the things people disagree about.

## Authentication and security

- **Passwords.** The server stores passwords as scrypt hashes.
- **Sessions.** A session lasts 30 days. The server keeps only a hash of each token, so the database holds no usable token. Signing out revokes the token.
- **Repeated wrong passwords.** After repeated wrong passwords for one address from one client, the server refuses further attempts for a few minutes. It answers `429` with `Retry-After`.
- **Request limit.** Each person may make `TDE_REQUESTS_PER_MINUTE` requests a minute (600 by default). Above that, the server answers `429` with `Retry-After`.
- **Sign-up.** `TDE_SIGNUP=closed` closes sign-up. The server then refuses new accounts with `SIGNUP_CLOSED`.
- **Email addresses are not verified.** An invitation to a project or workspace reaches whoever registers that address. Close sign-up on any instance that strangers can reach.
- **HTTPS.** Put the server behind HTTPS before other machines can reach it, and set `TDE_SECURE_COOKIES=1`.
- **Privacy.** The code includes no analytics SDK, usage counters or tracking cookies. Your tasks are stored on your server. The app loads profile pictures from a fixed external address set in `src/domain/colors.ts`, and demo mode loads a few images from Unsplash.

## Architecture and data storage

Your data lives on the server. The database is one SQLite file, `DATA_DIR/enhanced.db`. Files people attach to comments go in `DATA_DIR/files`. Back both up together. For the database, `sqlite3 enhanced.db ".backup backup.db"` takes a consistent copy while the server runs.

The server provides:

- **Sync.** The app's sync endpoint takes commands and returns what changed since a token. Commands are idempotent. Each token belongs to one account, and the server refuses a write sent for another account.
- **Sharing.** Owners share projects and workspaces by invitation. The roles are owner, admin, member and guest. Folders group projects.
- **Reminders, activity and insights.** The server stores reminders. It computes the activity log, insights and productivity figures from your tasks. You can export and import projects as CSV.
- **REST API v1.** The official Todoist SDK and the official Todoist MCP call these routes. They cover tasks, projects, sections, labels, comments, filters, folders, workspaces, reminders, activity, templates, productivity and insights.

The code is laid out as:

- `server/` is a Node HTTP server that uses SQLite through better-sqlite3. `server/app.ts` lists every endpoint. The sync endpoint, `POST /api/v1/sync`, takes commands and returns what changed since a token, and the app uses that to keep its copy current. The REST reads cover history, comments, filters, folders and workspaces.
- `server/schema.ts` keeps the database schema as numbered migrations. An installed database is upgraded, never rebuilt.
- `src/` is the React app. Its rules live in `src/domain`, which the server also uses for repeat rules and ordering.

On the device, the app keeps the session token and an offline copy of your tasks in the browser's IndexedDB. It works without a connection and sends its changes when the connection returns.

## Backups and recovery

Back up with SQLite's own `.backup` while the server runs, then copy the uploaded files. Copy the database first, so every file it refers to is in the copy. To restore, stop the server, remove the old `-wal` and `-shm` files, and put the database and the files back. The commands are in [docs/deploying.md](docs/deploying.md#backups).

The backup suite runs that procedure while the server keeps writing, then starts a fresh server on the copy. It checks four things. The database passes an integrity check. Every acknowledged task, account, comment and uploaded file is back. Accounts stay separate. The restored server still reads and writes through the official MCP.

## Development and testing

### Running it in development

    npm run server         # the API, on :8787, restarted on change
    npm run dev            # the app, on :5173, with /api sent to the server

### Test suites

    npm test                                        # unit tests of the app and the server
    npm run e2e                                     # the demo journeys in a browser
    npx playwright test -c playwright.server.config.ts   # journeys on the real server, on a new database
    npm run test:mcp                                # the official MCP and the backup procedure, on the built server (Node 24, sqlite3 installed)

The real-server journeys create every account through the screens. They add and complete tasks, go offline and back, and share a project between two people. For each result they also check the server itself.

CI runs the unit tests, typecheck, lint and builds on Node 22. It runs the official MCP and backup suite on Node 24, which the MCP server requires. It runs the browser journeys on pull requests.

## Known limitations

These are the known limits and open decisions in the current version.

**Compatibility**

- `get-user-status` is not served. The SDK needs a karma number, but the app hides karma when it is `null`. Karma is not computed. How to handle it is still an open decision.
- The official MCP suite does not cover comments, reminders, folders, workspaces, or most label and section writes.
- The server reports a ceiling of 1,000 personal projects, so the official clients accept new projects. The server does not enforce that limit itself.
- A sync request that names no resource types gets no resource data. The app always names its types.
- `GET /api/v1/sections` still lists archived sections, while the section search does not, so the two disagree.
- The SDK sends template requests to `/api/v1.6/`, which this server does not serve. CSV import and export under `/api/v1/` work.
- Project and section `url` fields point to `todoist.com` app pages, not to pages on this server.

**Data and operations**

- A restore revives the sessions in the backup, including any signed out after it, until they expire.
- Each page of a label or section search sorts every match, because no index covers their order. Measured: about 3 ms a page with 1,000 candidates per table, and 33 ms with 10,000. Indexes and keyset paging are planned only if larger measurements justify them.
- The server runs as one process on one database file. That suits one person or a small team. It does not scale horizontally.
- Email addresses are not verified, so an invitation reaches whoever registers the address. Close sign-up on any instance that strangers can reach.

**Features**

- Reminders are stored, not delivered. Location reminders are served by REST, but the sync read does not include them.
- The activity log is not pruned.
- Attachments cannot be viewed through the SDK's `viewAttachment`, which fetches only from Todoist's own hosts.
- Templates are CSV import and export only.
- Health is a fixed rule over overdue and open tasks, not Todoist's analysis.
- CSV priority uses the API's values, where 4 is the highest.
- A guest who owns a project may take it out of its workspace. The folder stays with the workspace. That is the owner's decision.
- A reorder can be refused for a sibling that another device has removed, until the next sync corrects the order.
- Name search ignores case and also folds the Greek final sigma and the German sharp s. It is not full Unicode case folding.

## Acknowledgments and license

This fork is built on **Enhanced for Todoist** by Jules-Valentin Bertolino. The front end, its planning features and its design are that project's work. The original repository is [julesvbertolino/todoist-enhanced](https://github.com/julesvbertolino/todoist-enhanced). Its Mac app is a separate project that has not been tested against this server, so this README does not link to it. The app's About section links to the original project's repository, to the developer's donation page and to the developer's social accounts. Each is labelled as the original developer's. Donations go to the developer, not to this fork. `CHANGELOG.md` records the original project's releases up to the version this fork started from.

Enhanced for Todoist is an independent project. **It is not created by, affiliated with, or supported by Todoist Inc.** It is not an official Todoist product and carries no endorsement. "Todoist" is a trademark of Todoist Inc. The name describes the planning workflow the app was first built around. The app no longer connects to Todoist.

It is provided as is, with no warranty.

The project is released under the [MIT License](LICENSE). The copyright line in that file names the original author. No support is promised for this fork.
