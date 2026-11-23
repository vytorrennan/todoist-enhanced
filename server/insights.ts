import type { Db } from './db';
import type { UserRow } from './auth';
import { visibleSql } from './access';
import { addDays, todayIn } from './dates';
import type { ItemRow } from './serialize';

/**
 * Progress, health, activity and productivity, worked out from the tasks and
 * the activity log. Health is a fixed rule over overdue and open tasks, so the
 * same data always gives the same answer; Todoist's own health analysis is a
 * generated summary this server does not have.
 */

const WEEK = 7;

interface Counts { completed: number; active: number; overdue: number }

function countsOf(db: Db, viewer: UserRow, projectId: string): Counts {
  const today = todayIn(viewer.timezone);
  const row = db.prepare(`SELECT
      SUM(CASE WHEN checked = 1 THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN checked = 0 THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN checked = 0 AND due_date IS NOT NULL AND substr(due_date, 1, 10) < @today THEN 1 ELSE 0 END) AS overdue
    FROM items WHERE project_id = @project AND is_deleted = 0`).get({ project: projectId, today }) as
    { completed: number | null; active: number | null; overdue: number | null };
  return { completed: row.completed ?? 0, active: row.active ?? 0, overdue: row.overdue ?? 0 };
}

export function progressOf(db: Db, viewer: UserRow, projectId: string) {
  const counts = countsOf(db, viewer, projectId);
  const total = counts.completed + counts.active;
  return {
    project_id: projectId,
    completed_count: counts.completed,
    active_count: counts.active,
    progress_percent: total === 0 ? 0 : Math.round((counts.completed / total) * 100),
  };
}

export function healthOf(db: Db, viewer: UserRow, projectId: string, now = new Date()) {
  const counts = countsOf(db, viewer, projectId);
  const total = counts.completed + counts.active;
  let status: 'UNKNOWN' | 'EXCELLENT' | 'ON_TRACK' | 'AT_RISK' | 'CRITICAL';
  if (total === 0) status = 'UNKNOWN';
  else if (counts.overdue === 0 && counts.active === 0) status = 'EXCELLENT';
  else if (counts.overdue === 0) status = 'ON_TRACK';
  else if (counts.overdue * 2 >= counts.active) status = 'CRITICAL';
  else status = 'AT_RISK';
  const description = total === 0
    ? 'No tasks yet.'
    : `${counts.overdue} of ${counts.active} open tasks are overdue; ${counts.completed} are done.`;
  return {
    status,
    description,
    description_summary: description,
    project_id: projectId,
    updated_at: now.toISOString(),
    is_stale: false,
    update_in_progress: false,
  };
}

/** Days from `today` back, oldest first: the last seven days, inclusive of today. */
function lastDays(today: string): string[] {
  return Array.from({ length: WEEK }, (_, at) => addDays(today, at - (WEEK - 1)));
}

export function activityStatsOf(db: Db, viewer: UserRow, projectId: string) {
  const today = todayIn(viewer.timezone);
  const days = lastDays(today);
  const rows = db.prepare(`SELECT substr(event_date, 1, 10) AS day, COUNT(*) AS n FROM activity_events
    WHERE parent_project_id = @project AND object_type = 'item' AND event_type = 'completed' AND substr(event_date, 1, 10) >= @from
    GROUP BY day`).all({ project: projectId, from: days[0] }) as Array<{ day: string; n: number }>;
  const counted = new Map(rows.map((row) => [row.day, row.n]));
  return {
    day_items: days.map((date) => ({ date, total_count: counted.get(date) ?? 0 })),
    week_items: null,
  };
}

export function workspaceInsightsOf(db: Db, viewer: UserRow, workspaceId: string) {
  const projects = db.prepare(`SELECT p.id FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = @viewer AND m.state = 'active'
    WHERE p.workspace_id = @workspace AND p.is_deleted = 0 AND p.is_archived = 0 ORDER BY m.child_order`)
    .all({ viewer: viewer.id, workspace: workspaceId }) as Array<{ id: string }>;
  return {
    project_insights: projects.map(({ id }) => ({
      project_id: id,
      health: healthOf(db, viewer, id),
      progress: progressOf(db, viewer, id),
    })),
  };
}

/** Completed tasks per day, the streak of days with any, and what was finished, for the last seven days. */
export function productivityOf(db: Db, viewer: UserRow) {
  const today = todayIn(viewer.timezone);
  const days = lastDays(today);
  const completed = db.prepare(`SELECT i.* FROM items i WHERE i.checked = 1 AND i.is_deleted = 0 AND ${visibleSql('i.project_id')}
    AND i.completed_at IS NOT NULL ORDER BY i.completed_at DESC`).all({ viewer: viewer.id }) as ItemRow[];
  const byDay = new Map<string, ItemRow[]>();
  for (const row of completed) {
    const day = (row.completed_at ?? '').slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), row]);
  }
  const streak = streakOf(new Set(byDay.keys()), today);
  return {
    completed_count: completed.length,
    days_items: days.map((date) => {
      const items = byDay.get(date) ?? [];
      return { date, items: items.map((row) => ({ id: row.id, completed: 1 })), total_completed: items.length };
    }),
    goals: {
      current_daily_streak: streak.current,
      current_weekly_streak: { count: 0, start: '', end: '' },
      daily_goal: 0,
      ignore_days: [],
      karma_disabled: 1,
      last_daily_streak: streak.last,
      last_weekly_streak: { count: 0, start: '', end: '' },
      max_daily_streak: streak.max,
      max_weekly_streak: { count: 0, start: '', end: '' },
      user: viewer.full_name,
      user_id: viewer.id,
      vacation_mode: 0,
      weekly_goal: 0,
    },
    karma: 0,
    karma_graph_data: [],
    karma_last_update: 0,
    karma_trend: 'stable',
    karma_update_reasons: [],
    project_colors: Object.fromEntries((db.prepare('SELECT id, color FROM projects WHERE is_deleted = 0').all() as Array<{ id: string; color: string }>).map((row) => [row.id, row.color])),
    week_items: [{ from: days[0], to: days[days.length - 1], items: [], total_completed: days.reduce((sum, day) => sum + (byDay.get(day)?.length ?? 0), 0) }],
  };
}

/** The current run of days with completions (ending today or yesterday), and the longest one. */
function streakOf(done: Set<string>, today: string) {
  const runs: Array<{ count: number; start: string; end: string }> = [];
  let run: { count: number; start: string; end: string } | null = null;
  const sorted = [...done].sort();
  for (const day of sorted) {
    if (run && addDays(run.end, 1) === day) {
      run.count += 1;
      run.end = day;
    } else {
      run = { count: 1, start: day, end: day };
      runs.push(run);
    }
  }
  const max = runs.reduce<{ count: number; start: string; end: string }>((best, r) => (r.count > best.count ? r : best), { count: 0, start: '', end: '' });
  const last = runs.length ? runs[runs.length - 1] : { count: 0, start: '', end: '' };
  const current = last.end === today || last.end === addDays(today, -1) ? last : { count: 0, start: '', end: '' };
  return { current, last, max };
}

