/**
 * The database, as a list of migrations.
 *
 * `PRAGMA user_version` says how many have run. A migration is only ever added
 * to the end of the list: an installed database is upgraded, never rebuilt.
 *
 * Every row that the sync protocol can send carries a `seq`: the global change
 * counter (`meta.seq`) at the time it last changed. A sync asks for everything
 * with `seq` greater than the token it was given, which is how incremental
 * reads stay cheap without a per-user change log.
 */
export const MIGRATIONS: readonly string[] = [
  /* 1 — the first schema. */
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
  INSERT INTO meta (key, value) VALUES ('seq', 0);

  CREATE TABLE users (
    id                        TEXT PRIMARY KEY,
    email                     TEXT NOT NULL UNIQUE COLLATE NOCASE,
    full_name                 TEXT NOT NULL DEFAULT '',
    password_hash             TEXT NOT NULL,
    inbox_project_id          TEXT,
    timezone                  TEXT NOT NULL DEFAULT 'UTC',
    lang                      TEXT NOT NULL DEFAULT 'en',
    start_day                 INTEGER NOT NULL DEFAULT 1,
    reset_recurring_subtasks  INTEGER NOT NULL DEFAULT 0,
    image_id                  TEXT,
    access_seq                INTEGER NOT NULL DEFAULT 0,
    created_at                TEXT NOT NULL,
    seq                       INTEGER NOT NULL
  );
  CREATE INDEX users_seq ON users (seq);

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions (user_id);

  CREATE TABLE workspaces (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    default_access_level  TEXT NOT NULL DEFAULT 'team',
    created_by            TEXT NOT NULL REFERENCES users (id),
    created_at            TEXT NOT NULL,
    is_archived           INTEGER NOT NULL DEFAULT 0,
    is_deleted            INTEGER NOT NULL DEFAULT 0,
    seq                   INTEGER NOT NULL
  );
  CREATE INDEX workspaces_seq ON workspaces (seq);

  CREATE TABLE workspace_members (
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role         TEXT NOT NULL,
    joined_at    TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE INDEX workspace_members_user ON workspace_members (user_id);
  CREATE INDEX workspace_members_seq ON workspace_members (seq);

  CREATE TABLE folders (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    child_order  INTEGER NOT NULL DEFAULT 0,
    is_deleted   INTEGER NOT NULL DEFAULT 0,
    created_by   TEXT NOT NULL REFERENCES users (id),
    seq          INTEGER NOT NULL
  );
  CREATE INDEX folders_workspace ON folders (workspace_id);
  CREATE INDEX folders_seq ON folders (seq);

  CREATE TABLE projects (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    description        TEXT NOT NULL DEFAULT '',
    color              TEXT NOT NULL DEFAULT 'charcoal',
    parent_id          TEXT,
    workspace_id       TEXT REFERENCES workspaces (id) ON DELETE SET NULL,
    folder_id          TEXT REFERENCES folders (id) ON DELETE SET NULL,
    view_style         TEXT NOT NULL DEFAULT 'list',
    is_inbox           INTEGER NOT NULL DEFAULT 0,
    is_archived        INTEGER NOT NULL DEFAULT 0,
    archived_at        TEXT,
    is_deleted         INTEGER NOT NULL DEFAULT 0,
    access_visibility  TEXT NOT NULL DEFAULT 'restricted',
    created_by         TEXT NOT NULL REFERENCES users (id),
    created_at         TEXT NOT NULL,
    seq                INTEGER NOT NULL
  );
  CREATE INDEX projects_seq ON projects (seq);
  CREATE INDEX projects_parent ON projects (parent_id);

  /* Everything a person has about a project: their role, their place in
     their own sidebar, whether they have accepted it. A removed membership
     stays as a row, so the people list can tell the other members it went. */
  CREATE TABLE project_members (
    project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role        TEXT NOT NULL,
    state       TEXT NOT NULL DEFAULT 'active',
    is_favorite INTEGER NOT NULL DEFAULT 0,
    collapsed   INTEGER NOT NULL DEFAULT 0,
    child_order INTEGER NOT NULL DEFAULT 0,
    order_key   TEXT,
    /* "direct": the owner chose this person. "workspace": it follows the team of a team project, and goes with it. */
    via         TEXT NOT NULL DEFAULT 'direct',
    joined_at   TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    PRIMARY KEY (project_id, user_id)
  );
  CREATE INDEX project_members_user ON project_members (user_id);
  CREATE INDEX project_members_seq ON project_members (seq);

  CREATE TABLE sections (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    section_order INTEGER NOT NULL DEFAULT 0,
    order_key    TEXT,
    is_archived  INTEGER NOT NULL DEFAULT 0,
    archived_at  TEXT,
    is_deleted   INTEGER NOT NULL DEFAULT 0,
    collapsed    INTEGER NOT NULL DEFAULT 0,
    created_by   TEXT NOT NULL REFERENCES users (id),
    created_at   TEXT NOT NULL,
    seq          INTEGER NOT NULL
  );
  CREATE INDEX sections_project ON sections (project_id);
  CREATE INDEX sections_seq ON sections (seq);

  CREATE TABLE items (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    section_id      TEXT REFERENCES sections (id) ON DELETE SET NULL,
    parent_id       TEXT REFERENCES items (id) ON DELETE CASCADE,
    content         TEXT NOT NULL DEFAULT '',
    description     TEXT NOT NULL DEFAULT '',
    priority        INTEGER NOT NULL DEFAULT 1,
    due_date        TEXT,
    due_string      TEXT,
    due_lang        TEXT,
    due_timezone    TEXT,
    due_recurring   INTEGER NOT NULL DEFAULT 0,
    deadline_date   TEXT,
    deadline_lang   TEXT,
    duration_amount INTEGER,
    duration_unit   TEXT,
    labels          TEXT NOT NULL DEFAULT '[]',
    child_order     INTEGER NOT NULL DEFAULT 0,
    order_key       TEXT,
    day_order       INTEGER NOT NULL DEFAULT -1,
    collapsed       INTEGER NOT NULL DEFAULT 0,
    checked         INTEGER NOT NULL DEFAULT 0,
    completed_at    TEXT,
    is_deleted      INTEGER NOT NULL DEFAULT 0,
    added_by        TEXT REFERENCES users (id),
    added_at        TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    responsible_uid TEXT REFERENCES users (id) ON DELETE SET NULL,
    seq             INTEGER NOT NULL
  );
  CREATE INDEX items_project ON items (project_id);
  CREATE INDEX items_parent ON items (parent_id);
  CREATE INDEX items_seq ON items (seq);

  CREATE TABLE notes (
    id              TEXT PRIMARY KEY,
    item_id         TEXT REFERENCES items (id) ON DELETE CASCADE,
    project_id      TEXT REFERENCES projects (id) ON DELETE CASCADE,
    content         TEXT NOT NULL DEFAULT '',
    posted_at       TEXT NOT NULL,
    posted_by       TEXT NOT NULL REFERENCES users (id),
    is_deleted      INTEGER NOT NULL DEFAULT 0,
    file_attachment TEXT,
    seq             INTEGER NOT NULL
  );
  CREATE INDEX notes_item ON notes (item_id);
  CREATE INDEX notes_project ON notes (project_id);
  CREATE INDEX notes_seq ON notes (seq);

  CREATE TABLE note_reactions (
    note_id    TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (note_id, user_id, emoji)
  );

  CREATE TABLE labels (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT 'charcoal',
    item_order  INTEGER NOT NULL DEFAULT 0,
    order_key   TEXT,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    is_deleted  INTEGER NOT NULL DEFAULT 0,
    seq         INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX labels_name ON labels (user_id, name COLLATE NOCASE) WHERE is_deleted = 0;
  CREATE INDEX labels_seq ON labels (seq);

  CREATE TABLE filters (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    query       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT 'charcoal',
    item_order  INTEGER NOT NULL DEFAULT 0,
    order_key   TEXT,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    is_deleted  INTEGER NOT NULL DEFAULT 0,
    seq         INTEGER NOT NULL
  );
  CREATE INDEX filters_seq ON filters (seq);

  /* The completion history: one row per completion. A recurring task adds a
     row each time it is closed; an ordinary one has a row until it is reopened. */
  CREATE TABLE completions (
    id              TEXT PRIMARY KEY,
    item_id         TEXT NOT NULL,
    user_id         TEXT NOT NULL REFERENCES users (id),
    project_id      TEXT NOT NULL,
    section_id      TEXT,
    content         TEXT NOT NULL,
    completed_at    TEXT NOT NULL,
    recurring       INTEGER NOT NULL DEFAULT 0,
    labels          TEXT NOT NULL DEFAULT '[]',
    duration_amount INTEGER,
    duration_unit   TEXT,
    priority        INTEGER NOT NULL DEFAULT 1,
    responsible_uid TEXT,
    parent_id       TEXT
  );
  CREATE INDEX completions_user_time ON completions (user_id, completed_at);
  CREATE INDEX completions_item ON completions (item_id);
  CREATE INDEX completions_project ON completions (project_id);

  CREATE TABLE invitations (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    project_id   TEXT REFERENCES projects (id) ON DELETE CASCADE,
    workspace_id TEXT REFERENCES workspaces (id) ON DELETE CASCADE,
    email        TEXT NOT NULL COLLATE NOCASE,
    user_id      TEXT REFERENCES users (id) ON DELETE CASCADE,
    invited_by   TEXT NOT NULL REFERENCES users (id),
    role         TEXT NOT NULL,
    secret       TEXT NOT NULL,
    state        TEXT NOT NULL DEFAULT 'pending',
    created_at   TEXT NOT NULL,
    responded_at TEXT
  );
  CREATE INDEX invitations_email ON invitations (email);
  CREATE INDEX invitations_user ON invitations (user_id);

  CREATE TABLE notifications (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    type       TEXT NOT NULL,
    data       TEXT NOT NULL DEFAULT '{}',
    is_unread  INTEGER NOT NULL DEFAULT 1,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    seq        INTEGER NOT NULL
  );
  CREATE INDEX notifications_user ON notifications (user_id, seq);

  CREATE TABLE files (
    id           TEXT PRIMARY KEY,
    owner_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    file_name    TEXT NOT NULL,
    file_type    TEXT NOT NULL,
    file_size    INTEGER NOT NULL,
    storage_name TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );

  /* Every command the server has answered, by its uuid. A retry of a command
     that already went through gets the same answer back and changes nothing. */
  CREATE TABLE processed_commands (
    user_id     TEXT NOT NULL,
    uuid        TEXT NOT NULL,
    status      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (user_id, uuid)
  );
  CREATE INDEX processed_commands_time ON processed_commands (created_at);
  `,
  // Reminders on tasks: an absolute one at a due, a relative one a number of minutes before the task's due, and a
  // location one. Delivery is the client's concern; the server keeps what was set, as the API does.
  `
  CREATE TABLE reminders (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users (id),
    item_id      TEXT NOT NULL REFERENCES items (id),
    type         TEXT NOT NULL CHECK (type IN ('absolute', 'relative')),
    minute_offset INTEGER,
    due          TEXT,
    notify_uid   TEXT NOT NULL,
    service      TEXT,
    is_urgent    INTEGER NOT NULL DEFAULT 0,
    is_deleted   INTEGER NOT NULL DEFAULT 0,
    seq          INTEGER NOT NULL
  );
  CREATE INDEX reminders_item ON reminders (item_id);
  CREATE INDEX reminders_seq ON reminders (seq);
  CREATE TABLE location_reminders (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users (id),
    item_id      TEXT NOT NULL REFERENCES items (id),
    name         TEXT NOT NULL,
    loc_lat      TEXT NOT NULL,
    loc_long     TEXT NOT NULL,
    loc_trigger  TEXT NOT NULL CHECK (loc_trigger IN ('on_enter', 'on_leave')),
    radius       INTEGER NOT NULL,
    notify_uid   TEXT NOT NULL,
    is_deleted   INTEGER NOT NULL DEFAULT 0,
    seq          INTEGER NOT NULL
  );
  CREATE INDEX location_reminders_item ON location_reminders (item_id);
  CREATE INDEX location_reminders_seq ON location_reminders (seq);
  `,
  // The activity log: what changed, on what, by whom. An event belongs to the project it happened in, or to its
  // initiator alone when it has no project (labels, filters).
  `
  CREATE TABLE activity_events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           TEXT NOT NULL REFERENCES users (id),
    object_type       TEXT NOT NULL,
    object_id         TEXT NOT NULL,
    event_type        TEXT NOT NULL,
    event_date        TEXT NOT NULL,
    parent_project_id TEXT,
    parent_item_id    TEXT,
    extra_data        TEXT
  );
  CREATE INDEX activity_events_project ON activity_events (parent_project_id, id);
  CREATE INDEX activity_events_user ON activity_events (user_id, id);
  `,
];
