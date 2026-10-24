/**
 * File names OS shells drop into folders (Finder, Explorer). Never part of the skill: the bundle
 * walk skips them so they are not shipped, and the installed-copy walk skips them so they do not
 * turn an untouched install into `modified`.
 */
const IGNORED_FILE_NAMES: Readonly<Record<string, true>> = {
  ".DS_Store": true,
  "Thumbs.db": true,
  "desktop.ini": true,
};

export function isIgnoredFile(name: string): boolean {
  return Object.hasOwn(IGNORED_FILE_NAMES, name);
}
