import { describe, expect, test } from 'bun:test';

import { addAppTabPressListener, notifyAppTabPress } from './app-tab-events';

describe('app tab events', () => {
  test('notifies active listeners and unsubscribes cleanly', () => {
    const names: string[] = [];
    const remove = addAppTabPressListener((event) => {
      names.push(event.name);
    });

    notifyAppTabPress('(camera)');
    remove();
    notifyAppTabPress('(demo)');

    expect(names).toEqual(['(camera)']);
  });
});
