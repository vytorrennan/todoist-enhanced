import { useMemo, useState, type FormEvent } from 'react';
import { useT } from '@/hooks/useT';
import { useStore } from '@/store/store';
import type { Folder, Workspace } from '@/domain/types';

/**
 * Workspaces, in Settings: making one, inviting people to it, and the folders
 * its projects are grouped in. Projects are shared by the people in a
 * workspace; the sidebar and the pages read them from the same place.
 */
export function WorkspaceSettings() {
  const { t } = useT();
  /* The store is read as stored, and the list made from it here: a selector
     that returns a fresh array would render again on every change. */
  const stored = useStore((s) => s.snapshot.workspaces);
  const workspaces = useMemo(() => Object.values(stored)
    .filter((workspace) => !workspace.is_deleted && !workspace.is_archived)
    .sort((a, b) => a.name.localeCompare(b.name)), [stored]);
  const createWorkspace = useStore((s) => s.createWorkspace);
  const [name, setName] = useState('');

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    await createWorkspace(name);
    setName('');
  };

  return (
    <div className="setfcard wsettings">
      <form className="wsrow" onSubmit={create}>
        <label className="sr" htmlFor="workspace-name">{t('workspace.name')}</label>
        <input id="workspace-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('workspace.name')} />
        <button type="submit" className="btn" disabled={!name.trim()}>{t('workspace.create')}</button>
      </form>
      {workspaces.length === 0 && <p className="setgroup-hint">{t('workspace.none')}</p>}
      {workspaces.map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} />)}
      <p className="setgroup-hint">{t('workspace.hint')}</p>
    </div>
  );
}

function WorkspaceRow({ workspace }: { workspace: Workspace }) {
  const { t } = useT();
  const storedFolders = useStore((s) => s.snapshot.folders);
  const folders = useMemo(() => Object.values(storedFolders ?? {})
    .filter((folder: Folder) => folder.workspace_id === workspace.id && !folder.is_deleted)
    .sort((a, b) => a.child_order - b.child_order || a.name.localeCompare(b.name)), [storedFolders, workspace.id]);
  const inviteToWorkspace = useStore((s) => s.inviteToWorkspace);
  const createFolder = useStore((s) => s.createFolder);
  const [email, setEmail] = useState('');
  const [folder, setFolder] = useState('');

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim()) return;
    await inviteToWorkspace(workspace.id, email);
    setEmail('');
  };
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!folder.trim()) return;
    await createFolder(workspace.id, folder);
    setFolder('');
  };

  // Only an admin of the workspace may invite people or add folders; the server refuses the rest.
  const admin = workspace.role === 'ADMIN';
  return (
    <div className="wsworkspace">
      <h3 className="setsubhead">{workspace.name}</h3>
      {admin && (
        <form className="wsrow" onSubmit={invite}>
          <label className="sr" htmlFor={`invite-${workspace.id}`}>{t('workspace.invitePlaceholder')}</label>
          <input id={`invite-${workspace.id}`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('workspace.invitePlaceholder')} />
          <button type="submit" className="btn" disabled={!email.trim()}>{t('workspace.invite')}</button>
        </form>
      )}
      <h4 className="wssubhead">{t('workspace.folders')}</h4>
      {folders.length === 0 && <p className="setgroup-hint">{t('workspace.noFolders')}</p>}
      {folders.length > 0 && (
        <ul className="wsfolders">
          {folders.map((entry) => <li key={entry.id}>{entry.name}</li>)}
        </ul>
      )}
      {admin && (
        <form className="wsrow" onSubmit={add}>
          <label className="sr" htmlFor={`folder-${workspace.id}`}>{t('workspace.folderPlaceholder')}</label>
          <input id={`folder-${workspace.id}`} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={t('workspace.folderPlaceholder')} />
          <button type="submit" className="btn" disabled={!folder.trim()}>{t('workspace.addFolder')}</button>
        </form>
      )}
    </div>
  );
}
