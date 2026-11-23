import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetIdbMemory } from '@/test/idbMemory';

vi.mock('@/db/idb', async () => (await import('@/test/idbMemory')).idbMemory());
vi.mock('@/api/commands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/commands')>()),
  sendCommands: vi.fn(),
}));

import { sendCommands, type Command, type CommandResult } from '@/api/commands';
import { emptySnapshot, type Project } from '@/domain/types';
import { useStore } from './store';

const sent = vi.mocked(sendCommands);

const project = (id: string, child_order: number): Project => ({
  id, name: id, color: 'charcoal', parent_id: null, child_order, order_key: null,
  is_archived: false, is_deleted: false, is_favorite: false,
} as unknown as Project);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', { onLine: true });
  vi.clearAllMocks();
  resetIdbMemory();
  const snapshot = emptySnapshot();
  snapshot.projects.P1 = project('P1', 1);
  snapshot.projects.P2 = project('P2', 2);
  useStore.setState({
    demo: false, snapshot, toasts: [], undoStack: [], pendingCount: 0, syncState: 'idle',
    prefs: { ...useStore.getState().prefs, locale: 'en' },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const accepted = (commands: Command[]): CommandResult => ({
  responses: [], failures: [], mapping: {}, delivered: commands.map((cmd) => cmd.uuid), undelivered: [],
});

describe('adding a project below a sibling that has no key yet', () => {
  it('gives the new project a key between its neighbours, and every sibling a key, in one batch', async () => {
    sent.mockImplementation(async (_token, commands) => accepted(commands));

    await useStore.getState().createProject('New', 'charcoal', null, { siblingId: 'P1', position: 'below' }, {});

    expect(sent).toHaveBeenCalledTimes(1);
    const commands = sent.mock.calls[0][1];
    expect(commands.map((cmd) => cmd.type)).toEqual(['project_add', 'project_reorder']);
    const added = commands[0].args as { child_order: number; order_key: string };
    const reorder = commands[1].args as { projects: Array<{ id: string; child_order: number; order_key: string }> };
    expect(reorder.projects.map((entry) => entry.id)).toEqual(['P1', 'P2']);
    const key = Object.fromEntries(reorder.projects.map((entry) => [entry.id, entry.order_key]));
    expect(key.P1 < added.order_key && added.order_key < key.P2).toBe(true);
    expect(added.child_order).toBe(2);
    expect(reorder.projects.map((entry) => entry.child_order)).toEqual([1, 3]);
  });
});
