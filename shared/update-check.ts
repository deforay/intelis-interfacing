/**
 * Deciding whether there is a newer version, and whether to say so.
 *
 * Kept free of Electron and of Angular so the decision can be tested directly:
 * the main process fetches, the renderer displays, and neither of them owns the
 * rule about what counts as newer.
 */

/** Where the application is published, and the only page it will ever open. */
export const RELEASES_URL = 'https://github.com/deforay/intelis-interfacing/releases/latest';

/** The release feed, read without credentials. */
export const RELEASES_API_URL = 'https://api.github.com/repos/deforay/intelis-interfacing/releases/latest';

export interface AvailableRelease {
  /** Version without a leading v, e.g. "4.3.0" */
  version: string;
}

/**
 * Splits a version into comparable parts. A pre-release suffix is kept apart
 * so that 4.3.0-beta.1 sorts before 4.3.0.
 */
function parseVersion(version: string): { numbers: number[]; preRelease: string } | null {
  const cleaned = (version ?? '').trim().replace(/^v/i, '');
  const match = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/.exec(cleaned);
  if (!match) {
    return null;
  }
  return {
    numbers: match[1].split('.').map(Number),
    preRelease: match[2] ?? ''
  };
}

/**
 * Compares two versions numerically, segment by segment, so 4.10.0 is newer
 * than 4.9.0 rather than sorting before it as text would. A version with a
 * pre-release suffix is older than the same version without one.
 * @returns negative when a is older, positive when a is newer, 0 when equal
 * @throws never — an unparseable version compares as equal, so nothing is
 *   announced on the strength of a string nobody can read
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    return 0;
  }

  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < length; index++) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }

  if (left.preRelease === right.preRelease) {
    return 0;
  }
  // 4.3.0 is newer than 4.3.0-rc.1; between two pre-releases, order them as text.
  if (!left.preRelease) return 1;
  if (!right.preRelease) return -1;
  return left.preRelease < right.preRelease ? -1 : 1;
}

export interface NudgeInputs {
  /** The version running now */
  currentVersion: string;
  /** What the release feed says is current, if anything */
  publishedVersion?: string | null;
  /** The version the operator has already been told about and dismissed */
  dismissedVersion?: string | null;
}

/**
 * Decides what, if anything, to put in front of the operator.
 *
 * Silence is the default. A version that cannot be read, a source that could
 * not be reached, a release no newer than the one running, or one the operator
 * has already dismissed all produce nothing — a banner that appears when there
 * is nothing to do is a banner people learn to ignore.
 *
 * Dismissal is remembered per version, so dismissing 4.3.0 does not also hide
 * 4.4.0 when it arrives.
 */
export function resolveUpdateNudge(inputs: NudgeInputs): AvailableRelease | null {
  if (!inputs.publishedVersion) {
    return null;
  }

  const version = inputs.publishedVersion.trim().replace(/^v/i, '');
  if (!parseVersion(version) || !parseVersion(inputs.currentVersion)) {
    return null;
  }
  if (compareVersions(version, inputs.currentVersion) <= 0) {
    return null;
  }
  if (inputs.dismissedVersion && compareVersions(version, inputs.dismissedVersion) <= 0) {
    return null;
  }
  return { version };
}

/**
 * Decides whether a different version has been installed under the one that
 * is running, and so needs a restart to take over.
 *
 * Any difference counts, older as well as newer: a laboratory that installs an
 * earlier release on purpose is still running the wrong one until it
 * restarts. A version that cannot be read counts as no difference, so a file
 * read mid-install never prompts anyone.
 */
export function resolveInstalledUpdate(runningVersion: string, installedVersion?: string | null): AvailableRelease | null {
  if (!installedVersion || !parseVersion(installedVersion) || !parseVersion(runningVersion)) {
    return null;
  }
  if (compareVersions(installedVersion, runningVersion) === 0) {
    return null;
  }
  return { version: installedVersion.trim().replace(/^v/i, '') };
}
