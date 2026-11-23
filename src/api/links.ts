/**
 * Links to things in this app, and putting them on the clipboard.
 *
 * A link is the address of this copy of the app with a route in the hash, so
 * it opens the same place wherever the app is served. Copying and the menus
 * that copy build their links here, so they cannot drift apart.
 */

/** The address of this copy of the app, without anything after the hash. */
const appAddress = (): string => {
  const { origin, pathname } = globalThis.location ?? { origin: '', pathname: '/' };
  return `${origin}${pathname}`;
};

/** A task, opened from its project's page. */
export const taskLink = (projectId: string, taskId: string): string =>
  `${appAddress()}#/project/${encodeURIComponent(projectId)}?task=${encodeURIComponent(taskId)}`;

export const projectLink = (projectId: string): string => `${appAddress()}#/project/${encodeURIComponent(projectId)}`;

export const sectionLink = (projectId: string, sectionId: string): string =>
  `${appAddress()}#/project/${encodeURIComponent(projectId)}?section=${encodeURIComponent(sectionId)}`;

/** Labels are opened by name, which is what the route reads. */
export const labelLink = (name: string): string => `${appAddress()}#/label/${encodeURIComponent(name)}`;

export const filterLink = (filterId: string): string => `${appAddress()}#/filter/${encodeURIComponent(filterId)}`;

/**
 * An id the app made up while the server had not answered yet (see `newUuid`).
 * A server id has no dashes, and a made-up one has no page to link to.
 */
export const isTemporaryId = (id: string): boolean => id.includes('-');

/** Copies text, and says whether it worked: the clipboard can be refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies text that is still on its way, such as an answer from the server.
 *
 * Safari only lets a page write to the clipboard during the click that asked
 * for it, and a network request outlasts the click. Handing the clipboard the
 * pending text at once keeps the write inside the click; where that form is
 * missing, the text is awaited and copied the ordinary way.
 */
export async function copyPending(text: Promise<string>): Promise<boolean> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      const blob = text.then((value) => new Blob([value], { type: 'text/plain' }));
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      return true;
    } catch {
      /* fall through: some browsers refuse a pending item */
    }
  }
  try {
    return await copyText(await text);
  } catch {
    return false;
  }
}
