import type { Db } from './db';
import { ApiFailure } from './db';
import type { UserRow } from './auth';
import { applyDirect } from './commands';
import { requireProject } from './access';
import { readNaturalDate } from '../src/domain/nlp';
import { todayIn } from './dates';

/**
 * Projects as CSV: the same file a project exports and a project imports, so
 * a template made here can be read back here. Each row is one of: a project
 * (its name), a section, a task (indented under its parent), or a comment on
 * the task above it.
 */

const HEADER = ['TYPE', 'CONTENT', 'DESCRIPTION', 'PRIORITY', 'INDENT', 'AUTHOR', 'RESPONSIBLE', 'DATE', 'DATE_LANG', 'TIMEZONE'];

function cell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function line(values: unknown[]): string {
  return values.map(cell).join(',');
}

/** Parses CSV text into rows of cells, honouring quoted cells that hold commas, quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quoted) {
      if (char === '"' && text[at + 1] === '"') { value += '"'; at += 1; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(value); value = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[at + 1] === '\n') at += 1;
      row.push(value); value = '';
      if (row.some((cellValue) => cellValue !== '')) rows.push(row);
      row = [];
    } else {
      value += char;
    }
  }
  row.push(value);
  if (row.some((cellValue) => cellValue !== '')) rows.push(row);
  return rows;
}

interface TaskRow {
  id: string;
  section_id: string | null;
  parent_id: string | null;
  content: string;
  description: string;
  priority: number;
  due_date: string | null;
  due_string: string | null;
  due_lang: string | null;
  due_timezone: string | null;
}

/** The CSV of a project: its sections, then its open tasks under each, with their comments. */
export function projectCsv(db: Db, viewer: UserRow, projectId: string): string {
  requireProject(db, projectId, viewer.id, 'read');
  const project = db.prepare('SELECT name, description FROM projects WHERE id = ?').get(projectId) as { name: string; description: string };
  const out: unknown[][] = [['project', project.name, project.description]];
  const tasks = db.prepare(`SELECT id, section_id, parent_id, content, description, priority, due_date, due_string, due_lang, due_timezone
    FROM items WHERE project_id = ? AND is_deleted = 0 AND checked = 0 ORDER BY child_order`).all(projectId) as TaskRow[];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const depth = (task: TaskRow): number => {
    let level = 1;
    let parent = task.parent_id ? byId.get(task.parent_id) : undefined;
    while (parent && level < 50) { level += 1; parent = parent.parent_id ? byId.get(parent.parent_id) : undefined; }
    return level;
  };
  const sections = db.prepare('SELECT id, name FROM sections WHERE project_id = ? AND is_deleted = 0 AND is_archived = 0 ORDER BY section_order').all(projectId) as Array<{ id: string; name: string }>;
  const emit = (task: TaskRow) => {
    out.push(['task', task.content, task.description, task.priority, depth(task), '', '', task.due_string ?? task.due_date ?? '', task.due_lang ?? '', task.due_timezone ?? '']);
    const notes = db.prepare('SELECT content FROM notes WHERE item_id = ? AND is_deleted = 0 ORDER BY posted_at').all(task.id) as Array<{ content: string }>;
    for (const note of notes) out.push(['note', note.content]);
  };
  // A task, then the tasks under it, each right after its parent.
  const walk = (task: TaskRow) => {
    emit(task);
    for (const child of tasks.filter((other) => other.parent_id === task.id)) walk(child);
  };
  const roots = (section: string | null) => tasks.filter((task) => task.section_id === section && (task.parent_id === null || !byId.has(task.parent_id)));
  for (const task of roots(null)) walk(task);
  for (const section of sections) {
    out.push(['section', section.name]);
    for (const task of roots(section.id)) walk(task);
  }
  return [HEADER, ...out].map(line).join('\n') + '\n';
}

export interface ImportedIds {
  project: string | null;
  sections: string[];
  tasks: string[];
  comments: string[];
}

/** Reads CSV into a project, or into a new one named by its project row. Returns the ids the import made. */
export function importCsv(db: Db, viewer: UserRow, projectId: string | null, text: string): ImportedIds {
  const rows = parseCsv(text);
  const body = rows.length && rows[0][0]?.toUpperCase() === 'TYPE' ? rows.slice(1) : rows;
  const made: ImportedIds = { project: null, sections: [], tasks: [], comments: [] };
  let target = projectId;
  if (!target) {
    const named = body.find((row) => row[0]?.toLowerCase() === 'project');
    const temp = `csv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const temps = applyDirect(db, viewer, 'project_add', { name: (named?.[1] || 'Imported project').slice(0, 120) }, temp);
    target = temps.get(temp) ?? null;
    made.project = target;
  } else {
    requireProject(db, target, viewer.id, 'write');
  }
  if (!target) throw ApiFailure.badRequest('The project could not be made.', 'INVALID_ARGUMENT');
  let section: string | null = null;
  const stack: string[] = [];
  let last: string | null = null;
  for (const row of body) {
    const kind = (row[0] ?? '').toLowerCase();
    if (kind === 'project') continue;
    if (kind === 'section') {
      const temp = `csv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const temps = applyDirect(db, viewer, 'section_add', { name: (row[1] || 'Section').slice(0, 120), project_id: target }, temp);
      section = temps.get(temp) ?? null;
      if (section) made.sections.push(section);
      stack.length = 0; last = null;
    } else if (kind === 'task') {
      const indent = Math.max(1, Math.min(Number(row[4]) || 1, stack.length + 1, 20));
      const parent = indent > 1 ? stack[indent - 2] : null;
      const priority = Math.min(4, Math.max(1, Number(row[3]) || 1));
      const args: Record<string, unknown> = { content: (row[1] || 'Task').slice(0, 500), description: row[2] ?? '', priority, project_id: target };
      if (parent) args.parent_id = parent;
      else if (section) args.section_id = section;
      const due = row[7] ?? '';
      if (/^\d{4}-\d{2}-\d{2}/.test(due)) args.due = { date: due.slice(0, 16), string: due, lang: row[8] || 'en' };
      else if (due) {
        const reading = readNaturalDate(due, new Date(`${todayIn(viewer.timezone)}T12:00:00`), { locale: 'en' });
        if (reading) args.due = { date: reading.date, string: due, lang: 'en' };
      }
      const temp = `csv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const temps = applyDirect(db, viewer, 'item_add', args, temp);
      const task = temps.get(temp);
      if (task) {
        made.tasks.push(task);
        stack.length = indent - 1;
        stack[indent - 1] = task;
        last = task;
      }
    } else if (kind === 'note' && last) {
      const temp = `csv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const temps = applyDirect(db, viewer, 'note_add', { item_id: last, content: row[1] ?? '' }, temp);
      const note = temps.get(temp);
      if (note) made.comments.push(note);
    }
  }
  return made;
}
