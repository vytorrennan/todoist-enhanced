import { describe, expect, it } from 'vitest';
import { filterLink, isTemporaryId, labelLink, projectLink, sectionLink, taskLink } from './links';

/** The app's own addresses: this copy's origin and path, then a route in the hash. */
describe('links to this app', () => {
  it('a task opens on its project’s page, with the task in the query', () => {
    const link = taskLink('proj1', 'task1');
    expect(link.split('#')[1]).toBe('/project/proj1?task=task1');
  });

  it('a project, a section, a label and a filter each have a route the app already reads', () => {
    expect(projectLink('p').split('#')[1]).toBe('/project/p');
    expect(sectionLink('p', 's').split('#')[1]).toBe('/project/p?section=s');
    expect(labelLink('🏠 Home').split('#')[1]).toBe('/label/%F0%9F%8F%A0%20Home');
    expect(filterLink('f').split('#')[1]).toBe('/filter/f');
  });

  it('a link is to this page, not to any other site', () => {
    const origin = globalThis.location?.origin ?? '';
    expect(taskLink('a', 'b').startsWith(origin)).toBe(true);
    expect(taskLink('a', 'b')).not.toContain('todoist');
  });

  it('an id the app made up while offline has no page: it has dashes, a server id has none', () => {
    expect(isTemporaryId('0f8e7a2c-1111-4222-8333-444455556666')).toBe(true);
    expect(isTemporaryId('0f8e7a2c111142228333444455556666')).toBe(false);
  });
});
