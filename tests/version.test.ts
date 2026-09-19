import { describe, expect, it } from 'vitest';
import { isNewerVersion } from '../src/main/update-checker';

/**
 * Test 1 — version comparison (update-checker.ts isNewerVersion).
 * Assertions encode the CURRENT implementation behaviour, including its
 * documented fallback paths. The prerelease cases assert semver-correct
 * semantics (repaired in oracle-fixes; was 现状如此，疑似 bug).
 */
describe('isNewerVersion', () => {
  it('equal versions are not newer', () => {
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
  });

  it('compares numerically, not lexically (0.6.13 > 0.6.9)', () => {
    expect(isNewerVersion('0.6.13', '0.6.9')).toBe(true);
    expect(isNewerVersion('0.6.9', '0.6.13')).toBe(false);
  });

  it('crosses major versions', () => {
    expect(isNewerVersion('2.0.0', '1.99.99')).toBe(true);
    expect(isNewerVersion('1.0.0', '2.0.0')).toBe(false);
    expect(isNewerVersion('10.0.0', '9.0.0')).toBe(true);
  });

  it('different segment counts compare as zero-padded', () => {
    // Missing segments parse as 0 → "1.2" and "1.2.0" are numerically equal.
    expect(isNewerVersion('1.2.0', '1.2')).toBe(false);
    expect(isNewerVersion('1.2', '1.2.0')).toBe(false);
    expect(isNewerVersion('1.10', '1.2')).toBe(true);
    expect(isNewerVersion('1.21.1', '1.21')).toBe(true);
  });

  it('release is not newer than its own prerelease', () => {
    // Missing segment ('') vs 'beta' in the string-fallback path:
    // '' > 'beta' is false, so the release is not reported as newer.
    expect(isNewerVersion('1.2.3', '1.2.3-beta')).toBe(false);
  });

  it('prerelease is not newer than the release at an equal numeric core', () => {
    // Fixed regression guard (was 现状如此，疑似 bug): the non-numeric string
    // fallback ranked 'beta' above the zero-padded missing segment (''),
    // so a -beta suffix read as "newer" and a stable install could be
    // updated onto a prerelease.
    expect(isNewerVersion('1.2.3-beta', '1.2.3')).toBe(false);
  });

  it('a higher numeric core still wins over a prerelease (1.2.4-beta > 1.2.3)', () => {
    expect(isNewerVersion('1.2.4-beta', '1.2.3')).toBe(true);
  });

  it('build metadata counts as newer (string fallback)', () => {
    expect(isNewerVersion('1.2.3+build.1', '1.2.3')).toBe(true);
  });

  it('numerically equal but textually different → not newer', () => {
    expect(isNewerVersion('1.0', '1.00')).toBe(false);
  });

  it('wholly unparseable pairs fall back to plain inequality', () => {
    expect(isNewerVersion('a.b', 'a-b')).toBe(true); // documented fallback
    expect(isNewerVersion('abc', 'abd')).toBe(false);
    expect(isNewerVersion('abd', 'abc')).toBe(true);
  });
});
