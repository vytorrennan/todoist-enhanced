import type { Snapshot } from './types';
import { DEFAULT_MONTH_LABEL, SYSTEM_LABELS, monthLabel } from './types';
export function reservedLabel(name: string, weekLabel: string): boolean {
  const n = name.toLowerCase();
  return n === 'week' || n === weekLabel.toLowerCase() || Object.values(SYSTEM_LABELS).some((v) => v === n) || n === DEFAULT_MONTH_LABEL || n === monthLabel().toLowerCase() || n.startsWith('est-');
}
/** Whether the signed-in person can only read a project's tasks. */
export const readOnlyProject = (snapshot: Snapshot, projectId: string): boolean => snapshot.projects[projectId]?.role === 'READ_ONLY';

export const cleanLabelName = (name: string): string => name.trim().replace(/\s+/g, '-');
export function labelRenameError(snapshot: Snapshot, id: string, name: string, weekLabel: string): 'empty' | 'reserved' | 'duplicate' | null {
  const old = snapshot.labels[id] ?? Object.values(snapshot.labels).find((label) => String(label.id) === String(id));
  const clean = cleanLabelName(name);
  if (!old || old.is_deleted || !clean) return 'empty';
  if (reservedLabel(old.name, weekLabel) || reservedLabel(clean, weekLabel)) return 'reserved';
  const duplicate = Object.entries(snapshot.labels).some(([key, label]) => key !== String(id) && String(label.id) !== String(old.id)
    && !label.is_deleted && cleanLabelName(label.name).toLowerCase() === clean.toLowerCase());
  return duplicate ? 'duplicate' : null;
}
export function validLabelRename(snapshot: Snapshot, id: string, name: string, weekLabel: string): boolean {
  return labelRenameError(snapshot, id, name, weekLabel) === null;
}
export function renamedLabelSnapshot(snapshot: Snapshot, id: string, name: string): Snapshot {
  const label = snapshot.labels[id];
  if (!label) return snapshot;
  // A read-only project keeps its labels: the server leaves them alone too.
  const items = Object.fromEntries(Object.entries(snapshot.items).map(([key, item]) => [key, readOnlyProject(snapshot, item.project_id)
    ? item
    : { ...item, labels: item.labels.map((value) => value.toLowerCase() === label.name.toLowerCase() ? name : value) }]));
  return { ...snapshot, labels: { ...snapshot.labels, [id]: { ...label, name } }, items };
}
